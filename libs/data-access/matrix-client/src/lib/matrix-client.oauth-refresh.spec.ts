import {
  HttpApiEvent,
  MemoryStore,
  TokenRefreshError,
  createClient,
} from 'matrix-js-sdk';
import type { MatrixClient } from 'matrix-js-sdk';
import { Subject, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MATRIX_REQUEST_TIMEOUT_MS,
  MatrixClientService,
} from './matrix-client.service';
import type { MatrixSession } from '@trinity/util/matrix';
import { SESSION, OIDC_SESSION, setup } from './matrix-client.spec-harness';

// A controllable fake sync store (the real IndexedDBStore needs a browser IDB).
const storeMock = vi.hoisted(() => ({ startup: vi.fn(), destroy: vi.fn() }));

// Keep the real enums (ClientEvent/SyncState) but stub the client factory + store.
vi.mock('matrix-js-sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('matrix-js-sdk')>();
  return {
    ...actual,
    createClient: vi.fn(),
    IndexedDBStore: class {
      startup = storeMock.startup;
      destroy = storeMock.destroy;
    },
  };
});

// In-memory @capacitor/preferences, for the tests that run the real SessionStorageService.
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

// The WASM preload is a no-op in tests (no real crypto engine). preloadCryptoWasm
// now lives in @trinity/util/matrix; partial-mock so its other exports stay real.
vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

describe('OAuth tokens through a real MatrixClient', () => {
  // Only the network is fake. The client, its TokenManager, discovery and the OAuth2
  // refresh grant are matrix-js-sdk 43's own, built from the options start() passes.
  const OP = 'https://op.example';
  const METADATA = {
    issuer: `${OP}/`,
    authorization_endpoint: `${OP}/authorize`,
    token_endpoint: `${OP}/token`,
    revocation_endpoint: `${OP}/revoke`,
    registration_endpoint: `${OP}/register`,
    response_modes_supported: ['query', 'fragment'],
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
  };

  /** How the fake provider answers a refresh grant. */
  type Rotation = 'rotate' | 'omit' | 'empty';

  /** `up` answers normally, `down` drops the connection, anything else is the error sent instead. */
  type Endpoint = 'up' | 'down' | { status: number; body: unknown };

  /** The provider can also `hang`: never answer, until the caller aborts. */
  type ProviderEndpoint = Endpoint | 'hang';

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  /** A homeserver that accepts only the tokens the fake provider issued, and that provider. */
  function fakeNetwork(
    rotation: Rotation = 'rotate',
    expiresIn: number | null = 30,
  ) {
    const live = new Set<string>();
    const grants: URLSearchParams[] = [];
    const revocations: string[] = [];
    const calls: string[] = [];
    const state = {
      discovery: 'up' as Endpoint,
      provider: 'up' as ProviderEndpoint,
      /** Rotate at the provider, then drop the answer, as when iOS suspends the app mid-grant. */
      loseGrantResponse: false,
      /** How long auth metadata discovery takes to answer. */
      discoveryDelayMs: 0,
    };
    // Like MAS, a grant revokes the access token issued with the refresh token it spends.
    const issuedWith = new Map<string, string>();
    let whoamiGate: Promise<void> | undefined;
    let whoamiHeld = 0;
    let whoamiRefused = 0;
    let issued = 1;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = new URL(
          input instanceof Request ? input.url : String(input),
        );
        const form = new URLSearchParams(String(init.body ?? ''));
        calls.push(`${init.method ?? 'GET'} ${url.host}${url.pathname}`);
        if (url.pathname === '/_matrix/client/v1/auth_metadata') {
          if (state.discoveryDelayMs > 0) {
            await new Promise((resolve) =>
              setTimeout(resolve, state.discoveryDelayMs),
            );
          }
          if (state.discovery === 'down')
            throw new TypeError('Failed to fetch');
          if (state.discovery !== 'up') {
            return json(state.discovery.body, state.discovery.status);
          }
          return json(METADATA);
        }
        if (url.href === METADATA.token_endpoint) {
          // Like fetch, an already aborted signal sends nothing.
          if (init.signal?.aborted) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }
          if (state.provider === 'down') throw new TypeError('Failed to fetch');
          if (state.provider === 'hang') {
            return new Promise<Response>((_, reject) => {
              const abort = () =>
                reject(
                  new DOMException('The operation was aborted.', 'AbortError'),
                );
              if (init.signal?.aborted) abort();
              init.signal?.addEventListener('abort', abort);
            });
          }
          if (state.provider !== 'up') {
            return json(state.provider.body, state.provider.status);
          }
          grants.push(form);
          issued += 1;
          const spent = form.get('refresh_token') ?? '';
          live.delete(issuedWith.get(spent) ?? '');
          issuedWith.set(
            rotation === 'rotate' ? `rt-${issued}` : spent,
            `at-${issued}`,
          );
          live.add(`at-${issued}`);
          if (state.loseGrantResponse) throw new TypeError('Failed to fetch');
          return json({
            token_type: 'Bearer',
            access_token: `at-${issued}`,
            // Under the SDK's 60 s window, so a later 401 reads as expiry, not revocation.
            ...(expiresIn === null ? {} : { expires_in: expiresIn }),
            ...(rotation === 'rotate'
              ? { refresh_token: `rt-${issued}` }
              : rotation === 'empty'
                ? { refresh_token: '' }
                : {}),
          });
        }
        if (url.href === METADATA.revocation_endpoint) {
          revocations.push(form.get('token_type_hint') ?? '');
          return new Response('', { status: 200 });
        }
        if (url.pathname === '/_matrix/client/v3/account/whoami') {
          if (whoamiGate) {
            whoamiHeld += 1;
            await whoamiGate;
          }
          const bearer = new Headers(init.headers).get('authorization') ?? '';
          const known = live.has(bearer.replace(/^Bearer /, ''));
          if (!known) whoamiRefused += 1;
          return known
            ? json({ user_id: '@me:hs', device_id: 'DEV' })
            : json(
                {
                  errcode: 'M_UNKNOWN_TOKEN',
                  error: 'expired',
                  soft_logout: false,
                },
                401,
              );
        }
        if (url.pathname.endsWith('/logout')) return json({});
        throw new Error(`unexpected ${init.method ?? 'GET'} ${url.href}`);
      }),
    );
    return {
      live,
      grants,
      revocations,
      calls,
      state,
      expireAll: () => live.clear(),
      /** Hold whoami at the homeserver, before it reads the token; returns the release. */
      holdWhoami: (): (() => void) => {
        let release!: () => void;
        whoamiGate = new Promise<void>((resolve) => (release = resolve));
        return () => {
          whoamiGate = undefined;
          release();
        };
      },
      whoamiHeld: () => whoamiHeld,
      whoamiRefused: () => whoamiRefused,
    };
  }

  /** Let createClient build real clients; stub only crypto, sync and store deletion. */
  async function useRealClients(): Promise<void> {
    const actual =
      await vi.importActual<typeof import('matrix-js-sdk')>('matrix-js-sdk');
    vi.mocked(createClient).mockImplementation((opts) => {
      const client = actual.createClient(opts);
      vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined);
      vi.spyOn(client, 'startClient').mockResolvedValue(undefined);
      vi.spyOn(client, 'clearStores').mockResolvedValue(undefined);
      return client;
    });
    // jsdom has no IndexedDB; say so, so the client runs on its in-memory store.
    vi.stubGlobal('indexedDB', undefined);
  }

  async function startReal(session: MatrixSession = OIDC_SESSION) {
    await useRealClients();
    const ctx = setup();
    vi.mocked(ctx.storage.updateTokens).mockReturnValue(of(undefined));
    // If a refresh ever ends in a logout, let the logout path run to completion so the
    // assertions see its effect rather than a mock error.
    vi.mocked(ctx.storage.remove).mockReturnValue(of(undefined));
    vi.mocked(ctx.storage.invalidateToken).mockReturnValue(of(undefined));
    vi.mocked(ctx.storage.setActive).mockReturnValue(of(undefined));
    await firstValueFrom(ctx.svc.init(session));
    return { ...ctx, client: ctx.svc.instance };
  }

  /** Still signed in, nothing wiped: the hard-logout path deletes the sync and crypto stores. */
  function expectStillSignedIn(
    svc: MatrixClientService,
    client: MatrixClient,
    userId = OIDC_SESSION.userId,
  ): void {
    expect(svc.accountIds()).toContain(userId);
    expect(svc.softLoggedOut()).not.toContain(userId);
    expect(client.clearStores).not.toHaveBeenCalled();
  }

  beforeEach(() => {
    vi.mocked(createClient).mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('refreshes at each expiry and persists the rotated pair under its own account', async () => {
    const net = fakeNetwork('rotate');
    const { svc, storage, client } = await startReal();
    const before = Date.now();

    await expect(client.whoami()).resolves.toMatchObject({ user_id: '@me:hs' });

    // Discovery goes through the account's own homeserver, never the issuer.
    expect(net.calls).toContain(
      'GET hs.example/_matrix/client/v1/auth_metadata',
    );
    expect(net.grants[0].get('refresh_token')).toBe('refresh-tok');
    expect(net.grants[0].get('client_id')).toBe('client-1');
    const [userId, lineage, access, refresh, expiry] = vi.mocked(
      storage.updateTokens,
    ).mock.calls[0];
    expect([userId, lineage, access, refresh]).toEqual([
      '@me:hs',
      undefined,
      'at-2',
      'rt-2',
    ]);
    expect(expiry).toBeGreaterThanOrEqual(before + 30_000);
    expect(expiry).toBeLessThanOrEqual(Date.now() + 30_000);

    net.expireAll();
    await expect(client.whoami()).resolves.toBeDefined();
    expect(net.grants[1].get('refresh_token')).toBe('rt-2');
    expect(client.getAccessToken()).toBe('at-3');
    expectStillSignedIn(svc, client);
  });

  it('persists no expiry when the provider returns none', async () => {
    fakeNetwork('rotate', null);
    const { storage, client } = await startReal();

    await expect(client.whoami()).resolves.toMatchObject({ user_id: '@me:hs' });

    expect(vi.mocked(storage.updateTokens)).toHaveBeenCalledWith(
      '@me:hs',
      undefined,
      'at-2',
      'rt-2',
      undefined,
    );
  });

  it('keeps the old pair in memory when the refreshed tokens cannot be persisted', async () => {
    const net = fakeNetwork('rotate');
    const { svc, storage, client } = await startReal();
    vi.mocked(storage.updateTokens).mockReturnValue(
      throwError(() => new Error('secure store locked')),
    );

    await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

    expect(client.getAccessToken()).toBe('tok');
    expect(client.getRefreshToken()).toBe('refresh-tok');
    expect(net.grants).toHaveLength(1);
    expect(storage.updateTokens).toHaveBeenCalledOnce();
    expectStillSignedIn(svc, client);
  });

  it('survives a refresh attempted while offline and recovers when the network returns', async () => {
    const net = fakeNetwork('rotate');
    const { svc, storage, client } = await startReal();

    net.state.discovery = 'down';
    await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);
    net.state.discovery = 'up';
    net.state.provider = 'down';
    await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);
    expect(storage.updateTokens).not.toHaveBeenCalled();
    expectStillSignedIn(svc, client);

    net.state.provider = 'up';
    await expect(client.whoami()).resolves.toBeDefined();
    expect(storage.updateTokens).toHaveBeenCalledOnce();
  });

  it('does not sign the account out when the provider answers 5xx', async () => {
    const net = fakeNetwork('rotate');
    const { svc, client } = await startReal();
    net.state.provider = {
      status: 503,
      body: { error: 'temporarily_unavailable' },
    };

    await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

    expect(net.calls).toContain('POST op.example/token');
    expectStillSignedIn(svc, client);
  });

  it.each([
    [
      '503 with a JSON body',
      { status: 503, body: { errcode: 'M_UNKNOWN', error: 'Unavailable' } },
    ],
    [
      '429 with a JSON body',
      {
        status: 429,
        body: { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests' },
      },
    ],
    [
      '404 M_UNRECOGNIZED',
      { status: 404, body: { errcode: 'M_UNRECOGNIZED', error: 'Unknown' } },
    ],
  ])(
    'keeps the account and its keys when auth_metadata answers %s, then recovers',
    async (_, answer) => {
      const net = fakeNetwork('rotate');
      const { svc, storage, client } = await startReal();
      net.state.discovery = answer;

      await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

      expectStillSignedIn(svc, client);
      expect(storage.remove).not.toHaveBeenCalled();
      expect(storage.invalidateToken).not.toHaveBeenCalled();

      net.state.discovery = 'up';
      await expect(client.whoami()).resolves.toMatchObject({
        user_id: '@me:hs',
      });
      expect(storage.updateTokens).toHaveBeenCalledOnce();
      expectStillSignedIn(svc, client);
    },
  );

  it.each([
    ['429 with an OAuth error', { status: 429, body: { error: 'slow_down' } }],
    // A proxy in front of the provider can answer any status with an OAuth-shaped body;
    // RFC 6749 section 5.2 refusals are 400 and 401 only.
    ['403 with an OAuth error', { status: 403, body: { error: 'forbidden' } }],
    ['404 with an OAuth error', { status: 404, body: { error: 'not_found' } }],
    [
      '429 with a Matrix error',
      {
        status: 429,
        body: { errcode: 'M_LIMIT_EXCEEDED', error: 'Too many requests' },
      },
    ],
  ])(
    'keeps the account and its keys when the token endpoint answers %s, then recovers',
    async (_, answer) => {
      const net = fakeNetwork('rotate');
      const { svc, storage, client } = await startReal();
      net.state.provider = answer;

      await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

      expectStillSignedIn(svc, client);
      expect(storage.remove).not.toHaveBeenCalled();

      net.state.provider = 'up';
      await expect(client.whoami()).resolves.toBeDefined();
      expectStillSignedIn(svc, client);
    },
  );

  it.each([
    ['400 invalid_grant', { status: 400, body: { error: 'invalid_grant' } }],
    ['401 invalid_client', { status: 401, body: { error: 'invalid_client' } }],
  ])(
    'signs the account out when the provider refuses the refresh (%s)',
    async (_, answer) => {
      const net = fakeNetwork('rotate');
      const { svc, storage, client } = await startReal();
      net.state.provider = answer;

      await expect(client.whoami()).rejects.toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
      });

      expect(svc.accountIds()).not.toContain('@me:hs');
      // The homeserver's 401 said soft_logout: false, so this is the hard path, as before.
      expect(client.clearStores).toHaveBeenCalledOnce();
      expect(storage.remove).toHaveBeenCalledWith('@me:hs');
    },
  );

  it('still wipes the account when the homeserver revokes a token that has not expired', async () => {
    const net = fakeNetwork('rotate', 3600);
    const { svc, storage, client } = await startReal();
    await client.whoami(); // refreshes once; the new token is good for an hour

    net.expireAll(); // signed out from another device: M_UNKNOWN_TOKEN, soft_logout: false
    await expect(client.whoami()).rejects.toMatchObject({
      errcode: 'M_UNKNOWN_TOKEN',
    });

    expect(net.grants).toHaveLength(1); // no refresh was attempted
    expect(svc.accountIds()).not.toContain('@me:hs');
    expect(client.clearStores).toHaveBeenCalledOnce();
    expect(storage.remove).toHaveBeenCalledWith('@me:hs');
  });

  it('refreshes once for concurrent expired requests', async () => {
    const net = fakeNetwork('rotate');
    const { svc, client } = await startReal();

    await Promise.all([client.whoami(), client.whoami()]);

    expect(net.grants).toHaveLength(1);
    expect(
      net.calls.filter((call) => call.endsWith('/auth_metadata')),
    ).toHaveLength(1);
    expectStillSignedIn(svc, client);
  });

  it('refreshes on request through the patched SDK token manager', async () => {
    const net = fakeNetwork('rotate');
    const { svc, storage, client } = await startReal();

    await expect(client.http.refreshOAuthTokens()).resolves.toBe(true);

    expect(net.grants).toHaveLength(1);
    expect(net.grants[0].get('refresh_token')).toBe('refresh-tok');
    expect(client.getAccessToken()).toBe('at-2');
    expect(storage.updateTokens).toHaveBeenCalledWith(
      '@me:hs',
      undefined,
      'at-2',
      'rt-2',
      expect.any(Number),
    );
    expectStillSignedIn(svc, client);
  });

  it('disarms the grant bound once the provider has answered', async () => {
    fakeNetwork('rotate');
    const { client } = await startReal();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await expect(client.http.refreshOAuthTokens()).resolves.toBe(true);
      const grant = vi
        .mocked(globalThis.fetch)
        .mock.calls.find(
          ([input]) => String(input) === METADATA.token_endpoint,
        );
      const signal = grant?.[1]?.signal;
      expect(signal).toBeInstanceOf(AbortSignal);

      await vi.advanceTimersByTimeAsync(MATRIX_REQUEST_TIMEOUT_MS);

      expect(signal?.aborted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('joins a refresh already in flight instead of starting another', async () => {
    const net = fakeNetwork('rotate');
    const { svc, client } = await startReal();

    const [, refreshed] = await Promise.all([
      client.whoami(),
      client.http.refreshOAuthTokens(),
    ]);

    expect(refreshed).toBe(true);
    expect(net.grants).toHaveLength(1);
    expectStillSignedIn(svc, client);
  });

  it('answers a refused refresh with false and emits no sign-out', async () => {
    const net = fakeNetwork('rotate');
    const { svc, client } = await startReal();
    const loggedOut = vi.fn();
    client.on(HttpApiEvent.SessionLoggedOut, loggedOut);
    net.state.provider = { status: 400, body: { error: 'invalid_grant' } };

    await expect(client.http.refreshOAuthTokens()).resolves.toBe(false);

    expect(loggedOut).not.toHaveBeenCalled();
    expectStillSignedIn(svc, client);

    // A dead session still ends through the normal path at its next request.
    net.expireAll();
    await client.whoami().catch(() => undefined);

    expect(loggedOut).toHaveBeenCalled();
  });

  it('answers an unreachable provider with false and stays signed in', async () => {
    const net = fakeNetwork('rotate');
    const { svc, client } = await startReal();
    const loggedOut = vi.fn();
    client.on(HttpApiEvent.SessionLoggedOut, loggedOut);
    net.state.provider = 'down';

    await expect(client.http.refreshOAuthTokens()).resolves.toBe(false);

    expect(loggedOut).not.toHaveBeenCalled();
    expectStillSignedIn(svc, client);
  });

  it('gives up on a refresh the provider never answers, stays signed in and refreshes again', async () => {
    const net = fakeNetwork('rotate');
    const { svc, client } = await startReal();
    const loggedOut = vi.fn();
    client.on(HttpApiEvent.SessionLoggedOut, loggedOut);
    net.state.provider = 'hang';
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let settled: boolean | undefined;
      void client.http.refreshOAuthTokens().then((value) => (settled = value));

      // The patch mirrors the app's request deadline; changing one alone fails here.
      await vi.advanceTimersByTimeAsync(MATRIX_REQUEST_TIMEOUT_MS - 1);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    expect(loggedOut).not.toHaveBeenCalled();
    expectStillSignedIn(svc, client);
    // The aborted grant released the SDK's shared refresh: the next request refreshes anew.
    net.state.provider = 'up';
    await expect(client.whoami()).resolves.toMatchObject({ user_id: '@me:hs' });
    expect(net.grants).toHaveLength(1);
  });

  describe('a forced refresh with a grant bound', () => {
    /** The bound is counted from the call, so the clock is faked as well as the timers. */
    const useFakeClock = () =>
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

    /** Start a refresh through the service and record what it answers. */
    function refreshing(svc: MatrixClientService, timeoutMs?: number) {
      const outcome: { value?: boolean } = {};
      svc
        .refreshAccessToken(
          OIDC_SESSION.userId,
          timeoutMs === undefined ? undefined : { timeoutMs },
        )
        .subscribe((value) => (outcome.value = value));
      return outcome;
    }

    it('aborts the grant at the given time, stays signed in and refreshes again', async () => {
      const net = fakeNetwork('rotate');
      const { svc, client } = await startReal();
      const loggedOut = vi.fn();
      client.on(HttpApiEvent.SessionLoggedOut, loggedOut);
      net.state.provider = 'hang';
      useFakeClock();
      try {
        const outcome = refreshing(svc, 8_000);

        await vi.advanceTimersByTimeAsync(7_999);
        expect(outcome.value).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome.value).toBe(false);
      } finally {
        vi.useRealTimers();
      }

      expect(loggedOut).not.toHaveBeenCalled();
      expectStillSignedIn(svc, client);
      net.state.provider = 'up';
      await expect(client.whoami()).resolves.toMatchObject({
        user_id: '@me:hs',
      });
      expect(net.grants).toHaveLength(1);
    });

    it('counts the bound from the call, so a slow discovery leaves the grant less time', async () => {
      const net = fakeNetwork('rotate');
      const { svc } = await startReal();
      net.state.discoveryDelayMs = 5_000;
      net.state.provider = 'hang';
      useFakeClock();
      try {
        const outcome = refreshing(svc, 8_000);

        await vi.advanceTimersByTimeAsync(7_999);
        expect(outcome.value).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome.value).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('sends no grant once the bound has passed before the grant could start', async () => {
      const net = fakeNetwork('rotate');
      const { svc, client, storage } = await startReal();
      net.state.discoveryDelayMs = 8_000;
      useFakeClock();
      try {
        const outcome = refreshing(svc, 8_000);

        await vi.advanceTimersByTimeAsync(8_000);
        expect(outcome.value).toBe(false);
      } finally {
        vi.useRealTimers();
      }

      expect(net.grants).toHaveLength(0);
      expect(storage.updateTokens).not.toHaveBeenCalled();
      expect(client.getAccessToken()).toBe(OIDC_SESSION.accessToken);
      expectStillSignedIn(svc, client);
    });

    it('keeps the default grant bound when none is given', async () => {
      const net = fakeNetwork('rotate');
      const { svc } = await startReal();
      net.state.provider = 'hang';
      useFakeClock();
      try {
        const outcome = refreshing(svc);

        await vi.advanceTimersByTimeAsync(MATRIX_REQUEST_TIMEOUT_MS - 1);
        expect(outcome.value).toBeUndefined();
        await vi.advanceTimersByTimeAsync(1);
        expect(outcome.value).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('answers false for a session without OAuth and emits no sign-out', async () => {
    const net = fakeNetwork('rotate');
    const { svc, client } = await startReal(SESSION);
    const loggedOut = vi.fn();
    client.on(HttpApiEvent.SessionLoggedOut, loggedOut);

    await expect(client.http.refreshOAuthTokens()).resolves.toBe(false);

    expect(net.grants).toHaveLength(0);
    expect(loggedOut).not.toHaveBeenCalled();
    expectStillSignedIn(svc, client, SESSION.userId);
  });

  describe('a forced refresh while the known expiry is far away', () => {
    // MAS revokes the previous access token on every grant, an hour before the expiry the
    // client knows. The SDK reads a 401 that far from expiry as revocation and signs out.
    async function startWithFarExpiry() {
      const net = fakeNetwork('rotate', 3600);
      const started = await startReal();
      await started.client.whoami(); // the first refresh: at-2, an hour to run
      return { net, ...started };
    }

    it('retries a request whose token was rotated behind it', async () => {
      const { net, svc, client } = await startWithFarExpiry();
      const release = net.holdWhoami();
      const pending = client.whoami();
      await vi.waitFor(() => expect(net.whoamiHeld()).toBe(1));

      await expect(client.http.refreshOAuthTokens()).resolves.toBe(true);
      release();

      await expect(pending).resolves.toMatchObject({ user_id: '@me:hs' });
      expect(net.grants).toHaveLength(2);
      expectStillSignedIn(svc, client);
    });

    it('joins the refresh when a request meets its revoked token before adoption', async () => {
      const { net, svc, storage, client } = await startWithFarExpiry();
      const release = net.holdWhoami();
      const pending = client.whoami();
      await vi.waitFor(() => expect(net.whoamiHeld()).toBe(1));
      const write = new Subject<void>();
      vi.mocked(storage.updateTokens).mockReturnValueOnce(write);

      const refreshed = client.http.refreshOAuthTokens();
      // The provider has rotated, so revoked at-2; the client persists before adopting at-3.
      await vi.waitFor(() =>
        expect(storage.updateTokens).toHaveBeenLastCalledWith(
          '@me:hs',
          undefined,
          'at-3',
          'rt-3',
          expect.any(Number),
        ),
      );
      const refusedBefore = net.whoamiRefused();
      release();
      await vi.waitFor(() =>
        expect(net.whoamiRefused()).toBe(refusedBefore + 1),
      );
      // Let the client handle that refusal while the write is still pending.
      await new Promise((resolve) => setTimeout(resolve, 50));
      write.next();
      write.complete();

      await expect(refreshed).resolves.toBe(true);
      await expect(pending).resolves.toMatchObject({ user_id: '@me:hs' });
      expect(net.grants).toHaveLength(2);
      expectStillSignedIn(svc, client);
    });

    it('refreshes for a request prepared before a forced refresh whose answer was lost', async () => {
      const { net, svc, client } = await startWithFarExpiry();
      const release = net.holdWhoami();
      const pending = client.whoami();
      await vi.waitFor(() => expect(net.whoamiHeld()).toBe(1));
      net.state.loseGrantResponse = true;

      await expect(client.http.refreshOAuthTokens()).resolves.toBe(false);
      net.state.loseGrantResponse = false;
      release();

      await expect(pending).resolves.toMatchObject({ user_id: '@me:hs' });
      expect(net.grants).toHaveLength(3);
      expect(net.grants[2].get('refresh_token')).toBe('rt-2');
      expectStillSignedIn(svc, client);
    });

    it('refreshes again after a forced refresh whose answer was lost', async () => {
      const { net, svc, client } = await startWithFarExpiry();
      net.state.loseGrantResponse = true;

      await expect(client.http.refreshOAuthTokens()).resolves.toBe(false);
      net.state.loseGrantResponse = false;

      await expect(client.whoami()).resolves.toMatchObject({
        user_id: '@me:hs',
      });
      expect(net.grants).toHaveLength(3);
      expect(net.grants[2].get('refresh_token')).toBe('rt-2');
      expectStillSignedIn(svc, client);
    });
  });

  it('refreshes a live OAuth account before the background and records the new expiry', async () => {
    const net = fakeNetwork('rotate', 300);
    const { svc, client } = await startReal();
    const before = Date.now();

    await expect(
      firstValueFrom(svc.refreshAccessToken('@me:hs')),
    ).resolves.toBe(true);

    expect(net.grants).toHaveLength(1);
    const token = client.getAccessToken() ?? '';
    expect(token).toBe('at-2');
    expect(svc.accessTokenExpiry('@me:hs', token)).toBeGreaterThanOrEqual(
      before + 300_000,
    );
    expectStillSignedIn(svc, client);
  });

  it('signs nothing out when the provider refuses a refresh before the background', async () => {
    const net = fakeNetwork('rotate');
    const { svc, storage, client } = await startReal();
    net.state.provider = { status: 400, body: { error: 'invalid_grant' } };

    await expect(
      firstValueFrom(svc.refreshAccessToken('@me:hs')),
    ).resolves.toBe(false);

    expectStillSignedIn(svc, client);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it("persists each account's refreshed tokens under that account", async () => {
    const net = fakeNetwork('rotate');
    const { svc, storage } = await startReal();
    const other: MatrixSession = {
      ...OIDC_SESSION,
      baseUrl: 'https://other.example',
      userId: '@you:other',
      deviceId: 'DEV2',
      accessToken: 'tok2',
      refreshToken: 'refresh-tok2',
      oidc: { ...OIDC_SESSION.oidc, clientId: 'client-2' },
    };
    await firstValueFrom(svc.add(other));

    await Promise.all([
      svc.clientFor('@me:hs')!.whoami(),
      svc.clientFor('@you:other')!.whoami(),
    ]);

    for (const userId of ['@me:hs', '@you:other']) {
      const client = svc.clientFor(userId)!;
      expect(storage.updateTokens).toHaveBeenCalledWith(
        userId,
        undefined,
        client.getAccessToken(),
        client.getRefreshToken(),
        expect.any(Number),
      );
      expect(
        svc.accessTokenExpiry(userId, client.getAccessToken()!),
      ).toBeGreaterThan(Date.now());
      expectStillSignedIn(svc, client, userId);
    }
    // Each expiry travels only with its own account's token.
    expect(
      svc.accessTokenExpiry(
        '@me:hs',
        svc.clientFor('@you:other')!.getAccessToken()!,
      ),
    ).toBeUndefined();
    expect(
      svc.accessTokenExpiry(
        '@you:other',
        svc.clientFor('@me:hs')!.getAccessToken()!,
      ),
    ).toBeUndefined();
    expect(net.grants.map((grant) => grant.get('client_id')).sort()).toEqual([
      'client-1',
      'client-2',
    ]);
  });

  it.each(['omit', 'empty'] as const)(
    'keeps the current refresh token when the provider does not rotate it (%s)',
    async (rotation) => {
      const net = fakeNetwork(rotation);
      const { svc, storage, client } = await startReal();

      await expect(client.whoami()).resolves.toBeDefined();
      expect(client.getRefreshToken()).toBe('refresh-tok');
      expect(storage.updateTokens).toHaveBeenLastCalledWith(
        '@me:hs',
        undefined,
        'at-2',
        'refresh-tok',
        expect.any(Number),
      );

      // The second expiry is where unpatched 43 finds no refresh token, logs out and wipes.
      net.expireAll();
      await expect(client.whoami()).resolves.toBeDefined();
      expect(net.grants[1].get('refresh_token')).toBe('refresh-tok');
      expectStillSignedIn(svc, client);
    },
  );

  it('revokes an OAuth session once at the provider on signOutAll, with no POST /logout', async () => {
    const net = fakeNetwork('rotate');
    const { svc } = await startReal();

    await firstValueFrom(svc.signOutAll());

    expect([...net.revocations].sort()).toEqual([
      'access_token',
      'refresh_token',
    ]);
    expect(net.calls.some((call) => call.endsWith('/logout'))).toBe(false);
  });

  it('logs a stored session with no live client out through a detached client', async () => {
    const net = fakeNetwork('rotate');
    await useRealClients();
    const { svc } = setup();

    await svc.detachedClient(OIDC_SESSION).logout(true);

    const opts = vi.mocked(createClient).mock.calls.at(-1)![0];
    const c = vi.mocked(createClient).mock.results.at(-1)!.value;
    expect(c.startClient).not.toHaveBeenCalled();
    expect(c.initRustCrypto).not.toHaveBeenCalled();
    expect(c.clearStores).not.toHaveBeenCalled();
    expect(opts).toMatchObject({
      baseUrl: 'https://hs.example',
      userId: '@me:hs',
      deviceId: 'DEV',
      accessToken: 'tok',
      refreshToken: 'refresh-tok',
      oauthClientId: 'client-1',
    });
    // No persistent store: createClient() fills in its in-memory default, on these same opts.
    expect(opts.store).toBeInstanceOf(MemoryStore);
    expect([...net.revocations].sort()).toEqual([
      'access_token',
      'refresh_token',
    ]);
    expect(svc.accountIds()).toEqual([]);
  });
});
