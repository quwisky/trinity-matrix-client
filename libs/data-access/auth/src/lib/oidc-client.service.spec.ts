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
/** Where the dynamic-registration client id is cached (prefix + issuer). */
const CLIENT_ID_KEY = 'oidc.clientId.v2:https://op.example';

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
  status,
  headers: new Headers(),
  json: async () => body,
});

/**
 * Route `globalThis.fetch` to a fake provider so the real `OAuth2` runs end to end.
 * An unrouted endpoint throws rather than silently resolving, so a stray request can't
 * hide inside the best-effort `catchError` on the revocation path.
 */
function stubFetch(routes: Partial<Record<keyof typeof ENDPOINTS, Handler>>) {
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const role = (Object.keys(ENDPOINTS) as (keyof typeof ENDPOINTS)[]).find(
      (name) => ENDPOINTS[name] === url,
    );
    const handler = role && routes[role];
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

    it('forwards `prompt` to the provider (account registration)', async () => {
      // Also pins the positional-argument order of the three-arg
      // generateAuthorizationCodeGrantUrl(state, responseMode, prompt): a prompt
      // landing in the responseMode slot would silently un-fix the test above.
      stubFetch({ registration: () => jsonResponse({ client_id: CLIENT_ID }) });

      const request = await firstValueFrom(
        svc.buildAuthorizationRequest({ ...PARAMS, prompt: 'create' }),
      );

      const params = new URL(request.url).searchParams;
      expect(params.get('prompt')).toBe('create');
      expect(params.get('response_mode')).toBe('query');
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
      expect(fetchMock.mock.calls[0][0]).toBe(AUTH_METADATA.token_endpoint);
      expect(Object.fromEntries(formBody(fetchMock.mock.calls[0][1]))).toEqual({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code_verifier: CONTEXT.codeVerifier,
        redirect_uri: REDIRECT_URI,
        code: 'CODE',
      });
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

    it('still surfaces the original failure when the revocation also fails', async () => {
      // Best-effort, and it genuinely does fail against a compliant provider: RFC 7009
      // mandates an empty 200 body, which the SDK's shared `res.json()` chokes on. A
      // revocation error must never displace the error the user needs to see.
      stubClient({ whoami: new Error('homeserver unavailable') });
      stubFetch({
        token: () => jsonResponse(TOKEN),
        revocation: () => {
          throw new Error('revocation down');
        },
      });

      await expect(
        firstValueFrom(svc.completeGrant('CODE', CONTEXT)),
      ).rejects.toThrow(/homeserver unavailable/);
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
      prefs.set(CLIENT_ID_KEY, CLIENT_ID);

      await firstValueFrom(svc.forgetClientId(AUTH_METADATA.issuer));

      expect(prefs.get(CLIENT_ID_KEY)).toBeUndefined();
    });
  });
});
