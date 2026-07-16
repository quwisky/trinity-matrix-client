import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// In-memory @capacitor/preferences (hoisted so the vi.mock factory can see it).
const { prefs } = vi.hoisted(() => ({ prefs: new Map<string, string>() }));
vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: async ({ key }: { key: string }) => ({
      value: prefs.get(key) ?? null,
    }),
    set: async ({ key, value }: { key: string; value: string }) => {
      prefs.set(key, value);
    },
    remove: async ({ key }: { key: string }) => {
      prefs.delete(key);
    },
  },
}));

// Stub only the OIDC SDK entry points the service touches; keep everything else real.
vi.mock('matrix-js-sdk', async (importActual) => {
  const actual = await importActual<typeof import('matrix-js-sdk')>();
  return {
    ...actual,
    createClient: vi.fn(),
    registerOidcClient: vi.fn(),
    generateOidcAuthorizationUrl: vi.fn(),
    completeAuthorizationCodeGrant: vi.fn(),
    discoverAndValidateOIDCIssuerWellKnown: vi.fn(),
  };
});

import {
  completeAuthorizationCodeGrant,
  createClient,
  discoverAndValidateOIDCIssuerWellKnown,
  generateOidcAuthorizationUrl,
  registerOidcClient,
  type OidcClientConfig,
} from 'matrix-js-sdk';
import { OidcClientService } from './oidc-client.service';

const registerOidcClientMock = vi.mocked(registerOidcClient);
const generateUrlMock = vi.mocked(generateOidcAuthorizationUrl);
const completeGrantMock = vi.mocked(completeAuthorizationCodeGrant);
const createClientMock = vi.mocked(createClient);
const discoverMock = vi.mocked(discoverAndValidateOIDCIssuerWellKnown);

const CONFIG = { issuer: 'https://op.example' } as unknown as OidcClientConfig;
const BINDING = {
  issuer: 'https://op.example',
  clientId: 'client-123',
  redirectUri: 'https://app/sso-callback',
  idTokenClaims: {
    iss: 'https://op.example',
    sub: 'u',
    aud: 'client-123',
    exp: 1,
    iat: 0,
  },
};

describe('OidcClientService', () => {
  let svc: OidcClientService;

  beforeEach(() => {
    vi.clearAllMocks();
    prefs.clear();
    sessionStorage.clear();
    TestBed.configureTestingModule({ providers: [OidcClientService] });
    svc = TestBed.inject(OidcClientService);
  });

  describe('buildAuthorizationRequest', () => {
    it('registers the client, harvests the SDK state + PKCE blob from sessionStorage', async () => {
      registerOidcClientMock.mockResolvedValue('client-123');
      generateUrlMock.mockImplementation(async () => {
        // The SDK writes the sign-in state (with the code_verifier) to sessionStorage.
        sessionStorage.setItem('mx_oidc_STATEXYZ', 'SIGNIN_BLOB');
        return 'https://op.example/authorize?client_id=client-123&state=STATEXYZ';
      });

      const request = await firstValueFrom(
        svc.buildAuthorizationRequest({
          baseUrl: 'https://hs.example',
          config: CONFIG,
          redirectUri: 'https://app/sso-callback',
          applicationType: 'web',
          nonce: 'NONCE',
        }),
      );

      expect(request.state).toBe('STATEXYZ'); // parsed from the URL, not our nonce
      expect(request.sessionStateKey).toBe('mx_oidc_STATEXYZ');
      expect(request.sessionStateBlob).toBe('SIGNIN_BLOB');
      // Registered as `web` with exactly the given redirect uri.
      expect(registerOidcClientMock).toHaveBeenCalledWith(
        CONFIG,
        expect.objectContaining({
          applicationType: 'web',
          redirectUris: ['https://app/sso-callback'],
        }),
      );
    });

    it('caches the registered client id per issuer (no re-registration)', async () => {
      registerOidcClientMock.mockResolvedValue('client-123');
      generateUrlMock.mockResolvedValue('https://op.example/authorize?state=S');
      const params = {
        baseUrl: 'https://hs.example',
        config: CONFIG,
        redirectUri: 'https://app/sso-callback',
        applicationType: 'web' as const,
        nonce: 'N',
      };

      await firstValueFrom(svc.buildAuthorizationRequest(params));
      await firstValueFrom(svc.buildAuthorizationRequest(params));

      expect(registerOidcClientMock).toHaveBeenCalledTimes(1); // second call used the cache
      expect(prefs.get('oidc.clientId.v2:https://op.example')).toBe(
        'client-123',
      );
    });

    it('harvests the sign-in state via the fallback scan when the SDK key prefix differs', async () => {
      registerOidcClientMock.mockResolvedValue('client-123');
      generateUrlMock.mockImplementation(async () => {
        // A hypothetical future oidc-client-ts prefix — NOT the exact mx_oidc_<state> key,
        // so only the prefix-scan fallback (endsWith(state)) can find it.
        sessionStorage.setItem('mx_oidc_v2_STATEXYZ', 'FALLBACK_BLOB');
        return 'https://op.example/authorize?state=STATEXYZ';
      });

      const request = await firstValueFrom(
        svc.buildAuthorizationRequest({
          baseUrl: 'https://hs.example',
          config: CONFIG,
          redirectUri: 'https://app/sso-callback',
          applicationType: 'web',
          nonce: 'N',
        }),
      );

      expect(request.state).toBe('STATEXYZ');
      expect(request.sessionStateKey).toBe('mx_oidc_v2_STATEXYZ');
      expect(request.sessionStateBlob).toBe('FALLBACK_BLOB');
    });
  });

  describe('completeGrant', () => {
    const grant = {
      oidcClientSettings: {
        clientId: 'client-123',
        issuer: 'https://op.example',
      },
      tokenResponse: {
        token_type: 'Bearer',
        access_token: 'access-tok',
        refresh_token: 'refresh-tok',
        expires_at: 1_700_000_000, // epoch SECONDS
        id_token: 'id-tok',
        scope: 'openid',
      },
      homeserverUrl: 'https://hs.example',
      idTokenClaims: { sub: 'u', iss: 'https://op.example' },
    };

    it('exchanges the code, resolves identity via whoami, and builds the binding', async () => {
      completeGrantMock.mockResolvedValue(grant as never);
      const whoami = vi
        .fn()
        .mockResolvedValue({ user_id: '@me:hs', device_id: 'DEV42' });
      createClientMock.mockReturnValue({ whoami } as never);

      const result = await firstValueFrom(
        svc.completeGrant('CODE', 'STATE', 'https://app/sso-callback'),
      );

      expect(completeGrantMock).toHaveBeenCalledWith('CODE', 'STATE');
      expect(result).toMatchObject({
        homeserverUrl: 'https://hs.example',
        userId: '@me:hs',
        deviceId: 'DEV42',
        accessToken: 'access-tok',
        refreshToken: 'refresh-tok',
        accessTokenExpiresAt: 1_700_000_000_000, // seconds → ms
        oidc: {
          issuer: 'https://op.example',
          clientId: 'client-123',
          redirectUri: 'https://app/sso-callback',
          idTokenClaims: grant.idTokenClaims,
        },
      });
    });

    it('rejects when the provider returns no device for the session', async () => {
      completeGrantMock.mockResolvedValue(grant as never);
      createClientMock.mockReturnValue({
        whoami: vi.fn().mockResolvedValue({ user_id: '@me:hs' }), // no device_id
      } as never);

      await expect(
        firstValueFrom(
          svc.completeGrant('CODE', 'STATE', 'https://app/sso-callback'),
        ),
      ).rejects.toThrow(/no device/i);
    });

    it('computes expiry from expires_in when expires_at is absent', async () => {
      completeGrantMock.mockResolvedValue({
        ...grant,
        tokenResponse: {
          token_type: 'Bearer',
          access_token: 'a',
          refresh_token: 'r',
          expires_in: 300, // seconds, relative
          id_token: 'i',
          scope: 'openid',
        },
      } as never);
      createClientMock.mockReturnValue({
        whoami: vi
          .fn()
          .mockResolvedValue({ user_id: '@me:hs', device_id: 'D' }),
      } as never);

      const before = Date.now();
      const result = await firstValueFrom(
        svc.completeGrant('C', 'S', 'https://app/cb'),
      );

      expect(result.accessTokenExpiresAt).toBeGreaterThanOrEqual(
        before + 300_000,
      );
      expect(result.accessTokenExpiresAt).toBeLessThanOrEqual(
        Date.now() + 300_000,
      );
    });

    it('omits refreshToken and expiry when the provider returns neither', async () => {
      completeGrantMock.mockResolvedValue({
        ...grant,
        tokenResponse: {
          token_type: 'Bearer',
          access_token: 'a',
          id_token: 'i',
          scope: 'openid',
        },
      } as never);
      createClientMock.mockReturnValue({
        whoami: vi
          .fn()
          .mockResolvedValue({ user_id: '@me:hs', device_id: 'D' }),
      } as never);

      const result = await firstValueFrom(
        svc.completeGrant('C', 'S', 'https://app/cb'),
      );

      expect(result.refreshToken).toBeUndefined();
      expect(result.accessTokenExpiresAt).toBeUndefined();
    });
  });

  describe('revokeTokens', () => {
    it('POSTs a revocation for each token to the discovered endpoint', async () => {
      discoverMock.mockResolvedValue({
        revocation_endpoint: 'https://op.example/revoke',
      } as never);
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      try {
        await firstValueFrom(
          svc.revokeTokens(BINDING, { accessToken: 'a', refreshToken: 'r' }),
        );

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const bodies = fetchMock.mock.calls.map((c) => String(c[1].body));
        expect(fetchMock.mock.calls[0][0]).toBe('https://op.example/revoke');
        expect(
          bodies.some(
            (b) => b.includes('token=r') && b.includes('refresh_token'),
          ),
        ).toBe(true);
        expect(
          bodies.some(
            (b) => b.includes('token=a') && b.includes('access_token'),
          ),
        ).toBe(true);
        expect(bodies.every((b) => b.includes('client_id=client-123'))).toBe(
          true,
        );
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('resolves void when discovery fails (never blocks logout)', async () => {
      discoverMock.mockRejectedValue(new Error('metadata unavailable'));

      await expect(
        firstValueFrom(svc.revokeTokens(BINDING, { refreshToken: 'r' })),
      ).resolves.toBeUndefined();
    });

    it('does not POST when the provider metadata has no revocation_endpoint', async () => {
      discoverMock.mockResolvedValue({} as never); // no revocation_endpoint
      const fetchMock = vi.fn();
      vi.stubGlobal('fetch', fetchMock);
      try {
        await expect(
          firstValueFrom(svc.revokeTokens(BINDING, { refreshToken: 'r' })),
        ).resolves.toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('revokes only the token provided (single-token) with its type hint', async () => {
      discoverMock.mockResolvedValue({
        revocation_endpoint: 'https://op.example/revoke',
      } as never);
      const fetchMock = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', fetchMock);
      try {
        await firstValueFrom(
          svc.revokeTokens(BINDING, { refreshToken: 'only-refresh' }),
        );
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const body = String(fetchMock.mock.calls[0][1].body);
        expect(body).toContain('token=only-refresh');
        expect(body).toContain('token_type_hint=refresh_token');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('resolves void when a revocation POST rejects (best-effort)', async () => {
      discoverMock.mockResolvedValue({
        revocation_endpoint: 'https://op.example/revoke',
      } as never);
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('down')));
      try {
        await expect(
          firstValueFrom(
            svc.revokeTokens(BINDING, { accessToken: 'a', refreshToken: 'r' }),
          ),
        ).resolves.toBeUndefined();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });

  describe('forgetClientId', () => {
    it('removes the cached client id so the next login re-registers', async () => {
      prefs.set('oidc.clientId.v2:https://op.example', 'client-123');

      await firstValueFrom(svc.forgetClientId('https://op.example'));

      expect(prefs.get('oidc.clientId.v2:https://op.example')).toBeUndefined();
    });
  });
});
