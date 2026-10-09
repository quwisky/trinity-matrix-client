import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Stub ONLY the client factory (the homeserver round-trips: auth-metadata discovery and
// whoami). `OAuth2` deliberately stays real: since matrix-js-sdk 42 it drives the whole
// OAuth exchange itself over global `fetch`, so stubbing `fetch` instead lets these specs
// exercise the actual protocol — the PKCE challenge, the wire parameters and the
// response_mode — rather than our own idea of it.
vi.mock('matrix-js-sdk', async (importActual) => {
  const actual = await importActual<typeof import('matrix-js-sdk')>();
  return { ...actual, createClient: vi.fn() };
});

import {
  createClient,
  encodeUnpaddedBase64Url,
  isValidAuthMetadata,
} from 'matrix-js-sdk';
import { AUTH_METADATA } from './auth-metadata.fixture';
import {
  OidcClientService,
  type OidcAuthorizationParams,
  type OidcGrantContext,
} from './oidc-client.service';

const createClientMock = vi.mocked(createClient);

/** The account's own homeserver — discovery goes through its auth metadata. */
const HOMESERVER = 'https://hs.example';
const REDIRECT_URI = 'https://app/sso-callback';
const CLIENT_ID = 'client-123';
/** Where the dynamic-registration client id is cached (prefix + homeserver + issuer). */
const CLIENT_ID_KEY = 'oidc.clientId.v3:https://hs.example https://op.example';

const PARAMS: OidcAuthorizationParams = {
  baseUrl: HOMESERVER,
  metadata: AUTH_METADATA,
  redirectUri: REDIRECT_URI,
  applicationType: 'web',
};

/** The stash written when the request was built, replayed to complete the grant. */
const CONTEXT: OidcGrantContext = {
  baseUrl: HOMESERVER,
  redirectUri: REDIRECT_URI,
  clientId: CLIENT_ID,
  deviceId: 'DEV42',
  codeVerifier: 'code-verifier-from-the-stash',
  issuer: AUTH_METADATA.issuer,
};

const WHOAMI = { user_id: '@me:hs', device_id: 'DEV42' };

const BINDING = {
  issuer: AUTH_METADATA.issuer,
  clientId: CLIENT_ID,
  redirectUri: REDIRECT_URI,
};

/**
 * Stub the SDK client factory. `getAuthMetadata()` is how both `completeGrant` and
 * `revokeTokens` discover the provider (pass an Error to make discovery reject);
 * `whoami()` is how `completeGrant` resolves the account identity.
 */
function stubClient({
  metadata = AUTH_METADATA as unknown,
  whoami,
}: {
  metadata?: unknown;
  whoami?: { user_id: string; device_id?: string } | Error;
} = {}): void {
  createClientMock.mockReturnValue({
    getAuthMetadata:
      metadata instanceof Error
        ? vi.fn().mockRejectedValue(metadata)
        : vi.fn().mockResolvedValue(metadata),
    whoami:
      whoami instanceof Error
        ? vi.fn().mockRejectedValue(whoami)
        : vi.fn().mockResolvedValue(whoami),
  } as never);
}

/** The three provider endpoints the real `OAuth2` POSTs to, keyed by role. */
const ENDPOINTS = {
  registration: AUTH_METADATA.registration_endpoint,
  token: AUTH_METADATA.token_endpoint,
  revocation: AUTH_METADATA.revocation_endpoint,
} as const;

type Handler = (init: RequestInit) => unknown;

/** Minimal stand-in for a `Response`: the SDK reads only these three members. */
const jsonResponse = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(),
  json: async () => body,
});

/** The issuer's own discovery documents (RFC 8414 first, then OpenID Connect). */
const RFC8414_DISCOVERY =
  'https://op.example/.well-known/oauth-authorization-server';
const OIDC_DISCOVERY = 'https://op.example/.well-known/openid-configuration';

/**
 * Route `globalThis.fetch` to a fake provider so the real `OAuth2` runs end to end.
 * An unrouted endpoint throws rather than silently resolving, so a stray request can't
 * hide inside the best-effort `catchError` on the revocation path. `byUrl` routes any
 * other URL, such as the issuer's discovery documents. Unless a test routes them, both
 * discovery documents answer 404, so the exchange takes the no-discovery path on purpose.
 */
function stubFetch(
  routes: Partial<Record<keyof typeof ENDPOINTS, Handler>>,
  byUrl: Record<string, Handler> = {},
) {
  const urls: Record<string, Handler> = {
    [RFC8414_DISCOVERY]: () => jsonResponse({}, 404),
    [OIDC_DISCOVERY]: () => jsonResponse({}, 404),
    ...byUrl,
  };
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const role = (Object.keys(ENDPOINTS) as (keyof typeof ENDPOINTS)[]).find(
      (name) => ENDPOINTS[name] === url,
    );
    const handler = (role && routes[role]) || urls[url];
    if (!handler) {
      throw new Error(`unexpected fetch to ${url}`);
    }
    return handler(init);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const jsonBody = (init: RequestInit): Record<string, unknown> =>
  JSON.parse(String(init.body));
const formBody = (init: RequestInit): URLSearchParams =>
  new URLSearchParams(String(init.body));
const tokenPosts = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.filter(([url]) => url === AUTH_METADATA.token_endpoint);

/** The PKCE challenge a given verifier must produce (RFC 7636 S256). */
async function challengeFor(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(codeVerifier),
  );
  return encodeUnpaddedBase64Url(new Uint8Array(digest));
}

describe('OidcClientService', () => {
  let svc: OidcClientService;
  // Restore only `fetch`: vi.unstubAllGlobals() would also drop the matchMedia /
  // PointerEvent stubs test-setup.base installs once for the whole file.
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    prefs.clear();
    TestBed.configureTestingModule({ providers: [OidcClientService] });
    svc = TestBed.inject(OidcClientService);
  });

  afterEach(() => {
    vi.stubGlobal('fetch', realFetch);
  });

  it('uses a fixture the SDK itself accepts as valid auth metadata', () => {
    // The single highest-value assertion in the matrix-js-sdk 42 migration. Every
    // metadata object reaching this service in production comes from
    // `MatrixClient.getAuthMetadata()`, which runs this exact guard and throws on
    // failure — so if a future release tightens the contract (42 already added
    // revocation_endpoint, registration_endpoint and the response_modes/grant_types
    // requirements), this fails here instead of every spec below passing against a
    // config the app could never be handed.
    expect(isValidAuthMetadata(AUTH_METADATA)).toBe(true);
  });

  describe('buildAuthorizationRequest', () => {
    it('registers this client with the provider (snake_case wire shape)', async () => {
      const fetchMock = stubFetch({
        registration: () => jsonResponse({ client_id: CLIENT_ID }),
      });

      const request = await firstValueFrom(
        svc.buildAuthorizationRequest(PARAMS),
      );

      expect(request.clientId).toBe(CLIENT_ID);
      expect(fetchMock.mock.calls[0][0]).toBe(
        AUTH_METADATA.registration_endpoint,
      );
      // Registered as `web` with exactly the given redirect uri. The keys are the v42
      // break: registration now takes the wire body verbatim, where v41 took a
      // camelCase wrapper (applicationType / redirectUris).
      expect(jsonBody(fetchMock.mock.calls[0][1])).toMatchObject({
        client_name: 'Trinity',
        client_uri: 'https://trinity.qwky.eu',
        application_type: 'web',
        redirect_uris: [REDIRECT_URI],
      });
    });

    it('hands back the PKCE context bound to the URL it generated', async () => {
      // Replaces the old "harvest mx_oidc_<state> out of sessionStorage" coverage:
      // v42 persists nothing, so the caller is handed the verifier and device id
      // directly and is their sole custodian. What still has to hold is the binding —
      // the verifier returned must be the one the challenge in the URL derives from,
      // or the token exchange later fails at the provider with an opaque PKCE error.
      stubFetch({ registration: () => jsonResponse({ client_id: CLIENT_ID }) });

      const request = await firstValueFrom(
        svc.buildAuthorizationRequest(PARAMS),
      );

      const url = new URL(request.url);
      expect(`${url.origin}${url.pathname}`).toBe(
        AUTH_METADATA.authorization_endpoint,
      );
      expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
      expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(url.searchParams.get('response_type')).toBe('code');
      expect(url.searchParams.get('state')).toBe(request.state);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('code_challenge')).toBe(
        await challengeFor(request.codeVerifier),
      );
      // The device id is likewise only recoverable from the stash — it is what the
      // requested scope pins the session to.
      expect(url.searchParams.get('scope')).toContain(
        `urn:matrix:client:device:${request.deviceId}`,
      );
    });

    it('asks the provider for response_mode=query', async () => {
      // LOAD-BEARING, and a live regression risk: v42 defaults responseMode to
      // 'fragment' (v41 defaulted to 'query'), while every callback reader in this app
      // parses query params only. Taking the default would put the code somewhere
      // nothing looks and hang login on every platform.
      stubFetch({ registration: () => jsonResponse({ client_id: CLIENT_ID }) });

      const request = await firstValueFrom(
        svc.buildAuthorizationRequest(PARAMS),
      );

      expect(new URL(request.url).searchParams.get('response_mode')).toBe(
        'query',
      );
    });

    it('re-authenticates a supplied device instead of minting a new one', async () => {
      // The re-auth flow recovers a soft-logged-out account WITHOUT the user verifying a
      // fresh device. matrix-js-sdk 41 could not express it (its authorize helper took no
      // device id and always generated one); v42's OAuth2 context accepts one, and the
      // requested scope is where it actually reaches the provider.
      stubFetch({ registration: () => jsonResponse({ client_id: CLIENT_ID }) });

      const request = await firstValueFrom(
        svc.buildAuthorizationRequest({ ...PARAMS, deviceId: 'OLDDEV' }),
      );

      expect(request.deviceId).toBe('OLDDEV');
      expect(new URL(request.url).searchParams.get('scope') ?? '').toContain(
        'urn:matrix:client:device:OLDDEV',
      );
    });

    it('mints a device when none is supplied (ordinary login)', async () => {
      stubFetch({ registration: () => jsonResponse({ client_id: CLIENT_ID }) });

      const request = await firstValueFrom(
        svc.buildAuthorizationRequest(PARAMS),
      );

      expect(request.deviceId).toBeTruthy();
      expect(request.deviceId).not.toBe('OLDDEV');
    });

    it('puts redirect_uri, response_mode and prompt each in its own parameter', async () => {
      // matrix-js-sdk 43 moved redirect_uri out of the OAuth2 context into the 2nd
      // positional argument of generateAuthorizationCodeGrantUrl(state, redirectUri,
      // responseMode, prompt). `(state, 'query')` still typechecks and would send
      // redirect_uri=query with the default `fragment` response mode, where no callback
      // reader in this app looks.
      stubFetch({ registration: () => jsonResponse({ client_id: CLIENT_ID }) });

      const request = await firstValueFrom(
        svc.buildAuthorizationRequest({ ...PARAMS, prompt: 'create' }),
      );

      const params = new URL(request.url).searchParams;
      expect(params.get('redirect_uri')).toBe(REDIRECT_URI);
      expect(params.get('response_mode')).toBe('query');
      expect(params.get('prompt')).toBe('create');
    });

    it('caches the registered client id per issuer (no re-registration)', async () => {
      const fetchMock = stubFetch({
        registration: () => jsonResponse({ client_id: CLIENT_ID }),
      });

      await firstValueFrom(svc.buildAuthorizationRequest(PARAMS));
      await firstValueFrom(svc.buildAuthorizationRequest(PARAMS));

      expect(fetchMock).toHaveBeenCalledTimes(1); // second call used the cache
      expect(prefs.get(CLIENT_ID_KEY)).toBe(CLIENT_ID);
    });

    it('keeps a separate client id for each homeserver naming the same issuer', async () => {
      // A homeserver chooses the issuer it names, so a cache keyed on the issuer alone
      // would let one homeserver's registration be reused by another's sign-in.
      let registered = 0;
      const fetchMock = stubFetch({
        registration: () =>
          jsonResponse({ client_id: `client-${++registered}` }),
      });
      const other = { ...PARAMS, baseUrl: 'https://other-hs.example' };

      const first = await firstValueFrom(svc.buildAuthorizationRequest(PARAMS));
      const second = await firstValueFrom(svc.buildAuthorizationRequest(other));
      const again = await firstValueFrom(svc.buildAuthorizationRequest(PARAMS));

      expect(first.clientId).toBe('client-1');
      expect(second.clientId).toBe('client-2');
      expect(again.clientId).toBe('client-1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('ignores a client id cached under the issuer alone by an earlier version', async () => {
      prefs.set('oidc.clientId.v2:https://op.example', 'client-from-v2');
      const fetchMock = stubFetch({
        registration: () => jsonResponse({ client_id: CLIENT_ID }),
      });

      const request = await firstValueFrom(
        svc.buildAuthorizationRequest(PARAMS),
      );

      expect(request.clientId).toBe(CLIENT_ID);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('completeGrant', () => {
    const TOKEN = {
      token_type: 'Bearer',
      access_token: 'access-tok',
      refresh_token: 'refresh-tok',
      expires_in: 300, // seconds, relative — v42 responses carry no expires_at
      scope: 'urn:matrix:client:api:*',
    };

    it('replays the stashed verifier, resolves identity via whoami, and builds the binding', async () => {
      stubClient({ whoami: WHOAMI });
      const fetchMock = stubFetch({ token: () => jsonResponse(TOKEN) });

      const result = await firstValueFrom(svc.completeGrant('CODE', CONTEXT));

      // Discovery and whoami both go through the account's OWN homeserver; whoami is
      // authenticated with the token that was just minted.
      expect(createClientMock).toHaveBeenCalledWith({ baseUrl: HOMESERVER });
      expect(createClientMock).toHaveBeenCalledWith({
        baseUrl: HOMESERVER,
        accessToken: 'access-tok',
      });
      // The token POST carries the PKCE verifier out of the stash — nothing else has a
      // copy since v42 dropped oidc-client-ts, so this is what makes a callback in a
      // different browsing context (native / Electron) completable at all.
      expect(tokenPosts(fetchMock)).toHaveLength(1);
      expect(Object.fromEntries(formBody(tokenPosts(fetchMock)[0][1]))).toEqual(
        {
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          code_verifier: CONTEXT.codeVerifier,
          redirect_uri: REDIRECT_URI,
          code: 'CODE',
        },
      );
      // toEqual, not toMatchObject: the binding must NOT carry idTokenClaims any more
      // (no id_token exists in v42), and the issuer comes from discovery, not the stash.
      expect(result).toEqual({
        homeserverUrl: HOMESERVER,
        userId: '@me:hs',
        deviceId: 'DEV42',
        accessToken: 'access-tok',
        refreshToken: 'refresh-tok',
        accessTokenExpiresAt: expect.any(Number),
        oidc: BINDING,
      });
    });

    it('rejects when the provider returns no device for the session', async () => {
      stubClient({ whoami: { user_id: '@me:hs' } }); // no device_id
      stubFetch({
        token: () => jsonResponse(TOKEN),
        revocation: () => jsonResponse({}),
      });

      await expect(
        firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
      ).rejects.toThrow(/no device/i);
    });

    it('hands back the tokens it just minted when identity lookup fails', async () => {
      // By the time whoami runs, the code is spent and the callback page has already
      // cleared the stash — this grant can never be completed. But the tokens are live,
      // and under MSC3861 the OAuth session IS the Matrix device: dropping them leaves a
      // ghost device the user can only remove from the provider's own account page, plus
      // a long-lived refresh token nothing will ever use. Every retry adds another.
      stubClient({ whoami: new Error('homeserver unavailable') });
      const fetchMock = stubFetch({
        token: () => jsonResponse(TOKEN),
        revocation: () => jsonResponse({}),
      });

      // The user still gets the real failure, not a revocation error.
      await expect(
        firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
      ).rejects.toThrow(/homeserver unavailable/);

      const bodies = fetchMock.mock.calls
        .filter(([url]) => url === AUTH_METADATA.revocation_endpoint)
        .map(([, init]) => formBody(init));
      expect(bodies.map((body) => body.get('token')).sort()).toEqual([
        'access-tok',
        'refresh-tok',
      ]);
    });

    it('reports the failure without waiting for the revocation to settle', async () => {
      // The revocation POSTs go to the PROVIDER, a different host from the homeserver
      // that just failed, through `OAuth2.fetch` — which passes no AbortSignal and no
      // timeout. Gating the error on them would leave the callback page on its spinner,
      // whose only exit ("Back to sign in") lives in the error branch, for a full TCP
      // connect timeout — or forever against a host that black-holes the connection.
      stubClient({ whoami: new Error('homeserver unavailable') });
      const fetchMock = stubFetch({
        token: () => jsonResponse(TOKEN),
        revocation: () => new Promise(() => undefined), // never settles
      });

      await expect(
        firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
      ).rejects.toThrow(/homeserver unavailable/);

      // Still fired, just not awaited.
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => url === AUTH_METADATA.revocation_endpoint,
        ),
      ).toHaveLength(2);
    });

    it('still surfaces the original failure when the revocation also fails', async () => {
      // Best-effort, and it genuinely does fail against a compliant provider: RFC 7009
      // mandates an empty 200 body, which the SDK's shared `res.json()` chokes on. A
      // revocation error must never displace the error the user needs to see.
      stubClient({ whoami: new Error('homeserver unavailable') });
      const fetchMock = stubFetch({
        token: () => jsonResponse(TOKEN),
        revocation: () => {
          throw new Error('revocation down');
        },
      });

      await expect(
        firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
      ).rejects.toThrow(/homeserver unavailable/);
      // Assert the revocation was actually attempted, or this passes just as happily
      // against no revocation at all — which is the thing the sibling test exists for.
      expect(
        fetchMock.mock.calls.filter(
          ([url]) => url === AUTH_METADATA.revocation_endpoint,
        ).length,
      ).toBeGreaterThan(0);
    });

    it('derives the expiry from expires_in, stamped before the token request', async () => {
      // v42's BearerTokenResponse carries only the relative `expires_in`. Reading the
      // clock AFTER the round-trip would over-state the lifetime by the round-trip, so
      // the delay below separates the two bounds: only a timestamp taken before the
      // POST satisfies the upper one.
      let tokenRequestAt = 0;
      stubClient({ whoami: WHOAMI });
      stubFetch({
        token: async () => {
          tokenRequestAt = Date.now();
          await new Promise((resolve) => setTimeout(resolve, 50));
          return jsonResponse({ ...TOKEN, expires_in: 300 });
        },
      });

      const before = Date.now();
      const result = await firstValueFrom(svc.completeGrant('CODE', CONTEXT));

      expect(result.accessTokenExpiresAt).toBeGreaterThanOrEqual(
        before + 300_000,
      );
      expect(result.accessTokenExpiresAt).toBeLessThanOrEqual(
        tokenRequestAt + 300_000,
      );
    });

    it('omits refreshToken and expiry when the provider returns neither', async () => {
      stubClient({ whoami: WHOAMI });
      stubFetch({
        token: () =>
          jsonResponse({ token_type: 'Bearer', access_token: 'access-tok' }),
      });

      const result = await firstValueFrom(svc.completeGrant('CODE', CONTEXT));

      expect(result.refreshToken).toBeUndefined();
      expect(result.accessTokenExpiresAt).toBeUndefined();
    });
  });

  describe('checks that the sign-in response comes from the provider it started with', () => {
    const TOKEN = { token_type: 'Bearer', access_token: 'access-tok' };
    const PROVIDER_ERROR = /sign-in provider/i;

    describe('the callback iss (RFC 9207)', () => {
      it('proceeds when iss names the provider the sign-in started with', async () => {
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch({ token: () => jsonResponse(TOKEN) });

        const result = await firstValueFrom(
          svc.completeGrant('CODE', { ...CONTEXT, iss: 'https://op.example' }),
        );

        expect(result.accessToken).toBe('access-tok');
        expect(tokenPosts(fetchMock)).toHaveLength(1);
      });

      it('refuses an iss from another provider without sending the code', async () => {
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch({ token: () => jsonResponse(TOKEN) });

        await expect(
          firstValueFrom(
            svc.completeGrant('CODE', {
              ...CONTEXT,
              iss: 'https://other-provider.example',
            }),
          ),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(fetchMock)).toHaveLength(0);
      });

      it('compares iss as an exact string, not as an equivalent URL', async () => {
        // RFC 9207 section 2.4: simple string comparison. A trailing slash is a
        // different issuer.
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch({ token: () => jsonResponse(TOKEN) });

        await expect(
          firstValueFrom(
            svc.completeGrant('CODE', {
              ...CONTEXT,
              iss: 'https://op.example/',
            }),
          ),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(fetchMock)).toHaveLength(0);
      });

      it('refuses a missing iss when the provider says it always sends one', async () => {
        stubClient({
          metadata: {
            ...AUTH_METADATA,
            authorization_response_iss_parameter_supported: true,
          },
          whoami: WHOAMI,
        });
        const fetchMock = stubFetch({ token: () => jsonResponse(TOKEN) });

        await expect(
          firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(fetchMock)).toHaveLength(0);
      });

      it('proceeds without iss when the provider does not say it sends one', async () => {
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch({ token: () => jsonResponse(TOKEN) });

        await firstValueFrom(svc.completeGrant('CODE', CONTEXT));

        expect(tokenPosts(fetchMock)).toHaveLength(1);
      });
    });

    it('refuses when the homeserver now names another issuer, without sending the code', async () => {
      // The metadata is fetched again at the callback. If it no longer names the issuer
      // the sign-in started with, its token endpoint is not that provider's.
      stubClient({
        metadata: {
          ...AUTH_METADATA,
          issuer: 'https://other-provider.example',
        },
        whoami: WHOAMI,
      });
      const fetchMock = stubFetch({ token: () => jsonResponse(TOKEN) });

      await expect(
        firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
      ).rejects.toThrow(PROVIDER_ERROR);
      expect(tokenPosts(fetchMock)).toHaveLength(0);
    });

    describe("the issuer's own discovery document", () => {
      it('proceeds when it agrees with the homeserver', async () => {
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          { [RFC8414_DISCOVERY]: () => jsonResponse(AUTH_METADATA) },
        );

        await firstValueFrom(svc.completeGrant('CODE', CONTEXT));

        expect(fetchMock).toHaveBeenCalledWith(
          RFC8414_DISCOVERY,
          expect.anything(),
        );
        expect(tokenPosts(fetchMock)).toHaveLength(1);
      });

      it('refuses when it names another token endpoint, without sending the code', async () => {
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          {
            [RFC8414_DISCOVERY]: () =>
              jsonResponse({
                ...AUTH_METADATA,
                token_endpoint: 'https://op.example/real-token',
              }),
          },
        );

        await expect(
          firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(fetchMock)).toHaveLength(0);
      });

      it('refuses when it names another authorization endpoint', async () => {
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          {
            [RFC8414_DISCOVERY]: () =>
              jsonResponse({
                ...AUTH_METADATA,
                authorization_endpoint: 'https://op.example/real-authorize',
              }),
          },
        );

        await expect(
          firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(fetchMock)).toHaveLength(0);
      });

      it('refuses when it names another revocation endpoint', async () => {
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          {
            [RFC8414_DISCOVERY]: () =>
              jsonResponse({
                ...AUTH_METADATA,
                revocation_endpoint: 'https://op.example/real-revoke',
              }),
          },
        );

        await expect(
          firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(fetchMock)).toHaveLength(0);
      });

      it('refuses when it names the issuer but no token endpoint', async () => {
        stubClient({ whoami: WHOAMI });
        const { token_endpoint: _omitted, ...withoutToken } = AUTH_METADATA;
        const fetchMock = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          { [RFC8414_DISCOVERY]: () => jsonResponse(withoutToken) },
        );

        await expect(
          firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(fetchMock)).toHaveLength(0);
      });

      it('accepts endpoints written with the default port or in another case', async () => {
        // Compared as parsed URLs: scheme and host are case-insensitive and :443 is the
        // https default, so these name the same endpoints as the homeserver's metadata.
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          {
            [RFC8414_DISCOVERY]: () =>
              jsonResponse({
                ...AUTH_METADATA,
                authorization_endpoint: 'HTTPS://OP.Example/authorize',
                token_endpoint: 'https://op.example:443/oauth2/token',
                revocation_endpoint: 'https://OP.EXAMPLE:443/oauth2/revoke',
              }),
          },
        );

        await firstValueFrom(svc.completeGrant('CODE', CONTEXT));

        expect(tokenPosts(fetchMock)).toHaveLength(1);
      });

      it('still refuses an endpoint that differs by a trailing slash', async () => {
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          {
            [RFC8414_DISCOVERY]: () =>
              jsonResponse({
                ...AUTH_METADATA,
                token_endpoint: 'https://op.example/oauth2/token/',
              }),
          },
        );

        await expect(
          firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(fetchMock)).toHaveLength(0);
      });

      it('refuses an endpoint that is not a URL', async () => {
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          {
            [RFC8414_DISCOVERY]: () =>
              jsonResponse({ ...AUTH_METADATA, token_endpoint: 'not a url' }),
          },
        );

        await expect(
          firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(fetchMock)).toHaveLength(0);
      });

      it('does not require a revocation endpoint the issuer does not publish', async () => {
        stubClient({ whoami: WHOAMI });
        const { revocation_endpoint: _omitted, ...withoutRevocation } =
          AUTH_METADATA;
        const fetchMock = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          { [RFC8414_DISCOVERY]: () => jsonResponse(withoutRevocation) },
        );

        await firstValueFrom(svc.completeGrant('CODE', CONTEXT));

        expect(tokenPosts(fetchMock)).toHaveLength(1);
      });

      it('falls back to the OpenID Connect document when RFC 8414 has none', async () => {
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          {
            [RFC8414_DISCOVERY]: () => jsonResponse({}, 404),
            [OIDC_DISCOVERY]: () =>
              jsonResponse({
                ...AUTH_METADATA,
                token_endpoint: 'https://op.example/real-token',
              }),
          },
        );

        await expect(
          firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(fetchMock)).toHaveLength(0);
      });

      it('resolves both documents against an issuer with a path, as the RFCs place them', async () => {
        // RFC 8414 section 3.1 inserts the well-known segment between host and path,
        // dropping a terminating "/"; OpenID Connect Discovery appends it to the issuer.
        const issuer = 'https://op.example/tenant/';
        stubClient({ metadata: { ...AUTH_METADATA, issuer }, whoami: WHOAMI });
        const elsewhere = () =>
          jsonResponse({
            ...AUTH_METADATA,
            issuer,
            token_endpoint: 'https://op.example/tenant/real-token',
          });
        const rfc8414 = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          {
            'https://op.example/.well-known/oauth-authorization-server/tenant':
              elsewhere,
          },
        );

        await expect(
          firstValueFrom(svc.completeGrant('CODE', { ...CONTEXT, issuer })),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(rfc8414)).toHaveLength(0);

        const openid = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          {
            'https://op.example/tenant/.well-known/openid-configuration':
              elsewhere,
          },
        );

        await expect(
          firstValueFrom(svc.completeGrant('CODE', { ...CONTEXT, issuer })),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(openid)).toHaveLength(0);
      });

      it('ignores a document that names another issuer (RFC 8414 section 3.3)', async () => {
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          {
            [RFC8414_DISCOVERY]: () =>
              jsonResponse({
                ...AUTH_METADATA,
                issuer: 'https://other-provider.example',
                token_endpoint: 'https://other-provider.example/token',
              }),
          },
        );

        await firstValueFrom(svc.completeGrant('CODE', CONTEXT));

        expect(tokenPosts(fetchMock)).toHaveLength(1);
      });

      it('falls through to the iss and issuer checks when it is unreachable', async () => {
        // Matrix does not require the issuer to publish its own discovery document; the
        // homeserver's metadata is the source the spec names.
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch(
          { token: () => jsonResponse(TOKEN) },
          {
            [RFC8414_DISCOVERY]: () => {
              throw new TypeError('Failed to fetch');
            },
            [OIDC_DISCOVERY]: () => {
              throw new TypeError('Failed to fetch');
            },
          },
        );

        const result = await firstValueFrom(
          svc.completeGrant('CODE', { ...CONTEXT, iss: 'https://op.example' }),
        );

        expect(result.accessToken).toBe('access-tok');
        expect(tokenPosts(fetchMock)).toHaveLength(1);
      });

      it('still checks iss when it is unreachable', async () => {
        stubClient({ whoami: WHOAMI });
        const fetchMock = stubFetch({ token: () => jsonResponse(TOKEN) });

        await expect(
          firstValueFrom(
            svc.completeGrant('CODE', {
              ...CONTEXT,
              iss: 'https://other-provider.example',
            }),
          ),
        ).rejects.toThrow(PROVIDER_ERROR);
        expect(tokenPosts(fetchMock)).toHaveLength(0);
      });
    });
  });

  describe('revokeTokens', () => {
    it('still revokes both tokens when the provider answers RFC 7009-style', async () => {
      // RFC 7009 s2.2 mandates 200 with an EMPTY body, but the SDK's shared fetch helper
      // ends with `return await res.json()` — so revokeToken always rejects against a
      // compliant provider. The POSTs are already in flight by then, so the tokens are
      // genuinely revoked and `revokeTokens` still resolves void via its best-effort
      // catch. Pinned here because the sibling test stubs a JSON body, which hides this
      // entirely, and because a future refactor must not start reading the resolution as
      // proof the revocation succeeded.
      stubClient();
      const fetchMock = stubFetch({
        revocation: () => ({
          status: 200,
          headers: new Headers(),
          json: async () => JSON.parse(''),
        }),
      });

      await expect(
        firstValueFrom(
          svc.revokeTokens(HOMESERVER, BINDING, {
            accessToken: 'a',
            refreshToken: 'r',
          }),
        ),
      ).resolves.toBeUndefined();

      const revocations = fetchMock.mock.calls.filter(
        ([url]) => url === AUTH_METADATA.revocation_endpoint,
      );
      expect(revocations).toHaveLength(2);
    });

    it('POSTs a revocation for each token to the discovered endpoint', async () => {
      stubClient();
      const fetchMock = stubFetch({ revocation: () => jsonResponse({}) });

      await firstValueFrom(
        svc.revokeTokens(HOMESERVER, BINDING, {
          accessToken: 'a',
          refreshToken: 'r',
        }),
      );

      // Discovery goes through the account's OWN homeserver auth metadata.
      expect(createClientMock).toHaveBeenCalledWith({ baseUrl: HOMESERVER });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe(
        AUTH_METADATA.revocation_endpoint,
      );
      const bodies = fetchMock.mock.calls.map(([, init]) => formBody(init));
      expect(
        bodies.some(
          (body) =>
            body.get('token') === 'r' &&
            body.get('token_type_hint') === 'refresh_token',
        ),
      ).toBe(true);
      expect(
        bodies.some(
          (body) =>
            body.get('token') === 'a' &&
            body.get('token_type_hint') === 'access_token',
        ),
      ).toBe(true);
      expect(bodies.every((body) => body.get('client_id') === CLIENT_ID)).toBe(
        true,
      );
    });

    it('resolves void when discovery fails, without POSTing (never blocks logout)', async () => {
      stubClient({ metadata: new Error('metadata unavailable') });
      const fetchMock = stubFetch({});

      await expect(
        firstValueFrom(
          svc.revokeTokens(HOMESERVER, BINDING, { refreshToken: 'r' }),
        ),
      ).resolves.toBeUndefined();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('revokes only the token provided (single-token) with its type hint', async () => {
      stubClient();
      const fetchMock = stubFetch({ revocation: () => jsonResponse({}) });

      await firstValueFrom(
        svc.revokeTokens(HOMESERVER, BINDING, { refreshToken: 'only-refresh' }),
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const body = formBody(fetchMock.mock.calls[0][1]);
      expect(body.get('token')).toBe('only-refresh');
      expect(body.get('token_type_hint')).toBe('refresh_token');
    });

    it('resolves void when a revocation POST rejects (best-effort)', async () => {
      stubClient();
      stubFetch({
        revocation: () => {
          throw new Error('down');
        },
      });

      await expect(
        firstValueFrom(
          svc.revokeTokens(HOMESERVER, BINDING, {
            accessToken: 'a',
            refreshToken: 'r',
          }),
        ),
      ).resolves.toBeUndefined();
    });

    it('resolves void when the provider refuses the revocation (best-effort)', async () => {
      // The 4xx path is distinct from a rejected fetch: the SDK turns the status into
      // an HTTPError itself. It is also what replaces the old "no revocation_endpoint,
      // give up quietly" test — that branch is gone, because the endpoint is required
      // on ValidatedAuthMetadata and getAuthMetadata() rejects metadata without it.
      stubClient();
      stubFetch({
        revocation: () => jsonResponse({ error: 'invalid_token' }, 400),
      });

      await expect(
        firstValueFrom(
          svc.revokeTokens(HOMESERVER, BINDING, { refreshToken: 'r' }),
        ),
      ).resolves.toBeUndefined();
    });
  });

  describe('forgetClientId', () => {
    it('removes the cached client id so the next login re-registers', async () => {
      const fetchMock = stubFetch({
        registration: () => jsonResponse({ client_id: CLIENT_ID }),
      });
      await firstValueFrom(svc.buildAuthorizationRequest(PARAMS));

      await firstValueFrom(
        svc.forgetClientId(HOMESERVER, AUTH_METADATA.issuer),
      );
      await firstValueFrom(svc.buildAuthorizationRequest(PARAMS));

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it("keeps another homeserver's client id for the same issuer", async () => {
      const fetchMock = stubFetch({
        registration: () => jsonResponse({ client_id: CLIENT_ID }),
      });
      await firstValueFrom(svc.buildAuthorizationRequest(PARAMS));

      await firstValueFrom(
        svc.forgetClientId('https://other-hs.example', AUTH_METADATA.issuer),
      );
      await firstValueFrom(svc.buildAuthorizationRequest(PARAMS));

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
