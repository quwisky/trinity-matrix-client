import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { NEVER, firstValueFrom, of, throwError } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the SDK client constructor while keeping every other real export.
vi.mock('matrix-js-sdk', async (importActual) => {
  const actual = await importActual<typeof import('matrix-js-sdk')>();
  return {
    ...actual,
    createClient: vi.fn(),
  };
});

import {
  ConnectionError,
  HTTPError,
  MatrixError,
  createClient,
  type MatrixClient,
} from 'matrix-js-sdk';
import {
  AccountRuntimeService,
  AuthenticatedAccountGrant,
  UnprotectedStorageGate,
  type AccountEstablishmentOutcome,
} from '@trinity/data-access/accounts';
import { HostAuthenticationHandoffService } from '@trinity/runtime/host';
import { AUTH_METADATA } from './auth-metadata.fixture';
import { AuthService } from './auth.service';
import { qrSignInFailureOf } from './qr-sign-in/qr-sign-in.model';
import { deletionLink } from './account-server-api';
import {
  ReauthAccountMismatchError,
  UnacceptableAccountError,
} from './account-establishment';
import { AUTHENTICATION_HOMESERVER_DISCOVERY } from './homeserver-discovery.port';
import {
  NEW_DEVICE_SIGN_IN,
  NewDeviceSignInCancelledError,
  UnprotectedStorageDeclinedError,
} from './new-device-sign-in.port';
import {
  OidcClientService,
  type OidcGrantContext,
} from './oidc-client.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';
const createClientMock = vi.mocked(createClient);

/** A user-interactive-auth 401 offering the password stage for `session`. */
function uia(session: string): MatrixError {
  return new MatrixError(
    { flows: [{ stages: ['m.login.password'] }], session },
    401,
  );
}

describe('AuthService', () => {
  let auth: AuthService;
  beforeEach(() => {
    vi.clearAllMocks();
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        MockProvider(AccountRuntimeService, {
          establishAuthenticatedAccount: vi.fn(() =>
            of({
              kind: 'ready' as const,
              accountId: '@me:hs',
              placement: 'active' as const,
            }),
          ),
        }),
        MockProvider(MatrixClientService),
        MockProvider(SessionStorageService),
        MockProvider(OidcClientService),
        {
          provide: AUTHENTICATION_HOMESERVER_DISCOVERY,
          useValue: {
            discover: vi.fn(() => throwError(() => new Error('no well-known'))),
            lookUp: vi.fn(() => throwError(() => new Error('no well-known'))),
          },
        },
        MockProvider(UnprotectedStorageGate, {
          allowed: vi.fn(() => of(true)),
        }),
        // The app composes the real warning; here every sign-in goes ahead unless a test says no.
        {
          provide: NEW_DEVICE_SIGN_IN,
          useValue: { confirm: vi.fn(() => of(true)) },
        },
      ],
    });
    auth = TestBed.inject(AuthService);
    vi.mocked(TestBed.inject(SessionStorageService).load).mockReturnValue(
      of(null),
    );
    // Most sign-ins here are for an account this device does not store yet.
    vi.mocked(TestBed.inject(SessionStorageService).record).mockReturnValue(
      of(null),
    );
  });

  it('cannot be built without a new-device sign-in confirmation', () => {
    // No silent "go ahead" default: a host that forgets the binding must fail loudly
    // rather than replace stored keys without asking.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        AuthService,
        MockProvider(AccountRuntimeService),
        MockProvider(MatrixClientService),
        MockProvider(SessionStorageService),
        MockProvider(OidcClientService),
        {
          provide: AUTHENTICATION_HOMESERVER_DISCOVERY,
          useValue: {
            discover: vi.fn(() => throwError(() => new Error('no well-known'))),
            lookUp: vi.fn(() => throwError(() => new Error('no well-known'))),
          },
        },
      ],
    });

    expect(() => TestBed.inject(AuthService)).toThrow(
      /auth\.new-device-sign-in/,
    );
  });

  it('builds the SSO login URL via the SDK', () => {
    const getSsoLoginUrl = vi.fn(() => 'https://hs/_matrix/sso?redirect=cb');
    createClientMock.mockReturnValue({ getSsoLoginUrl } as never);

    expect(auth.getSsoUrl('https://hs', 'cb')).toBe(
      'https://hs/_matrix/sso?redirect=cb',
    );
    expect(getSsoLoginUrl).toHaveBeenCalledWith('cb', 'sso');
  });

  describe('getDelegatedAuthConfig', () => {
    it('returns the validated OIDC config when the homeserver delegates auth', async () => {
      // The shared fixture, not an ad-hoc partial: getAuthMetadata() only ever resolves
      // metadata that passed the SDK's own isValidAuthMetadata guard.
      const getAuthMetadata = vi.fn().mockResolvedValue(AUTH_METADATA);
      createClientMock.mockReturnValue({ getAuthMetadata } as never);

      expect(
        await firstValueFrom(auth.getDelegatedAuthConfig('https://hs')),
      ).toBe(AUTH_METADATA);
    });

    it('resolves null when the homeserver is not OIDC-native (getAuthMetadata throws)', async () => {
      const getAuthMetadata = vi
        .fn()
        .mockRejectedValue(new Error('no auth metadata'));
      createClientMock.mockReturnValue({ getAuthMetadata } as never);

      expect(
        await firstValueFrom(auth.getDelegatedAuthConfig('https://hs')),
      ).toBeNull();
    });
  });

  describe('getAccountManagement', () => {
    const oidcSession = {
      baseUrl: 'https://hs',
      userId: '@me:hs',
      deviceId: 'DEV',
      accessToken: 'tok',
      oidc: {
        issuer: 'https://op',
        clientId: 'c1',
        redirectUri: 'https://app/cb',
        idTokenClaims: {
          iss: 'https://op',
          sub: 'u',
          aud: 'c1',
          exp: 1,
          iat: 0,
        },
      },
    };

    it('returns the provider account-management surface for an OIDC account', async () => {
      const storage = TestBed.inject(SessionStorageService);
      vi.mocked(storage.load).mockReturnValue(of(oidcSession) as never);
      createClientMock.mockReturnValue({
        getAuthMetadata: vi.fn().mockResolvedValue({
          account_management_uri: 'https://op/account',
          account_management_actions_supported: ['org.matrix.session_end'],
        }),
      } as never);

      expect(await firstValueFrom(auth.getAccountManagement())).toEqual({
        url: 'https://op/account',
        actionsSupported: ['org.matrix.session_end'],
      });
    });

    it('returns the provider surface for a password sign-in on an OAuth server', async () => {
      const storage = TestBed.inject(SessionStorageService);
      vi.mocked(storage.load).mockReturnValue(
        of({ ...oidcSession, oidc: undefined }) as never,
      );
      createClientMock.mockReturnValue({
        getAuthMetadata: vi.fn().mockResolvedValue({
          account_management_uri: 'https://op/account',
        }),
      } as never);

      expect(await firstValueFrom(auth.getAccountManagement())).toEqual({
        url: 'https://op/account',
        actionsSupported: [],
      });
    });

    it('returns null for an account on a server without OAuth metadata', async () => {
      const storage = TestBed.inject(SessionStorageService);
      vi.mocked(storage.load).mockReturnValue(
        of({ ...oidcSession, oidc: undefined }) as never,
      );
      createClientMock.mockReturnValue({
        getAuthMetadata: vi
          .fn()
          .mockRejectedValue(
            new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 404),
          ),
      } as never);

      expect(await firstValueFrom(auth.getAccountManagement())).toBeNull();
    });

    it('rejects a non-https account-management URL (homeserver-controlled metadata)', async () => {
      const storage = TestBed.inject(SessionStorageService);
      vi.mocked(storage.load).mockReturnValue(of(oidcSession) as never);
      createClientMock.mockReturnValue({
        getAuthMetadata: vi.fn().mockResolvedValue({
          account_management_uri: 'http://insecure/account',
        }),
      } as never);

      expect(await firstValueFrom(auth.getAccountManagement())).toBeNull();
    });
  });

  describe('accountManagementFor', () => {
    it("asks the named account's own server", async () => {
      const matrix = TestBed.inject(MatrixClientService);
      vi.mocked(matrix.clientFor).mockReturnValue({
        baseUrl: 'https://alice.hs',
      } as never);
      createClientMock.mockReturnValue({
        getAuthMetadata: vi.fn().mockResolvedValue({
          account_management_uri: 'https://auth.alice.hs/account/',
          account_management_actions_supported: [],
        }),
      } as never);

      await expect(
        firstValueFrom(auth.accountManagementFor('@alice:alice.hs')),
      ).resolves.toEqual({
        kind: 'oauth',
        management: {
          url: 'https://auth.alice.hs/account/',
          actionsSupported: [],
        },
      });
      expect(matrix.clientFor).toHaveBeenCalledWith('@alice:alice.hs');
      expect(createClientMock).toHaveBeenCalledWith({
        baseUrl: 'https://alice.hs',
      });
    });

    it('falls back to the stored record for an account without a live client', async () => {
      const storage = TestBed.inject(SessionStorageService);
      vi.mocked(storage.record).mockReturnValue(
        of({ userId: '@alice:alice.hs', baseUrl: 'https://alice.hs' }) as never,
      );
      createClientMock.mockReturnValue({
        getAuthMetadata: vi
          .fn()
          .mockRejectedValue(
            new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 404),
          ),
      } as never);

      await expect(
        firstValueFrom(auth.accountManagementFor('@alice:alice.hs')),
      ).resolves.toEqual({ kind: 'legacy' });
      expect(createClientMock).toHaveBeenCalledWith({
        baseUrl: 'https://alice.hs',
      });
    });

    it('reports an OAuth server that publishes no account page', async () => {
      const matrix = TestBed.inject(MatrixClientService);
      vi.mocked(matrix.clientFor).mockReturnValue({
        baseUrl: 'https://hs',
      } as never);
      createClientMock.mockReturnValue({
        getAuthMetadata: vi.fn().mockResolvedValue({ issuer: 'https://op/' }),
      } as never);

      await expect(
        firstValueFrom(auth.accountManagementFor('@me:hs')),
      ).resolves.toEqual({ kind: 'oauth', management: null });
    });
    it.each([
      ['a 404 that is not JSON', new HTTPError('Not Found', 404)],
      ['a 405', new MatrixError({}, 405)],
      ['a 403 from a proxy', new HTTPError('Forbidden', 403)],
      ['a 501', new MatrixError({}, 501)],
    ])('reads %s as a server without OAuth', async (_label, error) => {
      const matrix = TestBed.inject(MatrixClientService);
      vi.mocked(matrix.clientFor).mockReturnValue({
        baseUrl: 'https://hs',
      } as never);
      createClientMock.mockReturnValue({
        getAuthMetadata: vi.fn().mockRejectedValue(error),
      } as never);

      await expect(
        firstValueFrom(auth.accountManagementFor('@me:hs')),
      ).resolves.toEqual({ kind: 'legacy' });
    });

    it.each([
      ['no connection', new ConnectionError('fetch failed')],
      ['a timeout', new MatrixError({}, 408)],
      ['rate limiting', new MatrixError({ errcode: 'M_LIMIT_EXCEEDED' }, 429)],
      ['a server error', new MatrixError({ errcode: 'M_UNKNOWN' }, 502)],
      ['metadata that is not valid', new Error('OP does not support')],
    ])('does not guess when it gets %s', async (_label, error) => {
      const matrix = TestBed.inject(MatrixClientService);
      vi.mocked(matrix.clientFor).mockReturnValue({
        baseUrl: 'https://hs',
      } as never);
      createClientMock.mockReturnValue({
        getAuthMetadata: vi.fn().mockRejectedValue(error),
      } as never);

      await expect(
        firstValueFrom(auth.accountManagementFor('@me:hs')),
      ).resolves.toEqual({ kind: 'unknown' });
    });
  });

  describe('deletionLink', () => {
    it('opens the bare account page when the provider does not advertise deletion', () => {
      expect(
        deletionLink({
          url: 'https://auth.hs/account/',
          actionsSupported: ['org.matrix.cross_signing_reset'],
        }),
      ).toBe('https://auth.hs/account/');
    });

    it('deep-links the deletion action only when advertised', () => {
      expect(
        deletionLink({
          url: 'https://auth.hs/account/',
          actionsSupported: ['org.matrix.account_deactivate'],
        }),
      ).toBe('https://auth.hs/account/?action=org.matrix.account_deactivate');
    });
  });

  describe('login modes', () => {
    const loginRes = { user_id: '@me:hs', device_id: 'D', access_token: 'tok' };
    const stubLogin = () =>
      createClientMock.mockReturnValue({
        loginRequest: vi.fn().mockResolvedValue(loginRes),
      } as never);

    it('delegates replace login to Account Runtime', async () => {
      stubLogin();
      const matrix = TestBed.inject(MatrixClientService);
      const accounts = TestBed.inject(AccountRuntimeService);

      await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw'),
      );

      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledWith(
        expect.anything(),
        {
          placement: 'active',
          liveAccounts: 'replace',
          accountRecord: 'upsert',
        },
      );
      expect(matrix.init).not.toHaveBeenCalled();
      expect(matrix.add).not.toHaveBeenCalled();
    });

    it('delegates add login to additive Account Runtime placement', async () => {
      stubLogin();
      const matrix = TestBed.inject(MatrixClientService);
      const accounts = TestBed.inject(AccountRuntimeService);

      await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw', 'add'),
      );

      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledWith(
        expect.anything(),
        {
          placement: 'active',
          liveAccounts: 'keep',
          accountRecord: 'upsert',
        },
      );
      expect(matrix.add).not.toHaveBeenCalled();
      expect(matrix.init).not.toHaveBeenCalled();
    });

    it('threads an existing device_id into the login payload only when provided', async () => {
      // A soft-logged-out account is re-authed on its own device so its crypto
      // store is reused; a fresh login must NOT pin a device_id (server issues one).
      const loginRequest = vi.fn().mockResolvedValue(loginRes);
      createClientMock.mockReturnValue({ loginRequest } as never);
      const matrix = TestBed.inject(MatrixClientService);
      const storage = TestBed.inject(SessionStorageService);
      vi.mocked(storage.save).mockReturnValue(
        of({
          baseUrl: 'https://hs',
          userId: '@me:hs',
          deviceId: 'EXISTING_DEV',
          accessToken: 'tok',
        }),
      );
      vi.mocked(matrix.add).mockReturnValue(of(undefined));

      await firstValueFrom(
        auth.loginWithPassword(
          'https://hs',
          '@me:hs',
          'pw',
          'add',
          'EXISTING_DEV',
        ),
      );
      await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw', 'add'),
      );

      expect(loginRequest).toHaveBeenCalledTimes(2);
      expect(loginRequest.mock.calls[0]).toEqual([
        expect.objectContaining({
          type: 'm.login.password',
          device_id: 'EXISTING_DEV',
        }),
      ]);
      expect(loginRequest.mock.calls[1][0]).not.toHaveProperty('device_id');
    });
  });

  describe('re-authenticating a stored account', () => {
    // A re-auth must come back as the account being reconnected. Whatever the method
    // (password or legacy SSO), a result for another user is refused before anything is
    // persisted, so the saved account keeps its device and crypto store.
    const logout = vi.fn().mockResolvedValue({});
    const answer = (user_id: string) =>
      createClientMock.mockReturnValue({
        loginRequest: vi.fn().mockResolvedValue({
          user_id,
          device_id: 'DEV',
          access_token: 'tok',
        }),
        logout,
      } as never);

    it('refuses a password login that returns a different user and persists nothing', async () => {
      answer('@bob:hs');
      const accounts = TestBed.inject(AccountRuntimeService);

      const attempt = firstValueFrom(
        auth.loginWithPassword(
          'https://hs',
          '@alice:hs',
          'pw',
          'add',
          'DEV',
          '@alice:hs',
        ),
      );

      await expect(attempt).rejects.toBeInstanceOf(ReauthAccountMismatchError);
      await expect(attempt).rejects.toThrow(/@bob:hs.*@alice:hs/);
      expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
      // It asked for a specific device, so the session is not signed out: that device id
      // may name a device the user keeps.
      expect(logout).not.toHaveBeenCalled();
    });

    it("signs out the other user's new session when a re-auth on a new device returns them", async () => {
      answer('@bob:hs');

      await expect(
        firstValueFrom(
          auth.loginWithPassword(
            'https://hs',
            '@alice:hs',
            'pw',
            'add',
            undefined,
            '@alice:hs',
          ),
        ),
      ).rejects.toBeInstanceOf(ReauthAccountMismatchError);
      expect(createClientMock).toHaveBeenLastCalledWith({
        baseUrl: 'https://hs',
        accessToken: 'tok',
      });
      expect(logout).toHaveBeenCalledWith(true);
    });

    it('refuses a legacy SSO login that returns a different user and persists nothing', async () => {
      answer('@bob:hs');
      const accounts = TestBed.inject(AccountRuntimeService);

      await expect(
        firstValueFrom(
          auth.completeSsoLogin(
            'https://hs',
            'login-token',
            'add',
            'DEV',
            '@alice:hs',
          ),
        ),
      ).rejects.toBeInstanceOf(ReauthAccountMismatchError);
      expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
    });

    it('establishes a password and a legacy SSO login that return the expected user', async () => {
      answer('@alice:hs');
      const accounts = TestBed.inject(AccountRuntimeService);

      await firstValueFrom(
        auth.loginWithPassword(
          'https://hs',
          '@alice:hs',
          'pw',
          'add',
          'DEV',
          '@alice:hs',
        ),
      );
      await firstValueFrom(
        auth.completeSsoLogin(
          'https://hs',
          'login-token',
          'add',
          'DEV',
          '@alice:hs',
        ),
      );

      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledTimes(2);
    });

    it('does not constrain an ordinary login that expects no particular user', async () => {
      answer('@anyone:hs');
      const accounts = TestBed.inject(AccountRuntimeService);

      await firstValueFrom(
        auth.loginWithPassword('https://hs', 'anyone', 'pw'),
      );

      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledOnce();
    });
  });

  describe('binding the account to its server', () => {
    const logout = vi.fn().mockResolvedValue({});
    const answer = (user_id: string) =>
      createClientMock.mockReturnValue({
        loginRequest: vi.fn().mockResolvedValue({
          user_id,
          device_id: 'DEV',
          access_token: 'tok',
        }),
        logout,
      } as never);
    const discovery = () => TestBed.inject(AUTHENTICATION_HOMESERVER_DISCOVERY);

    it.each([
      ['https://localhost:8450', '@x:localhost'],
      ['https://matrix-client.matrix.org', '@alice:matrix.org'],
      ['https://Matrix.Example.org./', '@alice:example.org:8448'],
      ['https://[::1]:8008', '@a:[::1]'],
    ])('accepts %s signing in %s without a lookup', async (baseUrl, userId) => {
      answer(userId);

      const outcome = await firstValueFrom(
        auth.loginWithPassword(baseUrl, userId, 'pw'),
      );

      expect(outcome.kind).toBe('ready');
      expect(discovery().lookUp).not.toHaveBeenCalled();
    });

    it('accepts a delegated server whose well-known names the homeserver signed in to', async () => {
      answer('@alice:example.com');
      vi.mocked(discovery().lookUp).mockReturnValue(
        of({ domain: 'example.com', baseUrl: 'https://synapse.host.net/' }),
      );

      const outcome = await firstValueFrom(
        auth.loginWithPassword('https://synapse.host.net', '@alice', 'pw'),
      );

      expect(outcome.kind).toBe('ready');
      expect(discovery().lookUp).toHaveBeenCalledWith('@alice:example.com');
      // The check only reads: it declares no origins to the desktop network policy.
      expect(discovery().discover).not.toHaveBeenCalled();
    });

    it.each([
      ['another server', '@alice:matrix.org', 'https://hs.example'],
      ['a parent of an IP address', '@a:2.3.4', 'https://1.2.3.4'],
      ['a lookalike suffix', '@a:example.org', 'https://evilexample.org'],
    ])(
      'refuses an account on %s, signs the new device out and stores nothing',
      async (_case, userId, baseUrl) => {
        answer(userId);
        const accounts = TestBed.inject(AccountRuntimeService);

        const attempt = firstValueFrom(
          auth.loginWithPassword(baseUrl, userId, 'pw'),
        );

        await expect(attempt).rejects.toBeInstanceOf(UnacceptableAccountError);
        await expect(attempt).rejects.toThrow(userId);
        expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
        expect(logout).toHaveBeenCalledWith(true);
      },
    );

    it('says it could not confirm the server when the lookup finds nothing', async () => {
      answer('@x:example.com');

      const attempt = firstValueFrom(
        auth.loginWithPassword('https://chat.provider.net', 'x', 'pw'),
      );

      await expect(attempt).rejects.toMatchObject({ reason: 'unconfirmed' });
      await expect(attempt).rejects.toThrow(
        /couldn't confirm that @x:example\.com belongs to this server/,
      );
      await expect(attempt).rejects.not.toThrow(/different server/);
    });

    it('accepts the server the person entered without a lookup', async () => {
      answer('@x:example.com');

      const outcome = await firstValueFrom(
        auth.loginWithPassword(
          'https://chat.provider.net',
          'x',
          'pw',
          'replace',
          undefined,
          undefined,
          'Example.com',
        ),
      );

      expect(outcome.kind).toBe('ready');
      expect(discovery().lookUp).not.toHaveBeenCalled();
    });

    it('still looks up a server other than the one the person entered', async () => {
      answer('@x:matrix.org');

      await expect(
        firstValueFrom(
          auth.loginWithPassword(
            'https://chat.provider.net',
            'x',
            'pw',
            'replace',
            undefined,
            undefined,
            'example.com',
          ),
        ),
      ).rejects.toBeInstanceOf(UnacceptableAccountError);
      expect(discovery().lookUp).toHaveBeenCalledWith('@x:matrix.org');
    });

    describe('re-authenticating a stored account', () => {
      const stored = (baseUrl: string) =>
        vi
          .mocked(TestBed.inject(SessionStorageService).record)
          .mockReturnValue(
            of({ userId: '@x:example.com', baseUrl, deviceId: 'DEV' }),
          );
      const reauth = (expectedUserId?: string) =>
        firstValueFrom(
          auth.loginWithPassword(
            'https://chat.provider.net',
            '@x:example.com',
            'pw',
            'add',
            'DEV',
            expectedUserId,
          ),
        );

      it('skips the lookup for the account saved through this homeserver', async () => {
        answer('@x:example.com');
        stored('https://chat.provider.net/');

        expect((await reauth('@x:example.com')).kind).toBe('ready');
        expect(discovery().lookUp).not.toHaveBeenCalled();
      });

      it('looks the server up when the account was saved through another homeserver', async () => {
        answer('@x:example.com');
        stored('https://old.provider.net');

        await expect(reauth('@x:example.com')).rejects.toBeInstanceOf(
          UnacceptableAccountError,
        );
        expect(discovery().lookUp).toHaveBeenCalled();
      });

      it('looks the server up for a sign-in that is not a re-auth', async () => {
        answer('@x:example.com');
        stored('https://chat.provider.net');

        await expect(reauth()).rejects.toBeInstanceOf(UnacceptableAccountError);
        expect(discovery().lookUp).toHaveBeenCalled();
      });
    });

    it('refuses a server whose well-known names a different homeserver', async () => {
      answer('@alice:matrix.org');
      vi.mocked(discovery().lookUp).mockReturnValue(
        of({
          domain: 'matrix.org',
          baseUrl: 'https://matrix-client.matrix.org',
        }),
      );

      await expect(
        firstValueFrom(
          auth.loginWithPassword('https://hs.example', '@alice', 'pw'),
        ),
      ).rejects.toMatchObject({ reason: 'other-server' });
      expect(
        TestBed.inject(AccountRuntimeService).establishAuthenticatedAccount,
      ).not.toHaveBeenCalled();
    });

    it('refuses a malformed sign-in response and signs the new device out', async () => {
      createClientMock.mockReturnValue({
        loginRequest: vi.fn().mockResolvedValue({
          user_id: '@alice',
          device_id: 'example.org:ABCDEFGHIJ',
          access_token: 'tok',
        }),
        logout,
      } as never);

      await expect(
        firstValueFrom(
          auth.loginWithPassword('https://example.org', 'alice', 'pw'),
        ),
      ).rejects.toBeInstanceOf(UnacceptableAccountError);
      expect(
        TestBed.inject(AccountRuntimeService).establishAuthenticatedAccount,
      ).not.toHaveBeenCalled();
      expect(logout).toHaveBeenCalledWith(true);
    });

    it('keeps a re-authenticated device signed in when its account is refused', async () => {
      answer('@alice:matrix.org');

      await expect(
        firstValueFrom(
          auth.loginWithPassword(
            'https://hs.example',
            '@alice:matrix.org',
            'pw',
            'add',
            'DEV',
            '@alice:matrix.org',
          ),
        ),
      ).rejects.toBeInstanceOf(UnacceptableAccountError);
      expect(logout).not.toHaveBeenCalled();
    });

    it('refuses an OAuth grant for an account on another server and revokes it', async () => {
      const oidc = TestBed.inject(OidcClientService);
      const binding = {
        issuer: 'https://op',
        clientId: 'c1',
        redirectUri: 'https://app/cb',
        tokenEndpoint: 'https://op/token',
        revocationEndpoint: 'https://op/revoke',
      };
      vi.mocked(oidc.completeGrant).mockReturnValue(
        of({
          homeserverUrl: 'https://hs.example',
          userId: '@alice:matrix.org',
          deviceId: 'DEV',
          accessToken: 'atok',
          refreshToken: 'rtok',
          accessTokenExpiresAt: 1234,
          oidc: binding,
        }),
      );
      vi.mocked(oidc.revokeTokens).mockReturnValue(of(undefined));

      await expect(
        firstValueFrom(
          auth.completeOidcLogin('code', {
            baseUrl: 'https://hs.example',
            redirectUri: 'https://app/cb',
            clientId: 'c1',
            deviceId: 'DEV',
            codeVerifier: 'verifier',
            issuer: 'https://op',
            authorizationEndpoint: 'https://op/authorize',
            tokenEndpoint: 'https://op/token',
            revocationEndpoint: 'https://op/revoke',
          }),
        ),
      ).rejects.toBeInstanceOf(UnacceptableAccountError);
      expect(
        TestBed.inject(AccountRuntimeService).establishAuthenticatedAccount,
      ).not.toHaveBeenCalled();
      // The refused grant is revoked at the endpoint pinned at sign-in.
      expect(oidc.revokeTokens).toHaveBeenCalledWith(
        'https://hs.example',
        binding,
        { accessToken: 'atok', refreshToken: 'rtok' },
      );
    });
  });

  describe('completeOidcLogin', () => {
    // The PKCE stash the callback route recovers and feeds back: since matrix-js-sdk 42
    // nothing else holds the verifier, so it travels as one context object rather than
    // the old (code, state, redirectUri) triple.
    const context: OidcGrantContext = {
      baseUrl: 'https://hs',
      redirectUri: 'https://app/cb',
      clientId: 'c1',
      deviceId: 'DEV',
      codeVerifier: 'verifier',
      issuer: 'https://op',
      authorizationEndpoint: 'https://op/authorize',
      tokenEndpoint: 'https://op/token',
    };
    const grant = {
      homeserverUrl: 'https://hs',
      userId: '@me:hs',
      deviceId: 'DEV',
      accessToken: 'atok',
      refreshToken: 'rtok',
      accessTokenExpiresAt: 1234,
      // No idTokenClaims: v42 dropped the id_token, so a fresh grant never carries them.
      oidc: {
        issuer: 'https://op',
        clientId: 'c1',
        redirectUri: 'https://app/cb',
      },
    };

    it('exchanges the grant and delegates OIDC session establishment', async () => {
      const oidc = TestBed.inject(OidcClientService);
      const accounts = TestBed.inject(AccountRuntimeService);
      const matrix = TestBed.inject(MatrixClientService);
      vi.mocked(oidc.completeGrant).mockReturnValue(of(grant) as never);

      await firstValueFrom(auth.completeOidcLogin('CODE', context));

      expect(oidc.completeGrant).toHaveBeenCalledWith('CODE', context);
      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledWith(
        expect.anything(),
        {
          placement: 'active',
          liveAccounts: 'replace',
          accountRecord: 'upsert',
        },
      );
      expect(matrix.init).not.toHaveBeenCalled();
      expect(matrix.add).not.toHaveBeenCalled();
    });

    it('adds the OIDC account alongside others in add mode', async () => {
      const oidc = TestBed.inject(OidcClientService);
      const accounts = TestBed.inject(AccountRuntimeService);
      const matrix = TestBed.inject(MatrixClientService);
      vi.mocked(oidc.completeGrant).mockReturnValue(of(grant) as never);

      await firstValueFrom(auth.completeOidcLogin('CODE', context, 'add'));

      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ liveAccounts: 'keep' }),
      );
      expect(matrix.add).not.toHaveBeenCalled();
      expect(matrix.init).not.toHaveBeenCalled();
    });

    it('refuses a grant for a different account than the one being re-authenticated', async () => {
      // Re-auth sends the stored account's device id in the requested scope, and a
      // provider that already holds a browser session authorizes with no interaction —
      // so on a homeserver with two accounts, "sign in again to reconnect this account"
      // can silently come back as the OTHER one. Nothing compared the two, so establish()
      // would persist B under A's device id; upsert then sees deviceChanged and reclaims
      // B's live crypto store, forcing re-verification of an account never touched.
      const oidc = TestBed.inject(OidcClientService);
      const storage = TestBed.inject(SessionStorageService);
      vi.mocked(oidc.completeGrant).mockReturnValue(of(grant) as never);
      vi.mocked(oidc.revokeTokens).mockReturnValue(of(undefined));

      await expect(
        firstValueFrom(
          auth.completeOidcLogin('CODE', context, 'add', '@other:hs'),
        ),
      ).rejects.toThrow(ReauthAccountMismatchError);

      expect(storage.save).not.toHaveBeenCalled();
      // The grant is unusable and its tokens are live: hand them back rather than
      // leaving a session the user cannot see or reach.
      expect(oidc.revokeTokens).toHaveBeenCalledWith(
        'https://hs',
        grant.oidc,
        expect.objectContaining({ accessToken: 'atok', refreshToken: 'rtok' }),
      );
    });

    it('accepts a grant that matches the account being re-authenticated', async () => {
      const oidc = TestBed.inject(OidcClientService);
      const accounts = TestBed.inject(AccountRuntimeService);
      const matrix = TestBed.inject(MatrixClientService);
      vi.mocked(oidc.completeGrant).mockReturnValue(of(grant) as never);

      await firstValueFrom(
        auth.completeOidcLogin('CODE', context, 'add', '@me:hs'),
      );

      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalled();
      expect(matrix.add).not.toHaveBeenCalled();
      expect(oidc.revokeTokens).not.toHaveBeenCalled();
    });
  });

  describe('completing a QR sign-in on the new device', () => {
    const tokens = {
      access_token: 'qr-atok',
      token_type: 'Bearer',
      refresh_token: 'qr-rtok',
      expires_in: 300,
    };
    const whoami = vi.fn();
    const signedIn = { getUserId: () => '@me:hs' };
    const pinned = {
      issuer: AUTH_METADATA.issuer,
      clientId: 'qr-client',
      tokenEndpoint: 'https://op.example/verified-token',
      revocationEndpoint: 'https://op.example/verified-revoke',
    };
    beforeEach(() => {
      whoami.mockReset().mockResolvedValue({
        user_id: '@me:hs',
        device_id: 'QRDEV',
      });
      createClientMock.mockReturnValue({ whoami } as never);
      vi.mocked(TestBed.inject(MatrixClientService).clientFor).mockReturnValue(
        signedIn as never,
      );
      vi.mocked(TestBed.inject(OidcClientService).revokeTokens).mockReturnValue(
        of(undefined),
      );
      vi.mocked(
        TestBed.inject(OidcClientService).deviceGrantBinding,
      ).mockReturnValue(of(pinned));
    });
    const complete = () =>
      firstValueFrom(
        auth.completeDeviceGrant(
          tokens,
          'qr-client',
          AUTH_METADATA,
          'https://hs',
        ),
      );

    it('runs whoami, then establishes an OAuth session that has no redirect URI', async () => {
      const issue = vi.spyOn(AuthenticatedAccountGrant, 'issue');
      const accounts = TestBed.inject(AccountRuntimeService);

      expect(await complete()).toBe(signedIn);

      expect(createClientMock).toHaveBeenCalledWith({
        baseUrl: 'https://hs',
        accessToken: 'qr-atok',
      });
      expect(whoami.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(accounts.establishAuthenticatedAccount).mock
          .invocationCallOrder[0],
      );
      const session = issue.mock.calls[0][0];
      expect(session).toMatchObject({
        baseUrl: 'https://hs',
        userId: '@me:hs',
        deviceId: 'QRDEV',
        accessToken: 'qr-atok',
        refreshToken: 'qr-rtok',
        oidc: pinned,
      });
      expect(
        TestBed.inject(OidcClientService).deviceGrantBinding,
      ).toHaveBeenCalledWith(AUTH_METADATA, 'qr-client');
      expect(session.oidc).not.toHaveProperty('redirectUri');
      expect(session.accessTokenExpiresAt).toBeGreaterThan(Date.now());
      // Other signed-in accounts on this device stay signed in.
      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ liveAccounts: 'keep' }),
      );
    });

    it('asks the keyring question as every sign-in does, and hands the tokens back on a no', async () => {
      const gate = TestBed.inject(UnprotectedStorageGate);
      vi.mocked(gate.allowed).mockReturnValue(of(false));
      const oidc = TestBed.inject(OidcClientService);

      await expect(complete()).rejects.toBeInstanceOf(
        UnprotectedStorageDeclinedError,
      );

      expect(gate.allowed).toHaveBeenCalled();
      expect(
        TestBed.inject(AccountRuntimeService).establishAuthenticatedAccount,
      ).not.toHaveBeenCalled();
      expect(oidc.revokeTokens).toHaveBeenCalledWith(
        'https://hs',
        expect.objectContaining({ clientId: 'qr-client' }),
        { accessToken: 'qr-atok', refreshToken: 'qr-rtok' },
      );
    });

    it('hands the tokens back and establishes nothing when whoami fails', async () => {
      whoami.mockRejectedValue(new Error('offline'));

      await expect(complete()).rejects.toThrow('offline');

      expect(
        TestBed.inject(AccountRuntimeService).establishAuthenticatedAccount,
      ).not.toHaveBeenCalled();
      expect(TestBed.inject(OidcClientService).revokeTokens).toHaveBeenCalled();
    });

    it('revokes the tokens when the sign-in is left while whoami is pending', async () => {
      whoami.mockReturnValue(new Promise(() => undefined));
      const oidc = TestBed.inject(OidcClientService);

      const attempt = auth
        .completeDeviceGrant(tokens, 'qr-client', AUTH_METADATA, 'https://hs')
        .subscribe({ error: () => undefined });
      await vi.waitFor(() => expect(whoami).toHaveBeenCalled());
      attempt.unsubscribe();

      expect(oidc.revokeTokens).toHaveBeenCalledWith(
        'https://hs',
        { issuer: AUTH_METADATA.issuer, clientId: 'qr-client' },
        { accessToken: 'qr-atok', refreshToken: 'qr-rtok' },
      );
    });

    it('leaves an account this device already stores as it was, and revokes the new tokens', async () => {
      const storage = TestBed.inject(SessionStorageService);
      vi.mocked(storage.record).mockReturnValue(
        of({ baseUrl: 'https://hs', userId: '@me:hs', deviceId: 'OLD' }),
      );

      const error = await complete().catch((e: unknown) => e);

      expect(qrSignInFailureOf(error)).toBe('already-signed-in');
      expect(
        TestBed.inject(AccountRuntimeService).establishAuthenticatedAccount,
      ).not.toHaveBeenCalled();
      expect(storage.save).not.toHaveBeenCalled();
      expect(
        TestBed.inject(OidcClientService).revokeTokens,
      ).toHaveBeenCalledWith(
        'https://hs',
        expect.objectContaining({ clientId: 'qr-client' }),
        { accessToken: 'qr-atok', refreshToken: 'qr-rtok' },
      );
    });

    it('does not revoke the tokens once the sign-in succeeded', async () => {
      await complete();

      expect(
        TestBed.inject(OidcClientService).revokeTokens,
      ).not.toHaveBeenCalled();
    });

    it('fails when the account runtime does not start the account', async () => {
      vi.mocked(
        TestBed.inject(AccountRuntimeService).establishAuthenticatedAccount,
      ).mockReturnValue(
        of({
          kind: 'failed',
          failure: 'crypto-failure',
          accountId: '@me:hs',
          placement: 'active',
        }),
      );

      await expect(complete()).rejects.toThrow();
    });
  });

  describe('importing the secrets a QR link shared', () => {
    const secrets = {
      cross_signing: {
        master_key: 'MASTER-SECRET',
        self_signing_key: 'SELF-SECRET',
        user_signing_key: 'USER-SECRET',
      },
      backup: {
        algorithm: 'm.megolm_backup.v1.curve25519-aes-sha2',
        key: 'BACKUP-SECRET',
        backup_version: '1',
      },
    };
    const crypto = {
      importSecretsBundle: vi.fn(),
      crossSignDevice: vi.fn(),
      checkKeyBackupAndEnable: vi.fn(),
      isCrossSigningReady: vi.fn(),
      getDeviceVerificationStatus: vi.fn(),
    };
    const client = {
      getCrypto: () => crypto,
      getDeviceId: () => 'QRDEV',
      getUserId: () => '@me:hs',
    } as unknown as MatrixClient;
    beforeEach(() => {
      crypto.importSecretsBundle.mockReset().mockResolvedValue(undefined);
      crypto.crossSignDevice.mockReset().mockResolvedValue(undefined);
      crypto.checkKeyBackupAndEnable.mockReset().mockResolvedValue(null);
      crypto.isCrossSigningReady.mockReset().mockResolvedValue(true);
      crypto.getDeviceVerificationStatus
        .mockReset()
        .mockResolvedValue({ crossSigningVerified: true });
    });
    const importSecrets = () =>
      firstValueFrom(auth.importLinkedSecrets(client, secrets as never));

    it('imports the bundle, cross-signs this device and enables backup, in that order', async () => {
      expect(await importSecrets()).toBe(true);

      expect(crypto.importSecretsBundle).toHaveBeenCalledWith(secrets);
      expect(crypto.crossSignDevice).toHaveBeenCalledWith('QRDEV');
      const order = [
        crypto.importSecretsBundle,
        crypto.crossSignDevice,
        crypto.checkKeyBackupAndEnable,
      ].map((step) => step.mock.invocationCallOrder[0]);
      expect(order).toEqual([...order].sort((a, b) => a - b));
    });

    it('reports an unverified device, cross-signs nothing and logs no secret when the import fails', async () => {
      const logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
        (level) => vi.spyOn(console, level).mockImplementation(() => undefined),
      );
      crypto.importSecretsBundle.mockRejectedValue(
        new Error('bad bundle MASTER-SECRET'),
      );

      expect(await importSecrets()).toBe(false);

      expect(crypto.crossSignDevice).not.toHaveBeenCalled();
      expect(JSON.stringify(logged.map((spy) => spy.mock.calls))).not.toMatch(
        /SECRET/,
      );
    });

    it('reports a verified device when only enabling backup fails', async () => {
      crypto.checkKeyBackupAndEnable.mockRejectedValue(new Error('no backup'));

      expect(await importSecrets()).toBe(true);
    });

    it('reports an unverified device when it is not cross-signing verified after the import', async () => {
      crypto.getDeviceVerificationStatus.mockResolvedValue({
        crossSigningVerified: false,
      });

      expect(await importSecrets()).toBe(false);
      expect(crypto.getDeviceVerificationStatus).toHaveBeenCalledWith(
        '@me:hs',
        'QRDEV',
      );
    });

    it('reports an unverified device when cross-signing is not ready after the import', async () => {
      crypto.isCrossSigningReady.mockResolvedValue(false);

      expect(await importSecrets()).toBe(false);
    });

    it('reports an unverified device when cross-signing fails', async () => {
      crypto.crossSignDevice.mockRejectedValue(new Error('upload failed'));

      expect(await importSecrets()).toBe(false);
    });
  });

  it('forgets an OIDC client id via the client service', async () => {
    const oidc = TestBed.inject(OidcClientService);
    vi.mocked(oidc.forgetClientId).mockReturnValue(of(undefined));

    await firstValueFrom(auth.forgetOidcClientId('https://hs', 'https://op'));

    expect(oidc.forgetClientId).toHaveBeenCalledWith(
      'https://hs',
      'https://op',
    );
  });

  describe('completeSsoLogin', () => {
    it('exchanges the SSO loginToken and establishes the account additively', async () => {
      const loginRequest = vi.fn().mockResolvedValue({
        user_id: '@me:hs',
        device_id: 'DEV',
        access_token: 'tok',
      });
      createClientMock.mockReturnValue({ loginRequest } as never);
      const accounts = TestBed.inject(AccountRuntimeService);
      const matrix = TestBed.inject(MatrixClientService);

      await firstValueFrom(
        auth.completeSsoLogin('https://hs', 'login-token', 'add', 'DEV'),
      );

      expect(loginRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'm.login.token',
          token: 'login-token',
          device_id: 'DEV',
        }),
      );
      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ liveAccounts: 'keep' }),
      );
      expect(matrix.add).not.toHaveBeenCalled();
      expect(matrix.init).not.toHaveBeenCalled();
    });
  });

  describe('changePassword', () => {
    // isInitialized/instance are getters ng-mocks leaves undefined; define them per
    // test so changePassword sees a live client (or, for the guard test, no session).
    function useClient(client: {
      setPassword: unknown;
      getUserId: unknown;
    }): void {
      const matrix = TestBed.inject(MatrixClientService);
      Object.defineProperty(matrix, 'isInitialized', {
        get: () => true,
        configurable: true,
      });
      Object.defineProperty(matrix, 'instance', {
        get: () => client,
        configurable: true,
      });
    }

    it('sets the new password when the server needs no interactive auth', async () => {
      const client = {
        setPassword: vi.fn().mockResolvedValue(undefined),
        getUserId: vi.fn(() => '@me:hs'),
      };
      useClient(client);

      await expect(
        firstValueFrom(auth.changePassword('old-pw', 'new-secret-pw')),
      ).resolves.toBeUndefined();

      // First attempt carries no auth at all — an empty `auth: {}` is a malformed UIA
      // dict that ruma-based servers (Tuwunel, Conduit) reject with M_BAD_JSON instead
      // of the 401 challenge. Other sessions stay signed in (false).
      expect(client.setPassword).toHaveBeenCalledWith(
        undefined,
        'new-secret-pw',
        false,
      );
    });

    it('satisfies the UIA password stage with the current password', async () => {
      const client = {
        setPassword: vi
          .fn()
          .mockRejectedValueOnce(uia('sess-1'))
          .mockResolvedValueOnce(undefined),
        getUserId: vi.fn(() => '@me:hs'),
      };
      useClient(client);

      await expect(
        firstValueFrom(auth.changePassword('old-pw', 'new-secret-pw')),
      ).resolves.toBeUndefined();

      expect(client.setPassword).toHaveBeenCalledTimes(2);
      expect(client.setPassword.mock.calls[1][0]).toMatchObject({
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: '@me:hs' },
        password: 'old-pw',
        session: 'sess-1',
      });
    });

    it('surfaces a rejected current password as a clear error', async () => {
      // The server keeps returning 401 (wrong password) — the single attempt is spent,
      // so the UIA helper cancels and we map that to a human message.
      const client = {
        setPassword: vi
          .fn()
          .mockRejectedValueOnce(uia('sess-1'))
          .mockRejectedValueOnce(uia('sess-2')),
        getUserId: vi.fn(() => '@me:hs'),
      };
      useClient(client);

      await expect(
        firstValueFrom(auth.changePassword('wrong-pw', 'new-secret-pw')),
      ).rejects.toThrow('Your current password is incorrect.');
    });

    it('errors without touching the client when not signed in', async () => {
      await expect(
        firstValueFrom(auth.changePassword('old-pw', 'new-secret-pw')),
      ).rejects.toThrow('Not signed in.');
    });
  });
  describe('storing a sign-in without a keychain', () => {
    const logout = vi.fn().mockResolvedValue({});
    beforeEach(() => {
      logout.mockClear();
      createClientMock.mockReturnValue({
        loginRequest: vi.fn().mockResolvedValue({
          user_id: '@me:hs',
          device_id: 'NEW',
          access_token: 'new-tok',
        }),
        logout,
      } as never);
    });
    const gate = (answer: ReturnType<UnprotectedStorageGate['allowed']>) =>
      vi
        .mocked(TestBed.inject(UnprotectedStorageGate).allowed)
        .mockReturnValue(answer);

    it('signs the new session out and stores nothing when the person declines', async () => {
      gate(of(false));

      await expect(
        firstValueFrom(auth.loginWithPassword('https://hs', '@me:hs', 'pw')),
      ).rejects.toBeInstanceOf(UnprotectedStorageDeclinedError);
      expect(
        TestBed.inject(AccountRuntimeService).establishAuthenticatedAccount,
      ).not.toHaveBeenCalled();
      expect(logout).toHaveBeenCalledWith(true);
    });

    it('signs the new session out when the question goes away unanswered', async () => {
      gate(NEVER);

      const attempt = auth
        .loginWithPassword('https://hs', '@me:hs', 'pw')
        .subscribe({ error: () => undefined });
      await vi.waitFor(() =>
        expect(
          TestBed.inject(UnprotectedStorageGate).allowed,
        ).toHaveBeenCalled(),
      );
      attempt.unsubscribe();

      expect(logout).toHaveBeenCalledWith(true);
    });

    it('signs the new session out when the stored answer cannot be read', async () => {
      gate(throwError(() => new Error('preferences unavailable')));

      await expect(
        firstValueFrom(auth.loginWithPassword('https://hs', '@me:hs', 'pw')),
      ).rejects.toThrow('preferences unavailable');
      expect(logout).toHaveBeenCalledWith(true);
    });

    it('keeps the stored device signed in when a re-auth on it is declined', async () => {
      gate(of(false));
      vi.mocked(TestBed.inject(SessionStorageService).record).mockReturnValue(
        of({ baseUrl: 'https://hs', userId: '@me:hs', deviceId: 'NEW' }),
      );

      await expect(
        firstValueFrom(
          auth.loginWithPassword(
            'https://hs',
            '@me:hs',
            'pw',
            'add',
            'NEW',
            '@me:hs',
          ),
        ),
      ).rejects.toBeInstanceOf(UnprotectedStorageDeclinedError);
      expect(logout).not.toHaveBeenCalled();
    });
  });

  describe('a sign-in that the account runtime refuses', () => {
    const logout = vi.fn().mockResolvedValue({});
    const refuse = (
      outcome:
        | {
            kind: 'failed';
            failure: 'homeserver-mismatch';
            storedBaseUrl: string;
          }
        | { kind: 'failed'; failure: 'account-already-stored' }
        | { kind: 'failed'; failure: 'unprotected-storage-declined' }
        | { kind: 'failed'; failure: 'transient-network' }
        | { kind: 'transition-in-progress' },
    ) =>
      vi
        .mocked(
          TestBed.inject(AccountRuntimeService).establishAuthenticatedAccount,
        )
        .mockReturnValue(
          of({
            ...outcome,
            accountId: '@me:hs',
            placement: 'active',
          } as AccountEstablishmentOutcome),
        );

    beforeEach(() => {
      createClientMock.mockReturnValue({
        loginRequest: vi.fn().mockResolvedValue({
          user_id: '@me:hs',
          device_id: 'NEW',
          access_token: 'new-tok',
        }),
        logout,
      } as never);
    });

    it.each([
      [
        'a homeserver mismatch',
        {
          kind: 'failed',
          failure: 'homeserver-mismatch',
          storedBaseUrl: 'https://stored.example',
        } as const,
      ],
      [
        'an already-stored account',
        { kind: 'failed', failure: 'account-already-stored' } as const,
      ],
      ['a transition in progress', { kind: 'transition-in-progress' } as const],
      [
        'a refusal to store it without a keychain',
        { kind: 'failed', failure: 'unprotected-storage-declined' } as const,
      ],
    ])('signs the new session out after %s', async (_case, outcome) => {
      refuse(outcome);

      const result = await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw'),
      );

      expect(result.kind).toBe(outcome.kind);
      expect(createClientMock).toHaveBeenLastCalledWith({
        baseUrl: 'https://hs',
        accessToken: 'new-tok',
      });
      expect(logout).toHaveBeenCalledWith(true);
    });

    it('keeps a re-authenticated device signed in when the runtime is busy', async () => {
      refuse({ kind: 'transition-in-progress' });
      vi.mocked(TestBed.inject(SessionStorageService).record).mockReturnValue(
        of({ baseUrl: 'https://hs', userId: '@me:hs', deviceId: 'NEW' }),
      );

      const result = await firstValueFrom(
        auth.loginWithPassword(
          'https://hs',
          '@me:hs',
          'pw',
          'add',
          'NEW',
          '@me:hs',
        ),
      );

      expect(result.kind).toBe('transition-in-progress');
      expect(logout).not.toHaveBeenCalled();
    });

    it('keeps an OIDC re-authenticated device when the runtime is busy', async () => {
      refuse({ kind: 'transition-in-progress' });
      vi.mocked(TestBed.inject(SessionStorageService).record).mockReturnValue(
        of({ baseUrl: 'https://hs', userId: '@me:hs', deviceId: 'KEPT' }),
      );
      const oidc = TestBed.inject(OidcClientService);
      vi.mocked(oidc.completeGrant).mockReturnValue(
        of({
          homeserverUrl: 'https://hs',
          userId: '@me:hs',
          deviceId: 'KEPT',
          accessToken: 'atok',
          oidc: { issuer: 'https://op' },
        }) as never,
      );

      await firstValueFrom(
        auth.completeOidcLogin(
          'CODE',
          {
            baseUrl: 'https://hs',
            redirectUri: 'https://app/cb',
            clientId: 'c1',
            deviceId: 'KEPT',
            codeVerifier: 'v',
            issuer: 'https://op',
            authorizationEndpoint: 'https://op/authorize',
            tokenEndpoint: 'https://op/token',
          },
          'add',
          '@me:hs',
        ),
      );

      expect(oidc.revokeTokens).not.toHaveBeenCalled();
    });

    it('keeps a re-authenticated device when its stored record cannot be read', async () => {
      vi.mocked(TestBed.inject(SessionStorageService).record).mockReturnValue(
        throwError(() => new Error('registry unreadable')),
      );

      await expect(
        firstValueFrom(
          auth.loginWithPassword(
            'https://hs',
            '@me:hs',
            'pw',
            'add',
            'NEW',
            '@me:hs',
          ),
        ),
      ).rejects.toThrow('registry unreadable');
      expect(logout).not.toHaveBeenCalled();
    });

    it('still signs out a refused sign-in that got a new device for a stored account', async () => {
      refuse({ kind: 'transition-in-progress' });
      vi.mocked(TestBed.inject(SessionStorageService).record).mockReturnValue(
        of({ baseUrl: 'https://hs', userId: '@me:hs', deviceId: 'OLD' }),
      );
      vi.mocked(
        TestBed.inject(MatrixClientService).roomKeysBackedUp,
      ).mockReturnValue(of(true));

      await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw'),
      );

      expect(createClientMock).toHaveBeenLastCalledWith({
        baseUrl: 'https://hs',
        accessToken: 'new-tok',
      });
      expect(logout).toHaveBeenCalledWith(true);
    });

    it('keeps a new session that was saved, whatever went wrong after', async () => {
      refuse({ kind: 'failed', failure: 'transient-network' });

      await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw'),
      );

      expect(logout).not.toHaveBeenCalled();
    });

    it('revokes a refused OIDC session at its provider', async () => {
      refuse({
        kind: 'failed',
        failure: 'homeserver-mismatch',
        storedBaseUrl: 'https://stored.example',
      });
      const oidc = TestBed.inject(OidcClientService);
      const binding = { issuer: 'https://op' } as never;
      vi.mocked(oidc.completeGrant).mockReturnValue(
        of({
          homeserverUrl: 'https://hs',
          userId: '@me:hs',
          deviceId: 'NEW',
          accessToken: 'atok',
          refreshToken: 'rtok',
          oidc: binding,
        }) as never,
      );
      vi.mocked(oidc.revokeTokens).mockReturnValue(of(undefined));

      await firstValueFrom(
        auth.completeOidcLogin('CODE', {
          baseUrl: 'https://hs',
          redirectUri: 'https://app/cb',
          clientId: 'c1',
          deviceId: 'NEW',
          codeVerifier: 'v',
          issuer: 'https://op',
          authorizationEndpoint: 'https://op/authorize',
          tokenEndpoint: 'https://op/token',
        }),
      );

      expect(oidc.revokeTokens).toHaveBeenCalledWith('https://hs', binding, {
        accessToken: 'atok',
        refreshToken: 'rtok',
      });
    });
  });

  describe('a sign-in that gets a new device for a stored account', () => {
    // Persisting the new device deletes the stored device's crypto store (session-storage
    // upsert). The stored account's live client is asked about key backup first.
    const newDevice = {
      user_id: '@me:hs',
      device_id: 'NEW',
      access_token: 'new-tok',
    };
    const logout = vi.fn().mockResolvedValue({});

    function arrange({
      backedUp,
      choice,
      storedDevice = 'OLD',
    }: {
      backedUp: boolean | null;
      choice: boolean;
      storedDevice?: string;
    }) {
      createClientMock.mockReturnValue({
        loginRequest: vi.fn().mockResolvedValue(newDevice),
        logout,
      } as never);
      const storage = TestBed.inject(SessionStorageService);
      vi.mocked(storage.record).mockReturnValue(
        of({
          baseUrl: 'https://hs',
          userId: '@me:hs',
          deviceId: storedDevice,
          cryptoPrefix: `trinity-crypto:@me:hs:${storedDevice}`,
        }),
      );
      const matrix = TestBed.inject(MatrixClientService);
      vi.mocked(matrix.roomKeysBackedUp).mockReturnValue(of(backedUp));
      const confirm = vi
        .spyOn(TestBed.inject(NEW_DEVICE_SIGN_IN), 'confirm')
        .mockReturnValue(of(choice));
      return {
        confirm,
        matrix,
        accounts: TestBed.inject(AccountRuntimeService),
      };
    }

    it('asks before the stored device is replaced, and Cancel keeps it', async () => {
      const { confirm, matrix, accounts } = arrange({
        backedUp: false,
        choice: false,
      });

      await expect(
        firstValueFrom(auth.loginWithPassword('https://hs', '@me:hs', 'pw')),
      ).rejects.toBeInstanceOf(NewDeviceSignInCancelledError);

      expect(matrix.roomKeysBackedUp).toHaveBeenCalledWith('@me:hs');
      expect(confirm).toHaveBeenCalledWith({
        userId: '@me:hs',
        roomKeysBackedUp: false,
      });
      // Nothing was persisted, so the stored record and its crypto store are untouched.
      expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
      // The device this sign-in created is signed out again.
      expect(createClientMock).toHaveBeenLastCalledWith({
        baseUrl: 'https://hs',
        accessToken: 'new-tok',
      });
      expect(logout).toHaveBeenCalledWith(true);
    });

    it('replaces the stored device only after the user agrees', async () => {
      const { confirm, accounts } = arrange({ backedUp: false, choice: true });

      await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw'),
      );

      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledOnce();
      expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(accounts.establishAuthenticatedAccount).mock
          .invocationCallOrder[0],
      );
      expect(logout).not.toHaveBeenCalled();
    });

    it('does not ask about a stored account saved through another server', async () => {
      const { confirm, matrix, accounts } = arrange({
        backedUp: false,
        choice: false,
      });

      await firstValueFrom(
        auth.loginWithPassword('https://matrix.hs', '@me:hs', 'pw'),
      );

      // Saving refuses this sign-in and keeps the stored device, so there is nothing to
      // warn about: the refusal names the server the account is saved through.
      expect(matrix.roomKeysBackedUp).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledOnce();
    });

    it('asks without a backup status when the stored account is not live', async () => {
      const { confirm } = arrange({ backedUp: null, choice: true });

      await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw'),
      );

      expect(confirm).toHaveBeenCalledWith({
        userId: '@me:hs',
        roomKeysBackedUp: null,
      });
    });

    it('does not ask when key backup holds every room key', async () => {
      const { confirm, accounts } = arrange({ backedUp: true, choice: false });

      await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw'),
      );

      expect(confirm).not.toHaveBeenCalled();
      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledOnce();
    });

    it('does not ask when the sign-in kept the stored device (re-auth)', async () => {
      const { confirm, accounts } = arrange({
        backedUp: false,
        choice: false,
        storedDevice: 'NEW',
      });

      await firstValueFrom(
        auth.loginWithPassword('https://hs', '@me:hs', 'pw'),
      );

      expect(confirm).not.toHaveBeenCalled();
      expect(accounts.establishAuthenticatedAccount).toHaveBeenCalledOnce();
    });

    it('revokes a cancelled OIDC grant at the provider', async () => {
      const { accounts } = arrange({ backedUp: false, choice: false });
      const oidc = TestBed.inject(OidcClientService);
      const binding = {
        issuer: 'https://op',
        clientId: 'c1',
        redirectUri: 'https://app/cb',
      };
      vi.mocked(oidc.completeGrant).mockReturnValue(
        of({
          homeserverUrl: 'https://hs',
          userId: '@me:hs',
          deviceId: 'NEW',
          accessToken: 'atok',
          refreshToken: 'rtok',
          oidc: binding,
        }) as never,
      );
      vi.mocked(oidc.revokeTokens).mockReturnValue(of(undefined));

      await expect(
        firstValueFrom(
          auth.completeOidcLogin('CODE', {
            baseUrl: 'https://hs',
            redirectUri: 'https://app/cb',
            clientId: 'c1',
            deviceId: 'NEW',
            codeVerifier: 'v',
            issuer: 'https://op',
            authorizationEndpoint: 'https://op/authorize',
            tokenEndpoint: 'https://op/token',
          }),
        ),
      ).rejects.toBeInstanceOf(NewDeviceSignInCancelledError);

      expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
      expect(oidc.revokeTokens).toHaveBeenCalledWith('https://hs', binding, {
        accessToken: 'atok',
        refreshToken: 'rtok',
      });
    });

    it('keeps the stored device when the check itself fails', async () => {
      const { accounts } = arrange({ backedUp: false, choice: true });
      vi.mocked(TestBed.inject(SessionStorageService).record).mockReturnValue(
        throwError(() => new Error('registry unreadable')),
      );

      await expect(
        firstValueFrom(auth.loginWithPassword('https://hs', '@me:hs', 'pw')),
      ).rejects.toThrow('registry unreadable');

      expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
      // The sign-in did not go ahead, so the device it created is signed out again.
      expect(logout).toHaveBeenCalledWith(true);
    });

    it('signs the new device out when the sign-in is abandoned mid-dialog', async () => {
      const { confirm, accounts } = arrange({ backedUp: false, choice: true });
      confirm.mockReturnValue(NEVER);

      const signIn = auth
        .loginWithPassword('https://hs', '@me:hs', 'pw')
        .subscribe();
      await vi.waitFor(() => expect(confirm).toHaveBeenCalled());
      expect(logout).not.toHaveBeenCalled();
      signIn.unsubscribe(); // e.g. the login page is closed while the warning is open

      expect(accounts.establishAuthenticatedAccount).not.toHaveBeenCalled();
      expect(logout).toHaveBeenCalledWith(true);
    });
  });

  describe('device display name', () => {
    const names = (loginRequest: ReturnType<typeof vi.fn>) =>
      loginRequest.mock.calls.map(
        ([body]) =>
          (body as { initial_device_display_name?: string })
            .initial_device_display_name,
      );

    it('names a new device "Trinity" when the host has no name of its own', async () => {
      const loginRequest = vi.fn().mockRejectedValue(new Error('stop'));
      createClientMock.mockReturnValue({ loginRequest } as never);
      await expect(
        firstValueFrom(auth.loginWithPassword('https://hs', '@me:hs', 'pw')),
      ).rejects.toThrow('stop');
      expect(names(loginRequest)).toEqual(['Trinity']);
    });

    it('names password and SSO sign-ins after the host app', async () => {
      vi.spyOn(
        TestBed.inject(HostAuthenticationHandoffService),
        'deviceDisplayName',
      ).mockReturnValue('Trinity Next');
      const loginRequest = vi.fn().mockRejectedValue(new Error('stop'));
      createClientMock.mockReturnValue({ loginRequest } as never);
      await expect(
        firstValueFrom(auth.loginWithPassword('https://hs', '@me:hs', 'pw')),
      ).rejects.toThrow('stop');
      await expect(
        firstValueFrom(auth.completeSsoLogin('https://hs', 'login-token')),
      ).rejects.toThrow('stop');
      expect(names(loginRequest)).toEqual(['Trinity Next', 'Trinity Next']);
    });
  });
});
