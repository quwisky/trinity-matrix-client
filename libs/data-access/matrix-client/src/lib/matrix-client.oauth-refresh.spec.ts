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
import {
  METADATA,
  OP,
  fakeNetwork,
} from './matrix-client.oauth-network.spec-harness';

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
    vi.mocked(ctx.storage.updateOidcBinding).mockReturnValue(of(undefined));
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

  describe('the provider pinned at sign-in', () => {
    const PINNED_SESSION: MatrixSession = {
      ...OIDC_SESSION,
      lineage: 'L1',
      oidc: {
        ...OIDC_SESSION.oidc,
        tokenEndpoint: METADATA.token_endpoint,
        revocationEndpoint: METADATA.revocation_endpoint,
      },
    };

    it('refreshes while the homeserver names the pinned endpoints', async () => {
      const net = fakeNetwork('rotate');
      const { svc, storage, client } = await startReal(PINNED_SESSION);

      await expect(client.whoami()).resolves.toMatchObject({
        user_id: '@me:hs',
      });

      expect(net.grants).toHaveLength(1);
      expect(storage.updateOidcBinding).not.toHaveBeenCalled();
      expectStillSignedIn(svc, client);
    });

    it.each([
      ['token endpoint', { token_endpoint: 'https://hs.example/token' }],
      ['revocation endpoint', { revocation_endpoint: 'https://hs.example/r' }],
      ['issuer', { issuer: 'https://hs.example/' }],
    ])(
      'does not refresh when the homeserver names another %s',
      async (_, change) => {
        const net = fakeNetwork('rotate');
        net.state.discovery = {
          status: 200,
          body: { ...METADATA, ...change },
        };
        const { svc, client } = await startReal(PINNED_SESSION);

        await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

        expect(net.grants).toHaveLength(0);
        expect(
          net.calls.filter((call) => call.includes('hs.example/token')),
        ).toEqual([]);
        expectStillSignedIn(svc, client);
      },
    );

    it.each(['https://hs.example/mx', 'https://hs.example///'])(
      'refreshes a homeserver at %s while it names the pinned endpoints',
      async (baseUrl) => {
        const net = fakeNetwork('rotate');
        const { client } = await startReal({ ...PINNED_SESSION, baseUrl });

        await expect(client.whoami()).resolves.toBeDefined();

        expect(net.grants).toHaveLength(1);
      },
    );

    it.each(['https://hs.example/mx', 'https://hs.example///'])(
      'does not refresh a homeserver at %s that names another token endpoint',
      async (baseUrl) => {
        const net = fakeNetwork('rotate');
        net.state.discovery = {
          status: 200,
          body: { ...METADATA, token_endpoint: 'https://hs.example/token' },
        };
        const { client } = await startReal({ ...PINNED_SESSION, baseUrl });

        await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

        expect(net.calls).not.toContain('POST hs.example/token');
      },
    );

    it('pins the endpoints of an account saved before pinning on its first refresh', async () => {
      const net = fakeNetwork('rotate');
      net.state.issuerDocument = METADATA;
      const { storage, client } = await startReal({
        ...OIDC_SESSION,
        lineage: 'L1',
      });

      await expect(client.whoami()).resolves.toBeDefined();

      expect(net.grants).toHaveLength(1);
      expect(storage.updateOidcBinding).toHaveBeenCalledWith('@me:hs', 'L1', {
        ...OIDC_SESSION.oidc,
        tokenEndpoint: METADATA.token_endpoint,
        revocationEndpoint: METADATA.revocation_endpoint,
      });
    });

    /** The binding the first refresh pinned, as the next launch reads it from storage. */
    function storedBinding(storage: ReturnType<typeof setup>['storage']) {
      return vi.mocked(storage.updateOidcBinding).mock.calls[0][2];
    }

    it.each([
      ['publishes no document', null],
      ['cannot be reached', 'down'],
    ])(
      'pins the endpoints first named with its issuer when the issuer %s',
      async (_, issuerDocument) => {
        const net = fakeNetwork('rotate');
        net.state.issuerDocument = issuerDocument;
        const { svc, storage, client } = await startReal({
          ...OIDC_SESSION,
          lineage: 'L1',
        });

        await expect(client.whoami()).resolves.toBeDefined();

        expect(net.grants).toHaveLength(1);
        expect(storage.updateOidcBinding).toHaveBeenCalledTimes(1);
        expect(storage.updateOidcBinding).toHaveBeenCalledWith('@me:hs', 'L1', {
          ...OIDC_SESSION.oidc,
          tokenEndpoint: METADATA.token_endpoint,
          revocationEndpoint: METADATA.revocation_endpoint,
        });
        expectStillSignedIn(svc, client);
      },
    );

    it.each([
      ['while the issuer still publishes no document', null],
      [
        "even when the issuer's own document later names it",
        {
          ...METADATA,
          token_endpoint: 'https://hs.example/token',
        },
      ],
    ])(
      'refuses a token endpoint that moved after its first use %s',
      async (_, laterDocument) => {
        const net = fakeNetwork('rotate');
        const session = { ...OIDC_SESSION, lineage: 'L1' };
        const { svc, storage, client } = await startReal(session);
        await expect(client.whoami()).resolves.toBeDefined();

        net.state.discovery = {
          status: 200,
          body: { ...METADATA, token_endpoint: 'https://hs.example/token' },
        };
        net.state.issuerDocument = laterDocument;
        net.expireAll();
        const later = svc.detachedClient({
          ...session,
          oidc: storedBinding(storage),
        });

        await expect(later.whoami()).rejects.toBeInstanceOf(TokenRefreshError);
        expect(net.grants).toHaveLength(1);
        expect(net.calls).not.toContain('POST hs.example/token');
        expect(storage.updateOidcBinding).toHaveBeenCalledTimes(1);
      },
    );

    describe("once the issuer's own document disagreed", () => {
      const DISAGREEING = { ...METADATA, token_endpoint: `${OP}/real-token` };
      const session = { ...OIDC_SESSION, lineage: 'L1' };
      const confirmationRequired = {
        ...OIDC_SESSION.oidc,
        requiresIssuerConfirmation: true,
      };

      it('records that the issuer must confirm, and pins nothing while its document is unreachable', async () => {
        const net = fakeNetwork('rotate');
        net.state.issuerDocument = DISAGREEING;
        const { svc, storage, client } = await startReal(session);
        await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

        net.state.issuerDocument = 'down';
        await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

        expect(net.grants).toHaveLength(0);
        expect(vi.mocked(storage.updateOidcBinding).mock.calls).toEqual([
          ['@me:hs', 'L1', confirmationRequired],
        ]);
        expectStillSignedIn(svc, client);
      });

      it.each([
        ['publishes no document', null],
        ['cannot be reached', 'down'],
      ])(
        'pins nothing after a restart while the issuer %s',
        async (_, issuerDocument) => {
          const net = fakeNetwork('rotate');
          net.state.issuerDocument = issuerDocument;
          const { svc, storage, client } = await startReal({
            ...session,
            oidc: confirmationRequired,
          });

          await expect(client.whoami()).rejects.toBeInstanceOf(
            TokenRefreshError,
          );

          expect(net.grants).toHaveLength(0);
          expect(storage.updateOidcBinding).not.toHaveBeenCalled();
          expectStillSignedIn(svc, client);
        },
      );

      it('pins the endpoints its document later confirms', async () => {
        const net = fakeNetwork('rotate');
        net.state.issuerDocument = METADATA;
        const { storage, client } = await startReal({
          ...session,
          oidc: confirmationRequired,
        });

        await expect(client.whoami()).resolves.toBeDefined();

        expect(net.grants).toHaveLength(1);
        expect(storage.updateOidcBinding).toHaveBeenCalledWith('@me:hs', 'L1', {
          ...confirmationRequired,
          tokenEndpoint: METADATA.token_endpoint,
          revocationEndpoint: METADATA.revocation_endpoint,
        });
      });
    });

    it('compares a concurrent first answer against the endpoints another one pinned', async () => {
      const net = fakeNetwork('rotate');
      const { storage } = await startReal({ ...OIDC_SESSION, lineage: 'L1' });
      const { fetchFn } = vi
        .mocked(createClient)
        .mock.calls.map(([opts]) => opts)
        .find((opts) => opts.fetchFn) as {
        fetchFn: typeof globalThis.fetch;
      };
      const url = 'https://hs.example/_matrix/client/v1/auth_metadata';

      const first = fetchFn(url);
      net.state.discovery = {
        status: 200,
        body: { ...METADATA, token_endpoint: `${OP}/other-token` },
      };
      const second = fetchFn(url);

      await expect(first).resolves.toBeDefined();
      await expect(second).rejects.toThrow(TypeError);
      expect(vi.mocked(storage.updateOidcBinding).mock.calls).toEqual([
        [
          '@me:hs',
          'L1',
          {
            ...OIDC_SESSION.oidc,
            tokenEndpoint: METADATA.token_endpoint,
            revocationEndpoint: METADATA.revocation_endpoint,
          },
        ],
      ]);
    });

    describe("a token endpoint on another origin than the issuer's, while the issuer publishes no document", () => {
      const ELSEWHERE = {
        ...METADATA,
        token_endpoint: 'https://hs.example/token',
      };
      const pinned = (storage: ReturnType<typeof setup>['storage']) =>
        vi
          .mocked(storage.updateOidcBinding)
          .mock.calls.filter(([, , binding]) => binding.tokenEndpoint);

      it('is refused and not pinned for an account saved before pinning', async () => {
        const net = fakeNetwork('rotate');
        net.state.discovery = { status: 200, body: ELSEWHERE };
        const { svc, storage, client } = await startReal({
          ...OIDC_SESSION,
          lineage: 'L1',
        });

        await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

        expect(net.calls).not.toContain('POST hs.example/token');
        expect(pinned(storage)).toEqual([]);
        expectStillSignedIn(svc, client);
      });

      it('is not pinned by a first answer still checking when another records that the issuer must confirm', async () => {
        const net = fakeNetwork('rotate');
        net.state.discovery = { status: 200, body: ELSEWHERE };
        const { storage } = await startReal({ ...OIDC_SESSION, lineage: 'L1' });
        const { fetchFn } = vi
          .mocked(createClient)
          .mock.calls.map(([opts]) => opts)
          .find((opts) => opts.fetchFn) as {
          fetchFn: typeof globalThis.fetch;
        };
        const network = vi.mocked(globalThis.fetch);
        const answer = network.getMockImplementation() as typeof fetch;
        const document = `${OP}/.well-known/oauth-authorization-server`;
        // Hold the first answer's document request until the second answer has finished.
        let release!: () => void;
        const held = new Promise<void>((resolve) => (release = resolve));
        let holding = true;
        network.mockImplementation(async (input, init) => {
          if (holding && String(input) === document) {
            holding = false;
            await held;
          }
          return answer(input, init);
        });
        const url = 'https://hs.example/_matrix/client/v1/auth_metadata';

        const first = fetchFn(url);
        await vi.waitFor(() => expect(holding).toBe(false));
        net.state.issuerDocument = {
          ...METADATA,
          token_endpoint: `${OP}/real-token`,
        };
        await expect(fetchFn(url)).rejects.toThrow(TypeError);
        net.state.issuerDocument = null;
        release();

        await expect(first).rejects.toThrow(TypeError);
        expect(net.calls).not.toContain('POST hs.example/token');
        expect(pinned(storage)).toEqual([]);
      });
    });

    it('warns when the pinned endpoints cannot be saved, and still refreshes', async () => {
      const net = fakeNetwork('rotate');
      const { storage, client } = await startReal({
        ...OIDC_SESSION,
        lineage: 'L1',
      });
      vi.mocked(storage.updateOidcBinding).mockReturnValue(
        throwError(() => new Error('disk full')),
      );
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      await expect(client.whoami()).resolves.toBeDefined();

      expect(net.grants).toHaveLength(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('sign-in provider'),
        expect.any(Error),
      );
      warn.mockRestore();
    });

    it("does not pin or refresh an account saved before pinning when the issuer's own document disagrees", async () => {
      const net = fakeNetwork('rotate');
      net.state.issuerDocument = {
        ...METADATA,
        token_endpoint: `${OP}/real-token`,
      };
      const { svc, storage, client } = await startReal({
        ...OIDC_SESSION,
        lineage: 'L1',
      });

      await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

      expect(net.grants).toHaveLength(0);
      expect(storage.updateOidcBinding).toHaveBeenCalledWith('@me:hs', 'L1', {
        ...OIDC_SESSION.oidc,
        requiresIssuerConfirmation: true,
      });
      expectStillSignedIn(svc, client);
    });

    it("pins the issuer's own endpoints for an account saved before pinning", async () => {
      const net = fakeNetwork('rotate');
      net.state.issuerDocument = {
        ...METADATA,
        token_endpoint: 'https://OP.example:443/token',
      };
      const { storage, client } = await startReal({
        ...OIDC_SESSION,
        lineage: 'L1',
      });

      await expect(client.whoami()).resolves.toBeDefined();

      expect(storage.updateOidcBinding).toHaveBeenCalledWith('@me:hs', 'L1', {
        ...OIDC_SESSION.oidc,
        tokenEndpoint: 'https://OP.example:443/token',
        revocationEndpoint: METADATA.revocation_endpoint,
      });
    });

    it('does not pin or refresh an account saved before pinning whose first metadata names another issuer', async () => {
      const net = fakeNetwork('rotate');
      net.state.discovery = {
        status: 200,
        body: { ...METADATA, issuer: 'https://hs.example/' },
      };
      const { svc, storage, client } = await startReal();

      await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

      expect(net.grants).toHaveLength(0);
      expect(storage.updateOidcBinding).not.toHaveBeenCalled();
      expectStillSignedIn(svc, client);
    });
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
