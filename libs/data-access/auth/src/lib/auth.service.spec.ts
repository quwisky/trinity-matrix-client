import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stub only the two SDK entry points AuthService touches for discovery/SSO,
// keeping every other real export so the sibling core services still load.
vi.mock('matrix-js-sdk', async (importActual) => {
  const actual = await importActual<typeof import('matrix-js-sdk')>();
  return {
    ...actual,
    AutoDiscovery: { ...actual.AutoDiscovery, findClientConfig: vi.fn() },
    createClient: vi.fn(),
  };
});

import { AutoDiscovery, MatrixError, createClient } from 'matrix-js-sdk';
import { AccountRuntimeService } from '@trinity/data-access/accounts';
import { AUTH_METADATA } from './auth-metadata.fixture';
import { AuthService } from './auth.service';
import {
  OidcClientService,
  type OidcGrantContext,
} from './oidc-client.service';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { SessionStorageService } from '@trinity/platform-native';

const findClientConfig = vi.mocked(AutoDiscovery.findClientConfig);
const createClientMock = vi.mocked(createClient);

function homeserver(state: string, base_url?: string) {
  return { 'm.homeserver': { state, base_url } } as never;
}

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
      ],
    });
    auth = TestBed.inject(AuthService);
    vi.mocked(TestBed.inject(SessionStorageService).load).mockReturnValue(
      of(null),
    );
  });

  describe('discoverHomeserver', () => {
    it('returns the discovered base_url with a trailing slash stripped', async () => {
      findClientConfig.mockResolvedValue(
        homeserver(AutoDiscovery.SUCCESS, 'https://hs.example/'),
      );
      expect(await firstValueFrom(auth.discoverHomeserver('example.org'))).toBe(
        'https://hs.example',
      );
    });

    it('falls back to https://<domain> when discovery yields no base_url', async () => {
      findClientConfig.mockResolvedValue(
        homeserver(AutoDiscovery.SUCCESS, undefined),
      );
      expect(await firstValueFrom(auth.discoverHomeserver('matrix.org'))).toBe(
        'https://matrix.org',
      );
    });

    it('extracts the domain from a full MXID before discovery', async () => {
      findClientConfig.mockResolvedValue(
        homeserver(AutoDiscovery.SUCCESS, 'https://hs'),
      );
      await firstValueFrom(auth.discoverHomeserver('@me:example.org'));
      expect(findClientConfig).toHaveBeenCalledWith('example.org');
    });

    it('throws when discovery fails (FAIL_PROMPT)', async () => {
      findClientConfig.mockResolvedValue(homeserver(AutoDiscovery.FAIL_PROMPT));
      await expect(
        firstValueFrom(auth.discoverHomeserver('nope.invalid')),
      ).rejects.toThrow();
    });

    it('declares the probe domain AND the resolved base_url to the desktop CORS shim', async () => {
      // Desktop only: discovery and the login that follows reach a homeserver BEFORE
      // any account exists to declare it, so main's CORS shim would otherwise refuse to
      // serve those origins. The resolved base_url may differ from the typed domain, and
      // login POSTs to base_url — so both must be allowed.
      const allowOrigin = vi.fn();
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop = {
        cors: { allowOrigin, setAllowedOrigins: vi.fn() },
      };
      try {
        findClientConfig.mockResolvedValue(
          homeserver(AutoDiscovery.SUCCESS, 'https://matrix.example/'),
        );

        await firstValueFrom(auth.discoverHomeserver('example.org'));

        expect(allowOrigin).toHaveBeenCalledWith('https://example.org');
        expect(allowOrigin).toHaveBeenCalledWith('https://matrix.example');
      } finally {
        delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
      }
    });

    it('does not touch the bridge off desktop (no trinityDesktop global)', async () => {
      // The bridge is absent on web/native; discovery must not assume it exists.
      delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
      findClientConfig.mockResolvedValue(
        homeserver(AutoDiscovery.SUCCESS, 'https://hs.example'),
      );

      await expect(
        firstValueFrom(auth.discoverHomeserver('example.org')),
      ).resolves.toBe('https://hs.example');
    });
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
      ).rejects.toThrow(/@other:hs/);

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

    await firstValueFrom(auth.forgetOidcClientId('https://op'));

    expect(oidc.forgetClientId).toHaveBeenCalledWith('https://op');
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

      // First attempt carries no auth; other sessions stay signed in (false).
      expect(client.setPassword).toHaveBeenCalledWith(
        {},
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
});
