import { type Observable, firstValueFrom, toArray } from 'rxjs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  NOT_SIGNED_IN,
  assertPlainData,
  type EngineFailure,
  type EngineResult,
} from '@trinity/util/matrix';
import type { AuthEngine } from '../lib/auth-engine';

export interface AuthContractAccount {
  readonly localpart: string;
  readonly userId: string;
  readonly password: string;
}

export interface AuthContractSetup {
  engine: AuthEngine;
  baseUrl: string;
  /** An account the contract signs in to; its password never changes. */
  user: AuthContractAccount;
  /** A live account (its user id is the account id) whose password the contract changes. */
  live: AuthContractAccount;
  /** An account with a confirmed email address; needs mail delivery. */
  reset?: AuthContractAccount & {
    readonly email: string;
    /** Confirms the newest reset link mailed for `clientSecret`, as the person would. */
    confirmLink(clientSecret: string): Promise<void>;
  };
  /** Whether the homeserver still accepts `accessToken` (whoami succeeds). */
  sessionAlive(accessToken: string): Promise<boolean>;
}

const NOBODY = '@nobody:invalid';
const DISPLAY_NAME = 'Trinity contract';

export function defineAuthEngineContract(
  setup: () => Promise<AuthContractSetup>,
  options: { readonly mail: boolean },
): void {
  describe('AuthEngine contract', () => {
    let context: AuthContractSetup;
    beforeAll(async () => {
      context = await setup();
    }, 120_000);

    /** Asserts the command emits exactly once with plain data, and returns that value. */
    async function once<T>(source: Observable<T>): Promise<T> {
      const emitted = await firstValueFrom(source.pipe(toArray()));
      expect(emitted).toHaveLength(1);
      expect(() => assertPlainData(emitted[0])).not.toThrow();
      return emitted[0];
    }

    function failureOf<T>(result: EngineResult<T>): EngineFailure {
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('expected a failure');
      expect(result.failure).not.toHaveProperty('message');
      return result.failure;
    }

    function signIn(account: AuthContractAccount, password: string) {
      return once(
        context.engine.loginWithPassword(context.baseUrl, {
          localpart: account.localpart,
          password,
          deviceDisplayName: DISPLAY_NAME,
          deviceId: null,
        }),
      );
    }

    it('lists the password login flow', async () => {
      const result = await once(context.engine.loginFlows(context.baseUrl));

      expect(result.ok && result.value).toContain('m.login.password');
    });

    it('answers no auth metadata for a server without OAuth 2.0', async () => {
      await expect(
        once(context.engine.authMetadata(context.baseUrl)),
      ).resolves.toEqual({ ok: true, value: null });
    });

    it('says a taken username is not available and a fresh one is', async () => {
      const fresh = `fresh-${Date.now().toString(36)}`;

      await expect(
        once(
          context.engine.usernameAvailable(
            context.baseUrl,
            context.user.localpart,
          ),
        ),
      ).resolves.toEqual({ ok: true, value: false });
      await expect(
        once(context.engine.usernameAvailable(context.baseUrl, fresh)),
      ).resolves.toEqual({ ok: true, value: true });
    });

    it('builds the SSO redirect on the homeserver, carrying the callback', async () => {
      const callback = 'https://app.example/sso-callback?sso_state=a&b=c';

      const result = await once(
        context.engine.ssoLoginUrl(context.baseUrl, callback),
      );

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const url = new URL(result.value);
      expect(`${url.origin}${url.pathname}`).toBe(
        `${context.baseUrl}/_matrix/client/v3/login/sso/redirect`,
      );
      expect(url.searchParams.get('redirectUrl')).toBe(callback);
    });

    it('signs in by password on a new device, then again on that device', async () => {
      const { user } = context;

      const first = await signIn(user, user.password);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value).toMatchObject({
        userId: user.userId,
        refreshToken: null,
      });
      expect(first.value.deviceId).not.toBe('');
      expect(first.value.accessToken).not.toBe('');

      const again = await once(
        context.engine.loginWithPassword(context.baseUrl, {
          localpart: user.localpart,
          password: user.password,
          deviceDisplayName: DISPLAY_NAME,
          deviceId: first.value.deviceId,
        }),
      );
      expect(again.ok && again.value.deviceId).toBe(first.value.deviceId);
    });

    it('refuses a wrong password as invalid credentials', async () => {
      const failure = failureOf(await signIn(context.user, 'not-the-password'));

      expect(failure).toMatchObject({
        code: 'login-refused',
        params: { reason: 'invalid-credentials' },
      });
    });

    it('refuses an unknown login token as invalid', async () => {
      const failure = failureOf(
        await once(
          context.engine.loginWithToken(context.baseUrl, {
            token: 'not-a-login-token',
            deviceDisplayName: DISPLAY_NAME,
            deviceId: null,
          }),
        ),
      );

      expect(failure).toMatchObject({
        code: 'login-refused',
        params: { reason: 'invalid-token' },
      });
    });

    it('fails not-signed-in to change the password of an account with no session', async () => {
      await expect(
        once(context.engine.changePassword(NOBODY, 'whatever-1', null)),
      ).resolves.toEqual({ ok: false, failure: NOT_SIGNED_IN });
    });

    describe('changing the password', () => {
      const newPassword = `changed-${Date.now().toString(36)}`;

      async function challenge(): Promise<string> {
        const failure = failureOf(
          await once(
            context.engine.changePassword(
              context.live.userId,
              newPassword,
              null,
            ),
          ),
        );
        expect(failure.code).toBe('uia-required');
        if (failure.code !== 'uia-required') throw new Error('no challenge');
        const { session, flows } = failure.params.challenge;
        expect(flows.some((f) => f.stages.includes('m.login.password'))).toBe(
          true,
        );
        expect(typeof session).toBe('string');
        return session as string;
      }

      function answer(session: string, password: string) {
        return once(
          context.engine.changePassword(context.live.userId, newPassword, {
            type: 'm.login.password',
            identifier: { type: 'm.id.user', user: context.live.userId },
            password,
            session,
          }),
        );
      }

      it('answers a wrong current password with another challenge', async () => {
        const failure = failureOf(
          await answer(await challenge(), 'not-the-password'),
        );

        expect(failure.code).toBe('uia-required');
      });

      it('asks for the current password, then changes it, keeping other sessions', async () => {
        const { live } = context;
        const other = await signIn(live, live.password);
        if (!other.ok) throw new Error('the second session did not sign in');

        await expect(answer(await challenge(), live.password)).resolves.toEqual(
          { ok: true, value: null },
        );

        await expect(
          context.sessionAlive(other.value.accessToken),
        ).resolves.toBe(true);
        expect((await signIn(live, newPassword)).ok).toBe(true);
        expect(failureOf(await signIn(live, live.password)).code).toBe(
          'login-refused',
        );
      });
    });

    describe('resetting a forgotten password', () => {
      const secret = () => `contract${crypto.randomUUID().replaceAll('-', '')}`;

      it.skipIf(!options.mail)(
        'refuses to mail a link to an address no account has',
        async () => {
          const failure = failureOf(
            await once(
              context.engine.requestPasswordResetToken(context.baseUrl, {
                email: `nobody-${Date.now().toString(36)}@example.test`,
                clientSecret: secret(),
                sendAttempt: 1,
              }),
            ),
          );

          expect(failure).toMatchObject({
            code: 'request-failed',
            diagnostic: { errcode: 'M_THREEPID_NOT_FOUND' },
          });
        },
      );

      it.skipIf(!options.mail)(
        'resets the password only once the mailed link is confirmed',
        async () => {
          const account = context.reset;
          if (!account) throw new Error('the reset account needs mail');
          const clientSecret = secret();
          const newPassword = `reset-${Date.now().toString(36)}`;

          const sent = await once(
            context.engine.requestPasswordResetToken(context.baseUrl, {
              email: account.email,
              clientSecret,
              sendAttempt: 1,
            }),
          );
          expect(sent.ok).toBe(true);
          if (!sent.ok) return;
          const reset = () =>
            once(
              context.engine.resetPassword(context.baseUrl, {
                sid: sent.value.sid,
                clientSecret,
                newPassword,
                logoutDevices: false,
              }),
            );

          expect(failureOf(await reset()).code).toBe('uia-required');
          await account.confirmLink(clientSecret);
          await expect(reset()).resolves.toEqual({ ok: true, value: null });

          expect((await signIn(account, newPassword)).ok).toBe(true);
        },
      );
    });
  });
}
