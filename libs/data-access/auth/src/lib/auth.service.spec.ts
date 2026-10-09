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

import { MatrixError, createClient } from 'matrix-js-sdk';
import {
  AccountRuntimeService,
  type AccountEstablishmentOutcome,
} from '@trinity/data-access/accounts';
import { AUTH_METADATA } from './auth-metadata.fixture';
import { AuthService } from './auth.service';
import { ReauthAccountMismatchError } from './account-establishment';
import {
  NEW_DEVICE_SIGN_IN,
  NewDeviceSignInCancelledError,
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

    it('returns null for a non-OIDC (password/SSO) account', async () => {
      const storage = TestBed.inject(SessionStorageService);
      vi.mocked(storage.load).mockReturnValue(
        of({ ...oidcSession, oidc: undefined }) as never,
      );

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
        auth.loginWithPassword('https://other.example', '@me:hs', 'pw'),
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
});
