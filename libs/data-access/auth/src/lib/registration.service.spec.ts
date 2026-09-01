import { TestBed } from '@angular/core/testing';
import { MatrixError, createClient } from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, lastValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RegistrationService } from './registration.service';
import { AccountRuntimeService } from '@trinity/data-access/accounts';

vi.mock('matrix-js-sdk', async (importActual) => {
  const actual = await importActual<typeof import('matrix-js-sdk')>();
  return { ...actual, createClient: vi.fn() };
});

const createClientMock = vi.mocked(createClient);
const registered = {
  user_id: '@new:hs',
  device_id: 'DEVICE',
  access_token: 'access',
  refresh_token: 'refresh',
  expires_in_ms: 60_000,
};

function uia(
  stages: string[],
  extra: Record<string, unknown> = {},
): MatrixError {
  return new MatrixError(
    {
      session: 'uia-session',
      flows: [{ stages }],
      ...extra,
    },
    401,
  );
}

function client(overrides: Record<string, unknown> = {}) {
  return {
    isUsernameAvailable: vi.fn().mockResolvedValue(true),
    registerRequest: vi.fn(),
    requestRegisterEmailToken: vi.fn().mockResolvedValue({ sid: 'email-sid' }),
    generateClientSecret: vi.fn(() => 'client-secret'),
    getIdentityServerUrl: vi.fn(() => undefined),
    getFallbackAuthUrl: vi.fn(
      (stage: string, session: string) =>
        `https://hs/_matrix/client/v3/auth/${stage}/fallback/web?session=${session}`,
    ),
    ...overrides,
  };
}

describe('RegistrationService', () => {
  let service: RegistrationService;
  let accounts: AccountRuntimeService;
  let interactiveAuthLog: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    interactiveAuthLog = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => {});
    TestBed.configureTestingModule({
      providers: [
        RegistrationService,
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

  afterEach(() => {
    const calls = [...interactiveAuthLog.mock.calls];
    interactiveAuthLog.mockRestore();
    for (const args of calls) {
      expect(args).toHaveLength(2);
      if (args[0] === 'Active flow => %s') {
        expect(args[1]).toMatch(/^\{"stages":\[.*\]\}$/u);
      } else {
        expect(args[0]).toBe('Next stage: %s');
        expect(args[1]).toMatch(/^\S+$/u);
      }
    }
  });

  describe('registration availability', () => {
    it('uses the side-effect-free username endpoint and reports an open server', async () => {
      const matrixClient = client();
      createClientMock.mockReturnValue(matrixClient as never);

      await expect(
        firstValueFrom(service.getAvailability('https://hs')),
      ).resolves.toBe('open');

      expect(matrixClient.isUsernameAvailable).toHaveBeenCalledWith(
        expect.stringMatching(/^trinity[0-9a-f]{12}$/),
      );
      expect(matrixClient.registerRequest).not.toHaveBeenCalled();
    });

    it('distinguishes a closed server from an unavailable probe', async () => {
      const forbidden = client({
        isUsernameAvailable: vi
          .fn()
          .mockRejectedValue(new MatrixError({ errcode: 'M_FORBIDDEN' }, 403)),
      });
      createClientMock.mockReturnValue(forbidden as never);
      await expect(
        firstValueFrom(service.getAvailability('https://closed')),
      ).resolves.toBe('closed');

      const offline = client({
        isUsernameAvailable: vi.fn().mockRejectedValue(new Error('offline')),
      });
      createClientMock.mockReturnValue(offline as never);
      await expect(
        firstValueFrom(service.getAvailability('https://offline')),
      ).resolves.toBe('unknown');
    });
  });

  it('lets InteractiveAuth complete a dummy stage and establishes the session', async () => {
    const registerRequest = vi
      .fn()
      .mockRejectedValueOnce(uia(['m.login.dummy']))
      .mockResolvedValueOnce(registered);
    createClientMock.mockReturnValue(client({ registerRequest }) as never);

    await firstValueFrom(
      service.begin('https://hs', '@New:hs', 'password', 'hs', 'replace'),
    );

    expect(registerRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        username: 'New',
        password: 'password',
        auth: { type: 'm.login.dummy', session: 'uia-session' },
      }),
    );
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
    const chosenFlows = [
      { stages: ['m.login.recaptcha'] },
      { stages: ['m.login.registration_token', 'm.login.dummy'] },
    ];
    const registerRequest = vi
      .fn()
      .mockRejectedValueOnce(
        new MatrixError({ session: 'uia-session', flows: chosenFlows }, 401),
      )
      .mockRejectedValueOnce(
        new MatrixError(
          {
            session: 'uia-session',
            flows: chosenFlows,
            completed: ['m.login.registration_token'],
          },
          401,
        ),
      )
      .mockResolvedValueOnce(registered);
    createClientMock.mockReturnValue(client({ registerRequest }) as never);

    const completion = firstValueFrom(
      service.begin('https://hs', 'new', 'password', 'hs'),
    );
    await vi.waitFor(() =>
      expect(service.stage().kind).toBe('registration-token'),
    );
    await firstValueFrom(service.submitRegistrationToken('token'));
    await completion;
  });

  it.each([
    'm.login.registration_token',
    'org.matrix.msc3231.login.registration_token',
  ])('submits the %s stage type returned by the server', async (authType) => {
    const registerRequest = vi
      .fn()
      .mockRejectedValueOnce(uia([authType]))
      .mockResolvedValueOnce(registered);
    createClientMock.mockReturnValue(client({ registerRequest }) as never);

    const completion = firstValueFrom(
      service.begin('https://hs', 'new', 'password', 'hs'),
    );
    await vi.waitFor(() =>
      expect(service.stage().kind).toBe('registration-token'),
    );

    await firstValueFrom(service.submitRegistrationToken(' invite-token '));
    await completion;
    expect(registerRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        auth: {
          type: authType,
          token: 'invite-token',
          session: 'uia-session',
        },
      }),
    );
  });

  it('repairs a partial 401 and moves from terms to hosted captcha fallback', async () => {
    const registerRequest = vi
      .fn()
      .mockRejectedValueOnce(
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
      )
      // Later responses may omit params, but retain flow progress and the session.
      .mockRejectedValueOnce(
        new MatrixError(
          {
            session: 'uia-session',
            flows: [{ stages: ['m.login.terms', 'm.login.recaptcha'] }],
            completed: ['m.login.terms'],
          },
          401,
        ),
      )
      .mockResolvedValueOnce(registered);
    const matrixClient = client({ registerRequest });
    createClientMock.mockReturnValue(matrixClient as never);

    const completion = firstValueFrom(
      service.begin('https://hs', 'new', 'password', 'hs'),
    );
    await vi.waitFor(() => expect(service.stage().kind).toBe('terms'));

    await firstValueFrom(service.acceptTerms());
    await vi.waitFor(() => expect(service.stage().kind).toBe('fallback'));
    expect(service.stage()).toMatchObject({
      kind: 'fallback',
      authType: 'm.login.recaptcha',
    });
    expect(matrixClient.getFallbackAuthUrl).toHaveBeenCalledWith(
      'm.login.recaptcha',
      'uia-session',
    );

    await firstValueFrom(service.poll());
    await completion;
  });

  it('falls back for the whole terms stage when any required policy is malformed', async () => {
    const registerRequest = vi.fn().mockRejectedValue(
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
    );
    const matrixClient = client({ registerRequest });
    createClientMock.mockReturnValue(matrixClient as never);

    const subscription = service
      .begin('https://hs', 'new', 'password', 'hs')
      .subscribe();
    await vi.waitFor(() => expect(service.stage().kind).toBe('fallback'));

    expect(service.stage()).toMatchObject({
      kind: 'fallback',
      authType: 'm.login.terms',
    });
    expect(matrixClient.getFallbackAuthUrl).toHaveBeenCalledWith(
      'm.login.terms',
      'uia-session',
    );
    subscription.unsubscribe();
  });

  it('collects email only when the chosen flow requires it, then polls its sid', async () => {
    const registerRequest = vi
      .fn()
      .mockRejectedValueOnce(uia(['m.login.email.identity']))
      .mockResolvedValueOnce(registered);
    const matrixClient = client({ registerRequest });
    createClientMock.mockReturnValue(matrixClient as never);

    const completion = firstValueFrom(
      service.begin('https://hs', 'new', 'password', 'hs'),
    );
    await vi.waitFor(() => expect(service.stage().kind).toBe('email-address'));

    service.provideEmail('new@example.org');
    await vi.waitFor(() =>
      expect(service.stage().kind).toBe('email-verification'),
    );
    expect(matrixClient.requestRegisterEmailToken).toHaveBeenCalledWith(
      'new@example.org',
      'client-secret',
      1,
    );

    await firstValueFrom(service.poll());
    await completion;
    expect(registerRequest).toHaveBeenLastCalledWith(
      expect.objectContaining({
        auth: {
          type: 'm.login.email.identity',
          session: 'uia-session',
          threepid_creds: {
            sid: 'email-sid',
            client_secret: 'client-secret',
          },
        },
      }),
    );
  });

  it('retries local establishment without posting registration a second time', async () => {
    const registerRequest = vi
      .fn()
      .mockRejectedValueOnce(uia(['m.login.dummy']))
      .mockResolvedValueOnce(registered);
    createClientMock.mockReturnValue(client({ registerRequest }) as never);
    vi.mocked(accounts.establishAuthenticatedAccount)
      .mockReturnValueOnce(throwError(() => new Error('storage failed')))
      .mockReturnValueOnce(
        of({
          kind: 'ready',
          accountId: '@new:hs',
          placement: 'active',
        }),
      );

    await lastValueFrom(service.begin('https://hs', 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });
    expect(service.stage()).toMatchObject({
      kind: 'session-error',
      userId: '@new:hs',
      retryable: true,
    });
    expect(registerRequest).toHaveBeenCalledTimes(2);

    await firstValueFrom(service.retryEstablishment());
    expect(registerRequest).toHaveBeenCalledTimes(2);
    expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledTimes(2);
  });

  it('does not retry a registration response that omitted its login tokens', async () => {
    const registerRequest = vi.fn().mockResolvedValue({ user_id: '@new:hs' });
    createClientMock.mockReturnValue(client({ registerRequest }) as never);

    await lastValueFrom(service.begin('https://hs', 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });

    expect(service.stage()).toEqual({
      kind: 'session-error',
      userId: '@new:hs',
      retryable: false,
    });
    expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
    expect(registerRequest).toHaveBeenCalledOnce();
  });

  it('rejects a registration response whose MXID does not match the target identity', async () => {
    const registerRequest = vi.fn().mockResolvedValue({
      ...registered,
      user_id: '@victim:other-server',
    });
    createClientMock.mockReturnValue(client({ registerRequest }) as never);

    await lastValueFrom(service.begin('https://hs', 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });

    expect(service.stage()).toEqual({
      kind: 'session-error',
      userId: '@victim:other-server',
      retryable: false,
    });
    expect(service.error()).toMatch(/identity.*did not match/i);
    expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
    expect(registerRequest).toHaveBeenCalledOnce();
  });

  it('refuses to overwrite an account already stored under the returned MXID', async () => {
    const registerRequest = vi.fn().mockResolvedValue(registered);
    createClientMock.mockReturnValue(client({ registerRequest }) as never);
    vi.mocked(accounts.establishAuthenticatedAccount).mockReturnValue(
      of({
        kind: 'failed',
        failure: 'account-already-stored',
        accountId: '@new:hs',
        placement: 'active',
      }),
    );

    await lastValueFrom(service.begin('https://hs', 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });

    expect(service.stage()).toEqual({
      kind: 'session-error',
      userId: '@new:hs',
      retryable: false,
    });
    expect(service.error()).toMatch(/refused to replace/i);
    expect(registerRequest).toHaveBeenCalledOnce();
  });

  it('fails clearly when the UIA response is malformed', async () => {
    const registerRequest = vi
      .fn()
      .mockRejectedValue(new MatrixError({ flows: [] }, 401));
    createClientMock.mockReturnValue(client({ registerRequest }) as never);

    await lastValueFrom(service.begin('https://hs', 'new', 'password', 'hs'), {
      defaultValue: undefined,
    });

    expect(service.stage().kind).toBe('credentials');
    expect(service.error()).toMatch(/invalid registration UIA challenge/i);
  });
});
