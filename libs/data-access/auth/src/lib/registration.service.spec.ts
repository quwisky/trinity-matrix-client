import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import {
  Subject,
  firstValueFrom,
  lastValueFrom,
  of,
  throwError,
  type Observable,
} from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  engineFail,
  engineOk,
  uiaFallbackUrl,
  type EngineResult,
  type UiaChallenge,
} from '@trinity/util/matrix';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { SESSION_ENGINE } from '@trinity/data-access/matrix-client';
import { HostAuthenticationHandoffService } from '@trinity/runtime/host';
import { FakeAuthEngine } from '../contract/fake-auth-engine';
import type { RegisteredAccount } from './auth-engine';
import { AUTH_ENGINE } from './auth-engine.token';
import { RegistrationService } from './registration.service';

const HS = 'https://hs';
const registered: RegisteredAccount = {
  userId: '@new:hs',
  deviceId: 'DEVICE',
  accessToken: 'access',
  refreshToken: 'refresh',
  expiresInMs: 60_000,
};

/** A UIA 401 as the engine answers it, for one flow of `stages` unless `extra` says more. */
function uia(
  stages: string[],
  extra: Partial<UiaChallenge> = {},
  serverMessage?: string,
): EngineResult<RegisteredAccount> {
  return engineFail({
    kind: 'http',
    code: 'uia-required',
    diagnostic: { kind: 'http', httpStatus: 401 },
    params: {
      challenge: {
        session: 'uia-session',
        flows: [{ stages }],
        completed: [],
        ...extra,
      },
      ...(serverMessage ? { serverMessage } : {}),
    },
  });
}

describe('RegistrationService', () => {
  let service: RegistrationService;
  let accounts: AccountRuntimeService;
  let engine: FakeAuthEngine;

  /** Answer the registration requests in order, each answer once. */
  function script(
    ...answers: (
      | EngineResult<RegisteredAccount>
      | Observable<EngineResult<RegisteredAccount>>
    )[]
  ) {
    const register = vi.spyOn(engine, 'register');
    for (const answer of answers) {
      register.mockReturnValueOnce('ok' in answer ? of(answer) : answer);
    }
    return register;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new FakeAuthEngine();
    engine.serverName = 'hs';
    TestBed.configureTestingModule({
      providers: [
        RegistrationService,
        { provide: AUTH_ENGINE, useValue: engine },
        {
          provide: SESSION_ENGINE,
          useValue: { logoutSession: vi.fn(() => of(engineOk(null))) },
        },
        MockProvider(AccountRuntimeService, {
          establishAuthenticatedAccount: vi.fn(() =>
            of({
              kind: 'ready' as const,
              accountId: '@new:hs',
              placement: 'active' as const,
            }),
          ),
        }),
      ],
    });
    service = TestBed.inject(RegistrationService);
    accounts = TestBed.inject(AccountRuntimeService);
  });

  describe('registration availability', () => {
    it('uses the side-effect-free username endpoint and reports an open server', async () => {
      const available = vi.spyOn(engine, 'usernameAvailable');
      const register = vi.spyOn(engine, 'register');

      await expect(firstValueFrom(service.getAvailability(HS))).resolves.toBe(
        'open',
      );

      expect(available).toHaveBeenCalledWith(
        HS,
        expect.stringMatching(/^trinity[0-9a-f]{12}$/),
      );
      expect(register).not.toHaveBeenCalled();
    });

    it('distinguishes a closed server from an unavailable probe', async () => {
      engine.registrationOpen = false;
      await expect(
        firstValueFrom(service.getAvailability('https://closed')),
      ).resolves.toBe('closed');

      engine.failure = {
        kind: 'network',
        code: 'request-failed',
        diagnostic: { kind: 'network' },
      };
      await expect(
        firstValueFrom(service.getAvailability('https://offline')),
      ).resolves.toBe('unknown');

      vi.spyOn(engine, 'usernameAvailable').mockReturnValue(
        throwError(() => new Error('engine fault')),
      );
      await expect(
        firstValueFrom(service.getAvailability('https://fault')),
      ).resolves.toBe('unknown');
    });
  });

  it('completes a dummy stage on its own and establishes the session', async () => {
    const register = vi.spyOn(engine, 'register');

    await firstValueFrom(
      service.begin(HS, '@New:hs', 'password', 'hs', 'replace'),
    );

    expect(register).toHaveBeenNthCalledWith(
      1,
      HS,
      { localpart: 'New', password: 'password', deviceDisplayName: 'Trinity' },
      null,
    );
    expect(register).toHaveBeenNthCalledWith(
      2,
      HS,
      expect.objectContaining({ localpart: 'New' }),
      { type: 'm.login.dummy', session: 'registration-1' },
    );
    expect(engine.users.get('New')).toEqual({ password: 'password' });
    expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledWith(
      expect.anything(),
      {
        placement: 'active',
        liveAccounts: 'replace',
        accountRecord: 'new',
      },
    );
  });

  it('chooses an in-app token flow over a shorter hosted fallback flow', async () => {
    const flows = [
      { stages: ['m.login.recaptcha'] },
      { stages: ['m.login.registration_token', 'm.login.dummy'] },
    ];
    const register = script(
      uia([], { flows }),
      uia([], { flows, completed: ['m.login.registration_token'] }),
      engineOk(registered),
    );

    const completion = firstValueFrom(
      service.begin(HS, 'new', 'password', 'hs'),
    );
    await vi.waitFor(() =>
      expect(service.stage().kind).toBe('registration-token'),
    );
    await firstValueFrom(service.submitRegistrationToken('token'));
    await completion;

    expect(register.mock.calls.map(([, , auth]) => auth)).toEqual([
      null,
      {
        type: 'm.login.registration_token',
        token: 'token',
        session: 'uia-session',
      },
      { type: 'm.login.dummy', session: 'uia-session' },
    ]);
  });

  it.each([
    'm.login.registration_token',
    'org.matrix.msc3231.login.registration_token',
  ])('submits the %s stage type returned by the server', async (authType) => {
    const register = script(uia([authType]), engineOk(registered));

    const completion = firstValueFrom(
      service.begin(HS, 'new', 'password', 'hs'),
    );
    await vi.waitFor(() =>
      expect(service.stage().kind).toBe('registration-token'),
    );

    await firstValueFrom(service.submitRegistrationToken(' invite-token '));
    await completion;
    expect(register).toHaveBeenLastCalledWith(HS, expect.anything(), {
      type: authType,
      token: 'invite-token',
      session: 'uia-session',
    });
  });

  it("shows the server's text on a refused stage and keeps the stage", async () => {
    script(
      uia(['m.login.registration_token']),
      uia(['m.login.registration_token'], {}, 'Invalid registration token'),
    );

    service.begin(HS, 'new', 'password', 'hs').subscribe();
    await vi.waitFor(() =>
      expect(service.stage().kind).toBe('registration-token'),
    );
    await firstValueFrom(service.submitRegistrationToken('wrong'));

    expect(service.stage()).toEqual({
      kind: 'registration-token',
      authType: 'm.login.registration_token',
      message: 'Invalid registration token',
    });
    expect(service.error()).toBeNull();
    expect(service.busy()).toBe(false);
  });

  it('is busy while a stage answer is out, and refuses another meanwhile', async () => {
    const answer = new Subject<EngineResult<RegisteredAccount>>();
    const register = script(uia(['m.login.registration_token']), answer);

    service.begin(HS, 'new', 'password', 'hs').subscribe();
    await vi.waitFor(() =>
      expect(service.stage().kind).toBe('registration-token'),
    );
    service.submitRegistrationToken('token').subscribe();
    await vi.waitFor(() => expect(service.busy()).toBe(true));
    service.submitRegistrationToken('again').subscribe();

    answer.next(uia(['m.login.registration_token'], {}, 'Try again'));
    await vi.waitFor(() => expect(service.busy()).toBe(false));
    expect(register).toHaveBeenCalledTimes(2);
  });

  it('keeps the progress of a 401 that omits params and moves from terms to hosted captcha fallback', async () => {
    script(
      uia(['m.login.terms', 'm.login.recaptcha'], {
        params: {
          'm.login.terms': {
            policies: {
              privacy: {
                version: '1.0',
                en: { name: 'Privacy policy', url: 'https://hs/privacy' },
              },
            },
          },
        },
      }),
      // Later responses may omit params, but retain flow progress and the session.
      uia(['m.login.terms', 'm.login.recaptcha'], {
        completed: ['m.login.terms'],
      }),
      engineOk(registered),
    );

    const completion = firstValueFrom(
      service.begin(HS, 'new', 'password', 'hs'),
    );
    await vi.waitFor(() => expect(service.stage().kind).toBe('terms'));

    await firstValueFrom(service.acceptTerms());
    await vi.waitFor(() => expect(service.stage().kind).toBe('fallback'));
    expect(service.stage()).toEqual({
      kind: 'fallback',
      authType: 'm.login.recaptcha',
      url: uiaFallbackUrl(HS, 'm.login.recaptcha', 'uia-session'),
    });

    await firstValueFrom(service.poll());
    await completion;
  });

  it('continues the last challenge when a 401 names no flows, progress or session', async () => {
    const register = script(
      uia(['m.login.recaptcha']),
      engineFail({
        kind: 'http',
        code: 'uia-required',
        diagnostic: { kind: 'http', httpStatus: 401 },
        params: {
          challenge: { flows: [], completed: [] },
          serverMessage: 'Captcha not done yet',
        },
      }),
      engineOk(registered),
    );

    const completion = firstValueFrom(
      service.begin(HS, 'new', 'password', 'hs'),
    );
    await vi.waitFor(() => expect(service.stage().kind).toBe('fallback'));
    await firstValueFrom(service.poll());
    await vi.waitFor(() =>
      expect(service.stage()).toMatchObject({
        kind: 'fallback',
        message: 'Captcha not done yet',
      }),
    );
    await firstValueFrom(service.poll());
    await completion;

    expect(register).toHaveBeenLastCalledWith(HS, expect.anything(), {
      session: 'uia-session',
    });
  });

  it('fails a fallback stage that comes without a UIA session', async () => {
    script(
      uia(['m.login.terms', 'm.login.recaptcha'], {
        params: {
          'm.login.terms': {
            policies: {
              privacy: {
                version: '1.0',
                en: { name: 'Privacy policy', url: 'https://hs/privacy' },
              },
            },
          },
        },
      }),
      uia(['m.login.terms', 'm.login.recaptcha'], {
        session: undefined,
        completed: ['m.login.terms'],
      }),
    );

    const done = lastValueFrom(service.begin(HS, 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });
    await vi.waitFor(() => expect(service.stage().kind).toBe('terms'));
    await firstValueFrom(service.acceptTerms());
    await done;

    expect(service.stage().kind).toBe('credentials');
    expect(service.error()).toMatch(/without a UIA session/i);
  });

  it('falls back for the whole terms stage when any required policy is malformed', async () => {
    vi.spyOn(engine, 'register').mockReturnValue(
      of(
        uia(['m.login.terms'], {
          params: {
            'm.login.terms': {
              policies: {
                privacy: {
                  version: '1.0',
                  en: { name: 'Privacy policy', url: 'https://hs/privacy' },
                },
                unsafe: {
                  version: '1.0',
                  en: { name: 'Unsafe policy', url: 'javascript:alert(1)' },
                },
              },
            },
          },
        }),
      ),
    );

    const subscription = service.begin(HS, 'new', 'password', 'hs').subscribe();
    await vi.waitFor(() => expect(service.stage().kind).toBe('fallback'));

    expect(service.stage()).toEqual({
      kind: 'fallback',
      authType: 'm.login.terms',
      url: uiaFallbackUrl(HS, 'm.login.terms', 'uia-session'),
    });
    subscription.unsubscribe();
  });

  describe('the email stage', () => {
    const emailFlow = () => uia(['m.login.email.identity']);

    it('collects email only when the chosen flow requires it, then polls its sid', async () => {
      const requestToken = vi.spyOn(engine, 'requestRegistrationEmailToken');
      const register = script(emailFlow(), engineOk(registered));

      const completion = firstValueFrom(
        service.begin(HS, 'new', 'password', 'hs'),
      );
      await vi.waitFor(() =>
        expect(service.stage().kind).toBe('email-address'),
      );

      service.provideEmail(' new@example.org ');
      await vi.waitFor(() =>
        expect(service.stage()).toEqual({
          kind: 'email-verification',
          sent: true,
        }),
      );
      expect(requestToken).toHaveBeenCalledWith(HS, {
        email: 'new@example.org',
        clientSecret: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/u),
        sendAttempt: 1,
      });
      const { clientSecret } = requestToken.mock.calls[0][1];

      await firstValueFrom(service.poll());
      await completion;
      expect(register).toHaveBeenLastCalledWith(HS, expect.anything(), {
        type: 'm.login.email.identity',
        session: 'uia-session',
        threepid_creds: {
          sid: 'registration-sid-1',
          client_secret: clientSecret,
        },
      });
    });

    it('sends the next attempt with the same secret on resend', async () => {
      const requestToken = vi.spyOn(engine, 'requestRegistrationEmailToken');
      script(emailFlow());

      service.begin(HS, 'new', 'password', 'hs').subscribe();
      await vi.waitFor(() =>
        expect(service.stage().kind).toBe('email-address'),
      );
      service.provideEmail('new@example.org');
      await vi.waitFor(() =>
        expect(service.stage().kind).toBe('email-verification'),
      );

      await firstValueFrom(service.resendEmail());

      expect(requestToken.mock.calls.map(([, request]) => request)).toEqual([
        expect.objectContaining({ sendAttempt: 1 }),
        expect.objectContaining({
          sendAttempt: 2,
          clientSecret: requestToken.mock.calls[0][1].clientSecret,
        }),
      ]);
      expect(service.stage()).toEqual({
        kind: 'email-verification',
        sent: true,
      });
    });

    it("returns to the credentials with the server's text when the address is refused", async () => {
      engine.users.set('someone', {
        password: 'x',
        email: 'taken@example.org',
      });
      script(emailFlow());

      const done = lastValueFrom(service.begin(HS, 'new', 'password', 'hs'), {
        defaultValue: undefined,
      });
      await vi.waitFor(() =>
        expect(service.stage().kind).toBe('email-address'),
      );
      service.provideEmail('taken@example.org');
      await done;

      expect(service.stage().kind).toBe('credentials');
      expect(service.error()).toBe('Email is already in use');
    });

    it('leaves the stage as it is when a poll fails, without an error', async () => {
      script(
        emailFlow(),
        engineFail({
          kind: 'network',
          code: 'request-failed',
          diagnostic: { kind: 'network' },
        }),
      );

      service.begin(HS, 'new', 'password', 'hs').subscribe();
      await vi.waitFor(() =>
        expect(service.stage().kind).toBe('email-address'),
      );
      service.provideEmail('new@example.org');
      await vi.waitFor(() =>
        expect(service.stage().kind).toBe('email-verification'),
      );

      await firstValueFrom(service.poll());
      await vi.waitFor(() => expect(engine.register).toHaveBeenCalledTimes(2));

      expect(service.stage()).toEqual({
        kind: 'email-verification',
        sent: true,
      });
      expect(service.error()).toBeNull();
      expect(service.busy()).toBe(false);
    });
  });

  it("returns to the credentials with the server's text for a taken username", async () => {
    engine.users.set('new', { password: 'x' });

    await lastValueFrom(service.begin(HS, 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });

    expect(service.stage().kind).toBe('credentials');
    expect(service.error()).toBe('User ID already taken.');
  });

  it('retries local establishment without posting registration a second time', async () => {
    const register = vi.spyOn(engine, 'register');
    vi.mocked(accounts.establishAuthenticatedAccount)
      .mockReturnValueOnce(throwError(() => new Error('storage failed')))
      .mockReturnValueOnce(
        of({
          kind: 'ready',
          accountId: '@new:hs',
          placement: 'active',
        }),
      );

    await lastValueFrom(service.begin(HS, 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });
    expect(service.stage()).toMatchObject({
      kind: 'session-error',
      userId: '@new:hs',
      retryable: true,
    });
    expect(register).toHaveBeenCalledTimes(2);

    await firstValueFrom(service.retryEstablishment());
    expect(register).toHaveBeenCalledTimes(2);
    expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledTimes(2);
  });

  it('does not retry a registration response that omitted its login tokens', async () => {
    const register = script(
      engineOk({
        userId: '@new:hs',
        deviceId: null,
        accessToken: null,
        refreshToken: null,
        expiresInMs: null,
      }),
    );

    await lastValueFrom(service.begin(HS, 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });

    expect(service.stage()).toEqual({
      kind: 'session-error',
      userId: '@new:hs',
      retryable: false,
    });
    expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledOnce();
  });

  it('rejects a registration response whose MXID does not match the target identity', async () => {
    const register = script(
      engineOk({ ...registered, userId: '@victim:other-server' }),
    );

    await lastValueFrom(service.begin(HS, 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });

    expect(service.stage()).toEqual({
      kind: 'session-error',
      userId: '@victim:other-server',
      retryable: false,
    });
    expect(service.error()).toMatch(/identity.*did not match/i);
    expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
    expect(register).toHaveBeenCalledOnce();
  });

  it('rejects a registration response whose device id is not usable', async () => {
    script(engineOk({ ...registered, deviceId: 'hs:DEVICE' }));

    await lastValueFrom(service.begin(HS, 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });

    expect(service.stage()).toEqual({
      kind: 'session-error',
      userId: '@new:hs',
      retryable: false,
    });
    expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
  });

  it('signs the new session out when storing it without a keychain is declined', async () => {
    script(engineOk(registered));
    vi.mocked(accounts.establishAuthenticatedAccount).mockReturnValue(
      of({
        kind: 'failed',
        failure: 'unprotected-storage-declined',
        accountId: '@new:hs',
        placement: 'active',
      }),
    );

    await lastValueFrom(service.begin(HS, 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });

    expect(TestBed.inject(SESSION_ENGINE).logoutSession).toHaveBeenCalledWith({
      baseUrl: HS,
      userId: '@new:hs',
      deviceId: 'DEVICE',
      accessToken: 'access',
    });
    // The session is gone, so retrying local setup with it cannot work.
    expect(service.stage()).toEqual({
      kind: 'session-error',
      userId: '@new:hs',
      retryable: false,
    });
    expect(service.error()).toMatch(/nothing was stored on this device/i);
    await expect(
      lastValueFrom(service.retryEstablishment(), { defaultValue: 'none' }),
    ).resolves.toBe('none');
  });

  it('refuses to overwrite an account already stored under the returned MXID', async () => {
    const register = script(engineOk(registered));
    vi.mocked(accounts.establishAuthenticatedAccount).mockReturnValue(
      of({
        kind: 'failed',
        failure: 'account-already-stored',
        accountId: '@new:hs',
        placement: 'active',
      }),
    );

    await lastValueFrom(service.begin(HS, 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });

    expect(service.stage()).toEqual({
      kind: 'session-error',
      userId: '@new:hs',
      retryable: false,
    });
    expect(service.error()).toMatch(/refused to replace/i);
    expect(register).toHaveBeenCalledOnce();
  });

  it.each([
    ['no flows', { flows: [] }],
    ['no session', { session: undefined }],
    ['a flow without stages', { flows: [{ stages: [] }] }],
  ])('fails clearly when the UIA challenge has %s', async (_, extra) => {
    script(uia(['m.login.dummy'], extra));

    await lastValueFrom(service.begin(HS, 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });

    expect(service.stage().kind).toBe('credentials');
    expect(service.error()).toMatch(/invalid registration UIA challenge/i);
  });

  it('ignores a registration response that arrives after cancel', async () => {
    const held = new Subject<EngineResult<RegisteredAccount>>();
    const register = script(held);
    const completed = lastValueFrom(
      service.begin(HS, 'new', 'password', 'hs'),
      { defaultValue: undefined },
    );

    service.cancel();
    held.next(engineOk(registered));
    await completed;

    expect(service.stage().kind).toBe('idle');
    expect(service.busy()).toBe(false);
    expect(service.error()).toBeNull();
    expect(register).toHaveBeenCalledOnce();
    expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
  });

  it('names the registered device after the host app', async () => {
    vi.spyOn(
      TestBed.inject(HostAuthenticationHandoffService),
      'deviceDisplayName',
    ).mockReturnValue('Trinity Next');
    engine.registrationOpen = false;
    const register = vi.spyOn(engine, 'register');

    service
      .begin(HS, 'alice', 'not-a-real-password', 'hs')
      .subscribe({ error: () => undefined });

    await vi.waitFor(() =>
      expect(register).toHaveBeenCalledWith(
        HS,
        expect.objectContaining({ deviceDisplayName: 'Trinity Next' }),
        null,
      ),
    );
    await vi.waitFor(() =>
      expect(service.error()).toBe(
        'The homeserver rejected this registration step.',
      ),
    );
  });

  it('shows an error instead of registering when the host cannot name the device', () => {
    vi.spyOn(
      TestBed.inject(HostAuthenticationHandoffService),
      'deviceDisplayName',
    ).mockImplementation(() => {
      throw new Error('The desktop shell did not report its app identity.');
    });
    const register = vi.spyOn(engine, 'register');
    const error = vi.fn();
    const complete = vi.fn();

    service
      .begin(HS, 'alice', 'not-a-real-password', 'hs')
      .subscribe({ error, complete });

    expect(error).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledOnce();
    expect(service.error()).toBe(
      'The desktop shell did not report its app identity.',
    );
    expect(service.stage().kind).toBe('credentials');
    expect(service.busy()).toBe(false);
    expect(register).not.toHaveBeenCalled();
  });
});
