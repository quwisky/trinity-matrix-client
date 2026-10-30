import { type Observable, firstValueFrom, toArray } from 'rxjs';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  NOT_SIGNED_IN,
  assertPlainData,
  type EngineFailure,
  type EngineResult,
} from '@trinity/util/matrix';
import type { AuthEngine } from '../lib/auth-engine';
import type { AuthMetadata } from '../lib/auth-metadata';

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
  /** Confirms the newest registration link mailed to `email` for `clientSecret`; needs mail delivery. */
  confirmRegistrationLink?(email: string, clientSecret: string): Promise<void>;
}

const NOBODY = '@nobody:invalid';
const DISPLAY_NAME = 'Trinity contract';
const GRANT_METADATA: AuthMetadata = {
  issuer: 'https://auth.invalid/',
  authorization_endpoint: 'https://auth.invalid/authorize',
  token_endpoint: 'https://auth.invalid/token',
  revocation_endpoint: 'https://auth.invalid/revoke',
  registration_endpoint: 'https://auth.invalid/register',
  device_authorization_endpoint: 'https://auth.invalid/device',
  grant_types_supported: ['urn:ietf:params:oauth:grant-type:device_code'],
};

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

    it('names the user and device an access token was issued for', async () => {
      const session = await signIn(context.user, context.user.password);
      if (!session.ok) throw new Error('the user did not sign in');

      await expect(
        once(context.engine.whoami(context.baseUrl, session.value.accessToken)),
      ).resolves.toEqual({
        ok: true,
        value: {
          userId: context.user.userId,
          deviceId: session.value.deviceId,
        },
      });
    });

    it('refuses an access token the homeserver does not know', async () => {
      const failure = failureOf(
        await once(context.engine.whoami(context.baseUrl, 'not-a-token')),
      );

      expect(failure).toMatchObject({
        code: 'request-failed',
        diagnostic: { httpStatus: 401, errcode: 'M_UNKNOWN_TOKEN' },
      });
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

    describe('registering an account', () => {
      const fresh = (name: string) =>
        `${name}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const registration = (localpart: string) => ({
        localpart,
        password: `pw-${localpart}`,
        deviceDisplayName: DISPLAY_NAME,
      });

      async function challenge(localpart: string) {
        const failure = failureOf(
          await once(
            context.engine.register(
              context.baseUrl,
              registration(localpart),
              null,
            ),
          ),
        );
        expect(failure.code).toBe('uia-required');
        if (failure.code !== 'uia-required') throw new Error('no challenge');
        const { session, flows } = failure.params.challenge;
        expect(typeof session).toBe('string');
        return { session: session as string, flows };
      }

      it('answers with a challenge, then registers through the dummy stage and signs in', async () => {
        const localpart = fresh('reg-dummy');
        const { session, flows } = await challenge(localpart);
        expect(flows).toContainEqual({ stages: ['m.login.dummy'] });

        const result = await once(
          context.engine.register(context.baseUrl, registration(localpart), {
            type: 'm.login.dummy',
            session,
          }),
        );

        expect(result.ok).toBe(true);
        if (!result.ok) return;
        const server = context.user.userId.slice(
          context.user.userId.indexOf(':') + 1,
        );
        expect(result.value.userId).toBe(`@${localpart}:${server}`);
        expect(result.value.deviceId).toEqual(expect.any(String));
        expect(result.value.accessToken).toEqual(expect.any(String));
        await expect(
          once(
            context.engine.whoami(
              context.baseUrl,
              result.value.accessToken as string,
            ),
          ),
        ).resolves.toEqual({
          ok: true,
          value: {
            userId: result.value.userId,
            deviceId: result.value.deviceId,
          },
        });
      });

      it('refuses an answer for a session it never issued', async () => {
        const failure = failureOf(
          await once(
            context.engine.register(
              context.baseUrl,
              registration(fresh('reg-unknown')),
              { type: 'm.login.dummy', session: 'never-issued' },
            ),
          ),
        );

        expect(failure).toMatchObject({
          code: 'request-failed',
          diagnostic: { httpStatus: 400 },
        });
      });

      it('refuses a username that is taken, with the server text', async () => {
        const failure = failureOf(
          await once(
            context.engine.register(
              context.baseUrl,
              registration(context.user.localpart),
              null,
            ),
          ),
        );

        expect(failure).toMatchObject({
          code: 'request-failed',
          diagnostic: { errcode: 'M_USER_IN_USE' },
          params: { serverMessage: expect.any(String) },
        });
      });

      it.skipIf(!options.mail)(
        'registers through the email stage only once the mailed link is confirmed',
        async () => {
          const confirm = context.confirmRegistrationLink;
          if (!confirm) throw new Error('registration by email needs mail');
          const localpart = fresh('reg-email');
          const email = `${localpart}@example.test`;
          const clientSecret = `contract${crypto.randomUUID().replaceAll('-', '')}`;
          const { session, flows } = await challenge(localpart);
          expect(flows).toContainEqual({ stages: ['m.login.email.identity'] });

          const sent = await once(
            context.engine.requestRegistrationEmailToken(context.baseUrl, {
              email,
              clientSecret,
              sendAttempt: 1,
            }),
          );
          expect(sent.ok).toBe(true);
          if (!sent.ok) return;
          const answer = () =>
            once(
              context.engine.register(
                context.baseUrl,
                registration(localpart),
                {
                  type: 'm.login.email.identity',
                  threepid_creds: {
                    sid: sent.value.sid,
                    client_secret: clientSecret,
                  },
                  session,
                },
              ),
            );

          const early = failureOf(await answer());
          expect(early.code).toBe('uia-required');
          if (early.code !== 'uia-required') return;
          expect(early.params.challenge.completed ?? []).not.toContain(
            'm.login.email.identity',
          );
          await confirm(email, clientSecret);
          const done = await answer();
          expect(done.ok && done.value.userId).toMatch(
            new RegExp(`^@${localpart}:`, 'u'),
          );
        },
      );
    });

    describe('QR sign-in on a server without it', () => {
      async function updates<T>(source: Observable<T>): Promise<T[]> {
        const emitted = await firstValueFrom(source.pipe(toArray()));
        emitted.forEach((update) =>
          expect(() => assertPlainData(update)).not.toThrow(),
        );
        return emitted;
      }

      it('says the server cannot run it', async () => {
        await expect(
          once(context.engine.supportsQrRendezvous(context.baseUrl)),
        ).resolves.toEqual({ ok: true, value: false });
      });

      it('ends showing a code at once, as unsupported', async () => {
        await expect(
          updates(
            context.engine.signInWithQr(context.baseUrl, {
              grantMetadata: GRANT_METADATA,
              clientId: 'contract-client',
            }),
          ),
        ).resolves.toEqual([{ kind: 'failed', reason: 'unsupported' }]);
      });

      it('reads a scanned code that is not a sign-in code as such', async () => {
        await expect(
          updates(
            context.engine.linkDeviceWithQr(
              context.live.userId,
              btoa('not a sign-in code'),
            ),
          ),
        ).resolves.toEqual([
          { kind: 'connecting' },
          { kind: 'not-sign-in-code' },
        ]);
      });

      it('refuses answers for a flow that is not running', async () => {
        const gone = {
          ok: false,
          failure: expect.objectContaining({ code: 'qr-flow-gone' }),
        };

        await expect(
          once(
            context.engine.answerQrSignIn('no-such-flow', {
              kind: 'server-accepted',
            }),
          ),
        ).resolves.toEqual(gone);
        await expect(
          once(
            context.engine.continueQrSignIn(
              'no-such-flow',
              context.live.userId,
            ),
          ),
        ).resolves.toEqual(gone);
        await expect(
          once(
            context.engine.confirmQrLink('no-such-flow', {
              match: true,
              identityHeld: true,
            }),
          ),
        ).resolves.toEqual(gone);
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
