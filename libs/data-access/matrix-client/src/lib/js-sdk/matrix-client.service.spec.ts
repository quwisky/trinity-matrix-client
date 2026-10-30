import { computed } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { MockProvider } from 'ng-mocks';
import {
  ClientEvent,
  ConnectionError,
  EventStatus,
  HttpApiEvent,
  MatrixError,
  MatrixEvent,
  RoomEvent,
  SyncState,
  createClient,
} from 'matrix-js-sdk';
import { CryptoEvent } from 'matrix-js-sdk/lib/crypto-api';
import { Subject, firstValueFrom, of } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MATRIX_SYNC_PROJECTION_BASELINE,
  MatrixClientService,
  isServerSync,
  type AccessTokenRotation,
} from './matrix-client.service';
import {
  CryptoStoreKeyService,
  SecureStorageService,
  SessionStorageService,
} from '@trinity/platform-native';
import { type ProjectionReadiness } from '@trinity/runtime/projection';
import { SecretStorageKeyHolder } from './secret-storage-key-holder';
import { SessionStateService } from '../session-state.service';
import { desktopBridgeFixture } from '@trinity/testing';
import type { MatrixSession } from '@trinity/util/matrix';
import type { SessionStorageEffect } from '../session-engine';
import { SessionStorageEffects } from '../session-storage-effects';
import {
  SESSION,
  SESSION_B,
  OIDC_SESSION,
  fakeClient,
  setup,
} from './matrix-client.spec-harness';

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

// The WASM preload is a no-op in tests (no real crypto engine).
vi.mock('./crypto-wasm-loader', async () => {
  const { of: rxOf } = await import('rxjs');
  return { preloadCryptoWasm: () => rxOf(undefined) };
});

/** The session state production reads, which the session engine derives from the registry. */
const sessionState = () => TestBed.inject(SessionStateService);

/** The live client of the account in view, or null. */
function activeClient(svc: MatrixClientService) {
  const id = svc.activeUserId();
  return id === null ? null : svc.clientFor(id);
}

describe('MatrixClientService', () => {
  let clearHolder: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(createClient).mockReset();
    storeMock.startup.mockReset().mockResolvedValue(undefined);
    storeMock.destroy.mockReset().mockResolvedValue(undefined);
    // Each account owns its own 4S holder; spy on the class so tests can assert the
    // key is cleared on teardown/failure without reaching into internal instances.
    clearHolder = vi.spyOn(SecretStorageKeyHolder.prototype, 'clear');
  });

  afterEach(() => {
    clearHolder.mockRestore();
    vi.unstubAllGlobals();
  });

  it('creates the client, inits crypto, starts, and publishes on success', async () => {
    const client = fakeClient();
    const { svc } = setup(client);

    await firstValueFrom(svc.init(SESSION));

    expect(createClient).toHaveBeenCalledWith(
      expect.objectContaining({
        baseUrl: 'https://hs.example',
        accessToken: 'tok',
        userId: '@me:hs',
        deviceId: 'DEV',
        localTimeoutMs: 30_000,
      }),
    );
    expect(client.initRustCrypto).toHaveBeenCalledOnce();
    // No per-account prefix on this session → the SDK default store prefix.
    expect(client.initRustCrypto).toHaveBeenCalledWith({
      cryptoDatabasePrefix: undefined,
    });
    expect(client.startClient).toHaveBeenCalledOnce();
    // Members arrive with the events that need them, and in full only for a room in use
    // (#1295): a large room's member list is most of a first sync's bytes and heap.
    expect(client.startClient).toHaveBeenCalledWith(
      expect.objectContaining({ lazyLoadMembers: true }),
    );
    expect(sessionState().active()).not.toBeNull();
    expect(activeClient(svc)).toBe(client);
  });

  it('scopes the crypto store to the account via cryptoDatabasePrefix', async () => {
    const client = fakeClient();
    const { svc } = setup(client);

    await firstValueFrom(
      svc.init({ ...SESSION, cryptoPrefix: 'trinity-crypto:@me:hs' }),
    );

    expect(client.initRustCrypto).toHaveBeenCalledWith({
      cryptoDatabasePrefix: 'trinity-crypto:@me:hs',
    });
  });

  describe('crypto store key', () => {
    const KEY = new Uint8Array(32).fill(7);
    const KEYED = {
      ...SESSION,
      cryptoPrefix: 'trinity-crypto:@me:hs:DEV',
      cryptoStoreKeyed: true as const,
    };

    it('opens a keyed store with the key named by that store', async () => {
      const client = fakeClient();
      const { svc, storeKeys } = setup(client);
      vi.mocked(storeKeys.read).mockResolvedValue({
        kind: 'present',
        key: KEY,
      });

      await firstValueFrom(svc.init(KEYED));

      expect(storeKeys.read).toHaveBeenCalledWith('trinity-crypto:@me:hs:DEV');
      expect(client.initRustCrypto).toHaveBeenCalledWith({
        cryptoDatabasePrefix: 'trinity-crypto:@me:hs:DEV',
        storageKey: KEY,
      });
      expect(sessionState().cryptoStoreEncrypted()).toBe(true);
    });

    it('opens a store created before keys existed as it is, and says so', async () => {
      const client = fakeClient();
      const { svc, storeKeys } = setup(client);

      await firstValueFrom(
        svc.init({ ...SESSION, cryptoPrefix: 'trinity-crypto:@me:hs:DEV' }),
      );

      // A key on an existing unencrypted store would make it fail to open.
      expect(storeKeys.read).not.toHaveBeenCalled();
      expect(client.initRustCrypto).toHaveBeenCalledWith({
        cryptoDatabasePrefix: 'trinity-crypto:@me:hs:DEV',
      });
      expect(sessionState().cryptoStoreEncrypted()).toBe(false);
    });

    it('never opens a keyed store whose key is missing, and asks to sign in again', async () => {
      const client = fakeClient();
      const { svc, storeKeys } = setup(client);
      vi.mocked(storeKeys.read).mockResolvedValue({ kind: 'missing' });

      const outcome = await firstValueFrom(
        svc.restorePersisted(KEYED, 'activate'),
      );

      expect(outcome).toEqual({
        kind: 'failed',
        failure: 'crypto-store-key-lost',
      });
      expect(client.initRustCrypto).not.toHaveBeenCalled();
      expect(svc.softLoggedOut()).toEqual(['@me:hs']);
    });

    it.each([
      [
        'an unavailable keychain',
        () => Promise.resolve({ kind: 'unavailable' as const }),
      ],
      ['a failed read', () => Promise.reject(new Error('ipc failed'))],
    ])(
      'treats %s as an outage: no sign-in, no new device, the store is kept',
      async (_case, read) => {
        const client = fakeClient();
        const { svc, storeKeys } = setup(client);
        vi.mocked(storeKeys.read).mockImplementation(read);

        const outcome = await firstValueFrom(
          svc.restorePersisted(KEYED, 'activate'),
        );

        expect(outcome).toEqual({
          kind: 'failed',
          failure: 'secure-storage-unavailable',
        });
        expect(client.initRustCrypto).not.toHaveBeenCalled();
        expect(svc.softLoggedOut()).toEqual([]);
      },
    );

    it("opens each account's store with that store's own key", async () => {
      const first = fakeClient();
      const second = fakeClient('https://other.example');
      const { svc, storeKeys } = setup(first, second);
      const keyB = new Uint8Array(32).fill(9);
      vi.mocked(storeKeys.read).mockImplementation(async (prefix) => ({
        kind: 'present',
        key: prefix === 'trinity-crypto:@you:other:DEV2' ? keyB : KEY,
      }));

      await firstValueFrom(svc.add(KEYED));
      await firstValueFrom(
        svc.add({
          ...SESSION_B,
          cryptoPrefix: 'trinity-crypto:@you:other:DEV2',
          cryptoStoreKeyed: true,
        }),
      );

      expect(first.initRustCrypto).toHaveBeenCalledWith(
        expect.objectContaining({ storageKey: KEY }),
      );
      expect(second.initRustCrypto).toHaveBeenCalledWith(
        expect.objectContaining({ storageKey: keyB }),
      );
    });

    it('reports the active account, following a switch', async () => {
      const { svc, storeKeys } = setup(
        fakeClient(),
        fakeClient('https://other.example'),
      );
      vi.mocked(storeKeys.read).mockResolvedValue({
        kind: 'present',
        key: KEY,
      });
      expect(sessionState().cryptoStoreEncrypted()).toBeNull();

      await firstValueFrom(svc.add(KEYED));
      await firstValueFrom(svc.add(SESSION_B));
      expect(sessionState().cryptoStoreEncrypted()).toBe(false);

      svc.setActive(SESSION.userId);
      expect(sessionState().cryptoStoreEncrypted()).toBe(true);
    });
  });

  it('builds a detached client that never saves refreshed tokens when asked', () => {
    const { svc } = setup(fakeClient());

    svc.detachedClient(OIDC_SESSION, { persistRefreshedTokens: false });

    const options = vi.mocked(createClient).mock.calls[0][0];
    // It can still refresh and revoke at the provider...
    expect(options).toMatchObject({
      refreshToken: 'refresh-tok',
      oauthClientId: 'client-1',
    });
    // ...but whatever it refreshes stays in memory.
    expect(options).not.toHaveProperty('onTokenRefresh');
  });

  it('hands an OIDC session to the SDK token manager', async () => {
    const client = fakeClient();
    const { svc } = setup(client);

    await firstValueFrom(svc.init(OIDC_SESSION));

    const opts = vi.mocked(createClient).mock.calls[0][0];
    // Without oauthClientId matrix-js-sdk 43 refuses to refresh, and the first 401 becomes
    // a hard logout that deletes the crypto store.
    expect(opts).toMatchObject({
      refreshToken: 'refresh-tok',
      oauthClientId: 'client-1',
    });
    expect(typeof opts.onTokenRefresh).toBe('function');
  });

  it('persists refreshed tokens for its own account and hands the write back to the SDK', async () => {
    const client = fakeClient();
    const { svc, storage } = setup(client);
    const write = new Subject<void>();
    vi.mocked(storage.updateTokens).mockReturnValue(write);
    await firstValueFrom(svc.init({ ...OIDC_SESSION, lineage: 'L1' }));
    const opts = vi.mocked(createClient).mock.calls[0][0];

    const pending = opts.onTokenRefresh?.({
      accessToken: 'a2',
      refreshToken: 'r2',
      expiry: new Date(5_000),
    }) as unknown;

    expect(storage.updateTokens).toHaveBeenCalledWith(
      '@me:hs',
      'L1',
      'a2',
      'r2',
      5_000,
    );
    // The SDK awaits this before adopting the new pair; a bare void would let it run on
    // tokens that never reached storage.
    expect(pending).toBeInstanceOf(Promise);
    let settled = false;
    void (pending as Promise<void>).then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    write.next();
    write.complete();
    await expect(pending).resolves.toBeUndefined();
  });

  it('publishes a rotated access token only after storage accepted it', async () => {
    const client = fakeClient();
    const { svc, storage } = setup(client);
    const write = new Subject<void>();
    vi.mocked(storage.updateTokens).mockReturnValue(write);
    const rotations: AccessTokenRotation[] = [];
    svc.accessTokenRotations.subscribe((rotation) => rotations.push(rotation));
    await firstValueFrom(svc.init(OIDC_SESSION));
    const opts = vi.mocked(createClient).mock.calls[0][0];

    const pending = opts.onTokenRefresh?.({
      accessToken: 'a2',
      refreshToken: 'r2',
      expiry: new Date(5_000),
    }) as unknown as Promise<void>;
    await Promise.resolve();
    expect(rotations).toEqual([]);

    write.next();
    write.complete();
    await pending;

    // The access token only: refresh tokens rotate, and a second refresher would sign
    // the app out, so the push handoff never sees one.
    expect(rotations).toEqual([{ userId: '@me:hs', accessToken: 'a2' }]);
  });

  it('pairs the OAuth token a client starts with with its expiry', async () => {
    const { svc } = setup(fakeClient());

    await firstValueFrom(svc.init(OIDC_SESSION));

    expect(svc.accessTokenState('@me:hs')).toEqual({
      homeserverUrl: 'https://hs.example',
      accessToken: 'tok',
      expiresAt: 1234,
      refreshable: true,
    });
    expect(svc.accessTokenState('@you:other')).toBeNull();
  });

  it('knows no expiry for a password session', async () => {
    const client = { ...fakeClient(), getAccessToken: () => 'tok' };
    const { svc } = setup(client);

    await firstValueFrom(svc.init(SESSION));

    expect(svc.accessTokenState('@me:hs')).toMatchObject({
      accessToken: 'tok',
      expiresAt: null,
      refreshable: false,
    });
  });

  it('moves the expiry to a refreshed token before publishing the rotation', async () => {
    const { svc, storage } = setup(fakeClient());
    const write = new Subject<void>();
    vi.mocked(storage.updateTokens).mockReturnValue(write);
    const seen: unknown[] = [];
    svc.accessTokenRotations.subscribe(({ userId }) =>
      seen.push(svc.accessTokenState(userId)),
    );
    await firstValueFrom(svc.init(OIDC_SESSION));
    const opts = vi.mocked(createClient).mock.calls[0][0];

    const pending = opts.onTokenRefresh?.({
      accessToken: 'a2',
      refreshToken: 'r2',
      expiry: new Date(5_000),
    }) as unknown as Promise<void>;
    await Promise.resolve();
    // Not stored yet: the client still holds the old token.
    expect(svc.accessTokenState('@me:hs')).toMatchObject({
      accessToken: 'tok',
      expiresAt: 1234,
    });

    write.next();
    write.complete();
    await pending;

    expect(seen).toEqual([
      expect.objectContaining({ accessToken: 'a2', expiresAt: 5_000 }),
    ]);
  });

  it('forgets the OAuth tokens when the account is removed', async () => {
    const readded = {
      ...fakeClient(),
      http: { refreshOAuthTokens: vi.fn().mockResolvedValue(true) },
    };
    const { svc } = setup(fakeClient(), readded);
    await firstValueFrom(svc.init(OIDC_SESSION));

    await firstValueFrom(svc.remove('@me:hs'));
    await firstValueFrom(svc.add(SESSION));

    await expect(
      firstValueFrom(svc.refreshAccessToken('@me:hs')),
    ).resolves.toBe(false);
    expect(readded.http.refreshOAuthTokens).not.toHaveBeenCalled();
  });

  it('refreshes nothing for an account that is not a live OAuth account', async () => {
    const client = {
      ...fakeClient(),
      http: { refreshOAuthTokens: vi.fn().mockResolvedValue(true) },
    };
    const { svc } = setup(client);
    await firstValueFrom(svc.init(SESSION));

    await expect(
      firstValueFrom(svc.refreshAccessToken('@me:hs')),
    ).resolves.toBe(false);
    await expect(
      firstValueFrom(svc.refreshAccessToken('@nobody:hs')),
    ).resolves.toBe(false);
    expect(client.http.refreshOAuthTokens).not.toHaveBeenCalled();
  });

  it('refreshes nothing for an OAuth sign-in that came without a refresh token', async () => {
    const client = {
      ...fakeClient(),
      http: { refreshOAuthTokens: vi.fn().mockResolvedValue(true) },
    };
    const { svc } = setup(client);
    const { refreshToken: _unused, ...withoutRefreshToken } = OIDC_SESSION;
    await firstValueFrom(svc.init(withoutRefreshToken));

    await expect(
      firstValueFrom(svc.refreshAccessToken('@me:hs')),
    ).resolves.toBe(false);
    expect(client.http.refreshOAuthTokens).not.toHaveBeenCalled();
    expect(svc.accessTokenState('@me:hs')?.refreshable).toBe(false);
  });

  it('can refresh a live OAuth account with a refresh token until it is removed', async () => {
    const { svc } = setup(fakeClient());
    await firstValueFrom(svc.init(OIDC_SESSION));

    expect(svc.accessTokenState('@me:hs')?.refreshable).toBe(true);

    await firstValueFrom(svc.remove('@me:hs'));

    await expect(
      firstValueFrom(svc.refreshAccessToken('@me:hs')),
    ).resolves.toBe(false);
  });

  describe('a refresh from a client the account no longer runs on', () => {
    const REPLACEMENT = {
      ...OIDC_SESSION,
      accessToken: 'tok-new',
      refreshToken: 'refresh-new',
      accessTokenExpiresAt: 9_999,
    };
    const LATE_TOKENS = {
      accessToken: 'a-late',
      refreshToken: 'r-late',
      expiry: new Date(5_000),
    };
    const OIDC_SESSION_B = {
      ...OIDC_SESSION,
      ...SESSION_B,
      refreshToken: 'refresh-tok2',
    };

    /**
     * The real SessionStorageService (and its lineage compare-and-swap) over in-memory
     * secure storage and Preferences; only the Matrix clients are fakes.
     */
    function setupWithRealStorage() {
      prefs.clear();
      const secrets = new Map<string, string>();
      TestBed.configureTestingModule({
        providers: [
          MatrixClientService,
          SessionStorageService,
          MockProvider(SecureStorageService),
          MockProvider(CryptoStoreKeyService),
        ],
      });
      const secure = TestBed.inject(SecureStorageService);
      vi.mocked(secure.get).mockImplementation(
        async (key) => secrets.get(key) ?? null,
      );
      vi.mocked(secure.set).mockImplementation(async (key, value) => {
        secrets.set(key, value);
      });
      vi.mocked(secure.remove).mockImplementation(async (key) => {
        secrets.delete(key);
      });
      const storeKeys = TestBed.inject(CryptoStoreKeyService);
      vi.mocked(storeKeys.create).mockResolvedValue(new Uint8Array(32));
      vi.mocked(storeKeys.read).mockResolvedValue({
        kind: 'present',
        key: new Uint8Array(32),
      });
      vi.mocked(storeKeys.remove).mockResolvedValue(undefined);
      const svc = TestBed.inject(MatrixClientService);
      const storage = TestBed.inject(SessionStorageService);
      const rotations: AccessTokenRotation[] = [];
      svc.accessTokenRotations.subscribe((rotation) =>
        rotations.push(rotation),
      );
      /** Persist a sign-in and start it the way Account Runtime does. */
      const signIn = async (
        session: MatrixSession,
        activation: 'activate' | 'background' = 'activate',
      ) => {
        const stored = await firstValueFrom(
          storage.persistForEstablishment(session, 'upsert'),
        );
        await expect(
          firstValueFrom(svc.restorePersisted(stored, activation)),
        ).resolves.toEqual({ kind: 'ready' });
        return vi.mocked(createClient).mock.calls.at(-1)![0];
      };
      const storedAccessToken = (userId = '@me:hs') =>
        secrets.get(`matrix.accessToken:${userId}`);
      return { svc, storage, rotations, signIn, storedAccessToken };
    }

    it('persists and publishes a live restored client refresh', async () => {
      vi.mocked(createClient).mockReturnValue(fakeClient() as never);
      const { svc, rotations, signIn, storedAccessToken } =
        setupWithRealStorage();
      const opts = await signIn(OIDC_SESSION);

      await opts.onTokenRefresh?.(LATE_TOKENS);

      expect(storedAccessToken()).toBe('a-late');
      expect(rotations).toEqual([{ userId: '@me:hs', accessToken: 'a-late' }]);
      expect(svc.accessTokenState('@me:hs')).toMatchObject({
        accessToken: 'a-late',
        expiresAt: 5_000,
      });
    });

    it("leaves a same-account re-sign-in's tokens alone", async () => {
      vi.mocked(createClient)
        .mockReturnValueOnce(fakeClient() as never)
        .mockReturnValueOnce(fakeClient() as never);
      const { svc, rotations, signIn, storedAccessToken } =
        setupWithRealStorage();
      const replacedOpts = await signIn(OIDC_SESSION);
      await signIn(REPLACEMENT);

      await expect(
        replacedOpts.onTokenRefresh?.(LATE_TOKENS),
      ).resolves.toBeUndefined();

      expect(storedAccessToken()).toBe('tok-new');
      expect(rotations).toEqual([]);
      expect(svc.accessTokenState('@me:hs')).toMatchObject({
        accessToken: 'tok-new',
        expiresAt: 9_999,
      });
    });

    it("keeps a new sign-in's tokens when the old client refreshes during its save", async () => {
      vi.mocked(createClient)
        .mockReturnValueOnce(fakeClient() as never)
        .mockReturnValueOnce(fakeClient() as never);
      const { svc, storage, rotations, signIn, storedAccessToken } =
        setupWithRealStorage();
      const replacedOpts = await signIn(OIDC_SESSION);

      // The new sign-in's save is queued first; the old client, still live, refreshes
      // before the new client replaces it.
      const [stored] = await Promise.all([
        firstValueFrom(storage.persistForEstablishment(REPLACEMENT, 'upsert')),
        replacedOpts.onTokenRefresh?.(LATE_TOKENS),
      ]);
      await firstValueFrom(svc.restorePersisted(stored, 'activate'));

      expect(storedAccessToken()).toBe('tok-new');
      expect(svc.accessTokenState('@me:hs')).toMatchObject({
        accessToken: 'tok-new',
        expiresAt: 9_999,
      });
      // The old client was still live, so its rotation was published for it.
      expect(rotations).toEqual([{ userId: '@me:hs', accessToken: 'a-late' }]);
    });

    it('publishes nothing for a refresh whose client was replaced while storage wrote it', async () => {
      const { svc, storage } = setup(fakeClient(), fakeClient());
      const write = new Subject<void>();
      vi.mocked(storage.updateTokens).mockReturnValue(write);
      const rotations: AccessTokenRotation[] = [];
      svc.accessTokenRotations.subscribe((rotation) =>
        rotations.push(rotation),
      );
      await firstValueFrom(svc.restorePersisted(OIDC_SESSION, 'activate'));
      const replacedOpts = vi.mocked(createClient).mock.calls[0][0];
      const pending = replacedOpts.onTokenRefresh?.(
        LATE_TOKENS,
      ) as unknown as Promise<void>;
      await firstValueFrom(svc.restorePersisted(REPLACEMENT, 'activate'));

      write.next();
      write.complete();
      await pending;

      expect(rotations).toEqual([]);
      expect(svc.accessTokenState('@me:hs')).toMatchObject({
        accessToken: 'tok-new',
        expiresAt: 9_999,
      });
    });

    it.each([
      [
        'retired by another account replacing it',
        (svc: MatrixClientService) => {
          svc.activateAccount('@you:other', 'replace');
          return Promise.resolve();
        },
      ],
      [
        'rolled back',
        (svc: MatrixClientService) =>
          firstValueFrom(svc.rollbackAccountStart('@me:hs')),
      ],
      ['stopped', (svc: MatrixClientService) => firstValueFrom(svc.stop())],
    ] as const)(
      'persists the refresh of a client %s while its sign-in is stored, publishing nothing',
      async (_, end) => {
        vi.mocked(createClient)
          .mockReturnValueOnce(fakeClient() as never)
          .mockReturnValueOnce(fakeClient('https://other.example') as never);
        const { svc, rotations, signIn, storedAccessToken } =
          setupWithRealStorage();
        const opts = await signIn(OIDC_SESSION);
        await signIn(OIDC_SESSION_B, 'background');
        await end(svc);
        expect(svc.clientFor('@me:hs')).toBeNull();

        await opts.onTokenRefresh?.(LATE_TOKENS);

        // With refresh-token rotation these are the only valid next tokens.
        expect(storedAccessToken()).toBe('a-late');
        expect(rotations).toEqual([]);
      },
    );

    it('writes nothing for a refresh after the account was signed out', async () => {
      vi.mocked(createClient).mockReturnValue(fakeClient() as never);
      const { svc, storage, rotations, signIn, storedAccessToken } =
        setupWithRealStorage();
      const opts = await signIn(OIDC_SESSION);
      await firstValueFrom(svc.remove('@me:hs'));
      await firstValueFrom(storage.remove('@me:hs'));

      await opts.onTokenRefresh?.(LATE_TOKENS);

      expect(storedAccessToken()).toBeUndefined();
      expect(await firstValueFrom(storage.record('@me:hs'))).toBeNull();
      expect(rotations).toEqual([]);
    });

    it('keeps an in-flight OAuth start tracked when init replaces the other accounts', async () => {
      const starting = fakeClient();
      let release!: () => void;
      starting.initRustCrypto.mockReturnValue(
        new Promise<void>((resolve) => (release = resolve)),
      );
      const { svc } = setup(starting, fakeClient('https://other.example'));

      const added = firstValueFrom(svc.add(OIDC_SESSION));
      await vi.waitFor(() =>
        expect(starting.initRustCrypto).toHaveBeenCalled(),
      );
      const replaced = firstValueFrom(svc.init(SESSION_B));
      release();
      await Promise.all([added, replaced]);

      expect(svc.clientFor('@me:hs')).toBe(starting);
      expect(svc.accessTokenState('@me:hs')).toMatchObject({
        accessToken: 'tok',
        expiresAt: 1234,
        refreshable: true,
      });
    });

    it("persists a detached client's refresh without moving the live client's pair", async () => {
      const { svc, storage } = setup(fakeClient());
      vi.mocked(storage.updateTokens).mockReturnValue(of(void 0));
      const rotations: AccessTokenRotation[] = [];
      svc.accessTokenRotations.subscribe((rotation) =>
        rotations.push(rotation),
      );
      const session = { ...OIDC_SESSION, lineage: 'L1' };
      await firstValueFrom(svc.restorePersisted(session, 'activate'));
      svc.detachedClient(session);
      const detachedOpts = vi.mocked(createClient).mock.calls[1][0];

      await detachedOpts.onTokenRefresh?.(LATE_TOKENS);

      expect(storage.updateTokens).toHaveBeenCalledWith(
        '@me:hs',
        'L1',
        'a-late',
        'r-late',
        5_000,
      );
      expect(rotations).toEqual([]);
      expect(svc.accessTokenState('@me:hs')).toMatchObject({
        accessToken: 'tok',
        expiresAt: 1234,
      });
    });
  });

  it('reports a refresh that throws as false instead of an error', async () => {
    const client = {
      ...fakeClient(),
      http: {
        refreshOAuthTokens: vi.fn().mockRejectedValue(new Error('boom')),
      },
    };
    const { svc } = setup(client);
    await firstValueFrom(svc.init(OIDC_SESSION));

    await expect(
      firstValueFrom(svc.refreshAccessToken('@me:hs')),
    ).resolves.toBe(false);
    expect(client.http.refreshOAuthTokens).toHaveBeenCalledOnce();
  });

  describe('signOutAll', () => {
    it('logs out every live client', async () => {
      const a = fakeClient();
      const b = fakeClient('https://other.example');
      const logoutA = vi.fn().mockResolvedValue(undefined);
      const logoutB = vi.fn().mockResolvedValue(undefined);
      (a as unknown as { logout: unknown }).logout = logoutA;
      (b as unknown as { logout: unknown }).logout = logoutB;
      vi.mocked(createClient).mockReturnValueOnce(a as never);
      vi.mocked(createClient).mockReturnValueOnce(b as never);
      const { svc } = setup();
      await firstValueFrom(svc.init(SESSION));
      await firstValueFrom(svc.add(SESSION_B));

      await firstValueFrom(svc.signOutAll());

      // `true` = stop the client from re-authenticating; the device is being discarded.
      expect(logoutA).toHaveBeenCalledWith(true);
      expect(logoutB).toHaveBeenCalledWith(true);
    });

    it('signs nothing out once the clients have been torn down', async () => {
      // The ordering trap this method carries: it reads the live-client registry, and
      // `stop()` empties it. Calling this after a teardown is a silent no-op that looks
      // identical from the outside — a caller that sequences them the wrong way round
      // ships a sign-out phase that never sends a request.
      const client = fakeClient();
      const logout = vi.fn().mockResolvedValue(undefined);
      (client as unknown as { logout: unknown }).logout = logout;
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      await firstValueFrom(svc.stop());

      await firstValueFrom(svc.signOutAll());

      expect(logout).not.toHaveBeenCalled();
    });

    it('resolves even when a homeserver refuses the logout', async () => {
      const client = fakeClient();
      (client as unknown as { logout: unknown }).logout = vi
        .fn()
        .mockRejectedValue(new Error('homeserver down'));
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));

      await expect(firstValueFrom(svc.signOutAll())).resolves.toBeUndefined();
    });
  });

  it('passes no OAuth token wiring for a password or SSO session', async () => {
    const client = fakeClient();
    const { svc } = setup(client);

    await firstValueFrom(svc.init(SESSION));

    const opts = vi.mocked(createClient).mock.calls[0][0];
    expect(opts.refreshToken).toBeUndefined();
    expect(opts.oauthClientId).toBeUndefined();
    expect(opts.onTokenRefresh).toBeUndefined();
    expect(opts.fetchFn).toBeUndefined();
  });

  it('does not publish the client until startClient resolves', async () => {
    const client = fakeClient();
    client.startClient.mockRejectedValue(new Error('sync failed'));
    const { svc } = setup(client);

    await expect(firstValueFrom(svc.init(SESSION))).rejects.toThrow(
      'sync failed',
    );
    // Rolled back: client stopped, 4S key cleared, nothing left half-initialized.
    expect(client.stopClient).toHaveBeenCalled();
    expect(clearHolder).toHaveBeenCalled();
    expect(sessionState().active()).toBeNull();
  });

  it('does not report an Account ready before its projection barrier acknowledges', async () => {
    const client = fakeClient();
    const { svc, projections } = setup(client);
    const barrier = new Subject<ProjectionReadiness>();
    const waitFor = vi.spyOn(projections, 'waitFor').mockReturnValue(barrier);

    let settled = false;
    const start = firstValueFrom(
      svc.restorePersisted(SESSION, 'background'),
    ).then((outcome) => {
      settled = true;
      return outcome;
    });
    await vi.waitFor(() => expect(waitFor).toHaveBeenCalledOnce());
    expect(waitFor).toHaveBeenCalledWith({
      kind: 'exact-account',
      accountId: '@me:hs',
    });
    expect(settled).toBe(false);

    barrier.next({
      scope: { kind: 'exact-account', accountId: '@me:hs' },
      durationMs: 1,
      projectionCount: 1,
      listenerCount: 1,
      retainedBytes: 0,
      acknowledgements: [{ projectionId: 'matrix.sync-state', generation: 1 }],
    });
    barrier.complete();

    await expect(start).resolves.toEqual({ kind: 'ready' });
  });

  it('tears down a prior client when re-initialized', async () => {
    const a = fakeClient();
    const b = fakeClient();
    const { svc } = setup(a, b);

    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.init(SESSION));

    expect(a.stopClient).toHaveBeenCalled(); // old client torn down
    expect(activeClient(svc)).toBe(b);
  });

  it('activates a fully started Account and can retire the other live runtimes', async () => {
    const a = fakeClient();
    const b = fakeClient();
    const { svc } = setup(a, b);
    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B));

    svc.activateAccount('@me:hs', 'replace');

    expect(svc.activeUserId()).toBe('@me:hs');
    expect(svc.accountIds()).toEqual(['@me:hs']);
    expect(b.stopClient).toHaveBeenCalled();
    expect(a.stopClient).not.toHaveBeenCalled();
  });

  it('rejects Active placement for an Account that is not live', () => {
    const { svc } = setup();

    expect(() => svc.activateAccount('@missing:hs', 'keep')).toThrow(
      /not live/i,
    );
  });

  it('rolls back a background Account start without wiping its stores', async () => {
    const client = fakeClient();
    const { svc } = setup(client);
    await firstValueFrom(svc.restorePersisted(SESSION, 'background'));

    await firstValueFrom(svc.rollbackAccountStart('@me:hs'));

    expect(svc.accountIds()).toEqual([]);
    expect(client.stopClient).toHaveBeenCalled();
    expect(client.clearStores).not.toHaveBeenCalled();
  });

  it('bridges sync state into the session state', async () => {
    const client = fakeClient();
    const { svc } = setup(client);
    await firstValueFrom(svc.init(SESSION));

    // Grab the ClientEvent.Sync handler the service registered and fire it.
    const syncCall = client.on.mock.calls.find(([evt]) => evt === 'sync');
    expect(syncCall).toBeTruthy();
    syncCall![1]('SYNCING');
    await Promise.resolve();
    expect(sessionState().syncState()).toBe('syncing');
  });

  describe('counting messages waiting to send', () => {
    function waiting(body: string, offline = true): MatrixEvent {
      const echo = new MatrixEvent({
        type: 'm.room.message',
        content: { msgtype: 'm.text', body },
      });
      echo.status = EventStatus.NOT_SENT;
      echo.error = (
        offline ? new ConnectionError('offline') : new Error('refused')
      ) as never;
      return echo;
    }

    const room = (
      roomId: string,
      events: MatrixEvent[],
      inFlight: MatrixEvent[] = [],
    ) => ({
      roomId,
      txnToEvent: new Map(inFlight.map((event, i) => [`t${i}`, event])),
      getLiveTimeline: () => ({ getEvents: () => events }),
      getThreads: () => [{ liveTimeline: { getEvents: () => inFlight } }],
    });

    function clientWith(...rooms: ReturnType<typeof room>[]) {
      return { ...fakeClient(), getRooms: vi.fn().mockReturnValue(rooms) };
    }

    /** Report a local-echo change, as the SDK does through the client. */
    const echoUpdated = (
      client: ReturnType<typeof fakeClient>,
      event: MatrixEvent,
      oldStatus: EventStatus | null = null,
    ): void =>
      (
        client.on.mock.calls.find(
          ([evt]) => evt === RoomEvent.LocalEchoUpdated,
        )![1] as (
          event: MatrixEvent,
          room: unknown,
          oldEventId?: string,
          oldStatus?: EventStatus | null,
        ) => void
      )(event, {}, undefined, oldStatus);

    it('counts the waiting messages of every room', async () => {
      const client = clientWith(
        room('!a:hs', [waiting('one'), waiting('refused', false)]),
        room('!b:hs', [waiting('two')]),
      );
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));

      echoUpdated(client, waiting('one'));

      expect(sessionState().waitingCount()).toBe(2);
    });

    it('counts a thread echo once', async () => {
      const reply = waiting('in a thread');
      const client = clientWith(room('!a:hs', [], [reply]));
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));

      echoUpdated(client, reply);

      expect(sessionState().waitingCount()).toBe(1);
    });

    it('drops when a message is sent or cancelled', async () => {
      const sent = waiting('sent');
      const cancelled = waiting('cancelled');
      const client = clientWith(room('!a:hs', [sent, cancelled]));
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      echoUpdated(client, sent);
      expect(sessionState().waitingCount()).toBe(2);

      sent.status = EventStatus.SENT;
      echoUpdated(client, sent, EventStatus.NOT_SENT);
      expect(sessionState().waitingCount()).toBe(1);

      cancelled.status = EventStatus.CANCELLED;
      echoUpdated(client, cancelled, EventStatus.NOT_SENT);
      expect(sessionState().waitingCount()).toBe(0);
    });

    it('follows the active account and stops listening when it is removed', async () => {
      const mine = clientWith(room('!a:hs', [waiting('mine')]));
      const yours = clientWith(
        room('!b:hs', [waiting('y1'), waiting('y2'), waiting('y3')]),
      );
      const { svc } = setup(mine, yours);
      await firstValueFrom(svc.init(SESSION));
      await firstValueFrom(svc.add(SESSION_B));
      echoUpdated(mine, waiting('m'));
      echoUpdated(yours, waiting('y'));

      svc.setActive(SESSION.userId);
      expect(sessionState().waitingCount()).toBe(1);
      svc.setActive(SESSION_B.userId);
      expect(sessionState().waitingCount()).toBe(3);

      await firstValueFrom(svc.remove(SESSION_B.userId));
      expect(yours.off).toHaveBeenCalledWith(
        RoomEvent.LocalEchoUpdated,
        expect.any(Function),
      );
    });

    it('does not rescan the rooms while an ordinary send goes through', async () => {
      const client = clientWith(room('!a:hs', []));
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      const send = new MatrixEvent({
        type: 'm.room.message',
        content: { msgtype: 'm.text', body: 'hi' },
      });
      client.getRooms.mockClear();

      for (const [status, old] of [
        [EventStatus.ENCRYPTING, null],
        [EventStatus.SENDING, EventStatus.ENCRYPTING],
        [EventStatus.SENT, EventStatus.SENDING],
        [null, EventStatus.SENT],
      ] as const) {
        send.status = status;
        echoUpdated(client, send, old);
      }

      expect(client.getRooms).not.toHaveBeenCalled();
    });

    it('stops listening when the client stops', async () => {
      const client = clientWith();
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));

      await firstValueFrom(svc.stop());

      expect(client.off).toHaveBeenCalledWith(
        RoomEvent.LocalEchoUpdated,
        expect.any(Function),
      );
    });

    it('stops listening when the start fails', async () => {
      const client = clientWith();
      client.startClient.mockRejectedValue(new Error('no'));
      const { svc } = setup(client);

      await expect(firstValueFrom(svc.init(SESSION))).rejects.toThrow();

      expect(client.off).toHaveBeenCalledWith(
        RoomEvent.LocalEchoUpdated,
        expect.any(Function),
      );
    });
  });

  describe('resending messages that failed offline', () => {
    function waiting(body: string): MatrixEvent {
      const echo = new MatrixEvent({
        type: 'm.room.message',
        content: { msgtype: 'm.text', body },
      });
      echo.status = EventStatus.NOT_SENT;
      echo.error = new ConnectionError('offline') as never;
      return echo;
    }

    /** A live client whose one room holds `count` texts that failed with a ConnectionError. */
    async function offlineClient(count = 1) {
      const echoes = Array.from({ length: count }, (_, i) => waiting(`m${i}`));
      const room = {
        roomId: '!room:hs',
        getLiveTimeline: () => ({ getEvents: () => echoes }),
        getThreads: () => [],
        // Joined and already encrypted, so the encryption repair a sync runs passes it over.
        getMyMembership: () => 'join',
        hasEncryptionStateEvent: () => true,
      };
      const client = {
        ...fakeClient(),
        getRooms: vi.fn().mockReturnValue([room]),
        resendEvent: vi.fn().mockResolvedValue(undefined),
      };
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      const onSync = client.on.mock.calls.find(
        ([evt]) => evt === ClientEvent.Sync,
      )![1] as (state: SyncState, previous: SyncState | null) => void;
      let current: SyncState | null = null;
      /** Report each state in turn, as the SDK does, with the one before it. */
      const sync = (...states: SyncState[]): void => {
        for (const state of states) {
          onSync(state, current);
          current = state;
        }
      };
      const onEcho = client.on.mock.calls.find(
        ([evt]) => evt === RoomEvent.LocalEchoUpdated,
      )![1] as (
        event: MatrixEvent,
        room: unknown,
        oldEventId: string | undefined,
        oldStatus: EventStatus,
      ) => void;
      /** Report each echo's send failing, as the SDK does, so the account counts it waiting. */
      const fail = (): void => {
        for (const echo of echoes) {
          onEcho(echo, room, undefined, EventStatus.SENDING);
        }
      };
      return { svc, client, sync, fail };
    }

    /** A `resendEvent` result the test settles itself. */
    function pending() {
      let release!: () => void;
      const promise = new Promise<void>((resolve) => (release = resolve));
      return { promise, release };
    }

    const flush = () => new Promise((resolve) => setTimeout(resolve));

    it.each([SyncState.Reconnecting, SyncState.Error, SyncState.Catchup])(
      'resends once when sync returns from %s',
      async (lost) => {
        const { client, sync } = await offlineClient();

        sync(SyncState.Prepared, SyncState.Syncing, lost, SyncState.Syncing);
        await vi.waitFor(() => expect(client.resendEvent).toHaveBeenCalled());
        sync(SyncState.Syncing);
        await flush();

        expect(client.resendEvent).toHaveBeenCalledOnce();
      },
    );

    it('resends once when the app started offline and its first sync arrives', async () => {
      const { client, sync } = await offlineClient();

      // The cached sync prepares; the first /sync that gets through prepares again.
      sync(
        SyncState.Prepared,
        SyncState.Error,
        SyncState.Prepared,
        SyncState.Syncing,
      );
      await flush();

      expect(client.resendEvent).toHaveBeenCalledOnce();
    });

    it('lets a second reconnect resend only after the first run ends', async () => {
      const { client, sync } = await offlineClient();
      const first = pending();
      client.resendEvent.mockReturnValueOnce(first.promise);

      sync(SyncState.Reconnecting, SyncState.Syncing);
      await vi.waitFor(() => expect(client.resendEvent).toHaveBeenCalled());
      sync(SyncState.Error, SyncState.Syncing);
      await flush();
      expect(client.resendEvent).toHaveBeenCalledOnce();

      first.release();
      await vi.waitFor(() =>
        expect(client.resendEvent).toHaveBeenCalledTimes(2),
      );
    });

    it('resends a message that failed while sync stayed up, on the next sync', async () => {
      const { client, sync, fail } = await offlineClient();
      sync(SyncState.Prepared, SyncState.Syncing);

      fail();
      sync(SyncState.Syncing);
      await flush();

      expect(client.resendEvent).toHaveBeenCalledOnce();
    });

    it('chains no resend on a sync while the account has nothing waiting', async () => {
      // The room still lists an echo, but the account's count says none waits.
      const { client, sync } = await offlineClient();

      sync(SyncState.Prepared, SyncState.Syncing, SyncState.Syncing);
      await flush();

      expect(client.resendEvent).not.toHaveBeenCalled();
    });

    it('queues at most one more resend however many syncs arrive mid-run', async () => {
      const { client, sync, fail } = await offlineClient();
      const first = pending();
      client.resendEvent.mockReturnValueOnce(first.promise);
      sync(SyncState.Prepared, SyncState.Syncing);
      fail();

      sync(SyncState.Syncing);
      await vi.waitFor(() => expect(client.resendEvent).toHaveBeenCalled());
      sync(SyncState.Syncing, SyncState.Syncing, SyncState.Syncing);
      first.release();
      await flush();

      // The run in flight, then the one queued behind it; the rest were not added.
      expect(client.resendEvent).toHaveBeenCalledTimes(2);
    });

    it('does not resend on the first sync', async () => {
      const { client, sync } = await offlineClient();

      sync(SyncState.Prepared, SyncState.Syncing);
      await flush();

      expect(client.resendEvent).not.toHaveBeenCalled();
    });

    it('does not resend on a sync that follows another', async () => {
      const { client, sync } = await offlineClient();

      sync(SyncState.Syncing, SyncState.Syncing);
      await flush();

      expect(client.resendEvent).not.toHaveBeenCalled();
    });

    it('sends nothing more once the account is removed mid-run', async () => {
      const { svc, client, sync } = await offlineClient(2);
      const first = pending();
      client.resendEvent.mockReturnValueOnce(first.promise);

      sync(SyncState.Reconnecting, SyncState.Syncing);
      await vi.waitFor(() => expect(client.resendEvent).toHaveBeenCalled());
      await firstValueFrom(svc.remove('@me:hs'));
      first.release();
      await flush();

      expect(client.resendEvent).toHaveBeenCalledOnce();
    });

    it('sends nothing more once sync is paused mid-run', async () => {
      const { svc, client, sync } = await offlineClient(2);
      const first = pending();
      client.resendEvent.mockReturnValueOnce(first.promise);

      sync(SyncState.Reconnecting, SyncState.Syncing);
      await vi.waitFor(() => expect(client.resendEvent).toHaveBeenCalled());
      svc.pauseSync();
      first.release();
      await flush();

      expect(client.resendEvent).toHaveBeenCalledOnce();
    });

    it('never runs a queued resend after stop()', async () => {
      const { svc, client, sync } = await offlineClient();
      const first = pending();
      client.resendEvent.mockReturnValueOnce(first.promise);

      sync(SyncState.Reconnecting, SyncState.Syncing);
      await vi.waitFor(() => expect(client.resendEvent).toHaveBeenCalled());
      sync(SyncState.Reconnecting, SyncState.Syncing);
      await firstValueFrom(svc.stop());
      first.release();
      await flush();

      expect(client.resendEvent).toHaveBeenCalledOnce();
    });
  });

  it('stop() tears down without clearing the stores', async () => {
    const client = fakeClient();
    const { svc } = setup(client);
    await firstValueFrom(svc.init(SESSION));

    await firstValueFrom(svc.stop());

    expect(client.stopClient).toHaveBeenCalled();
    expect(client.clearStores).not.toHaveBeenCalled();
    expect(sessionState().active()).toBeNull();
  });

  it('remove() stops the client and wipes the stores + 4S key', async () => {
    const client = fakeClient();
    const { svc } = setup(client);
    await firstValueFrom(svc.init(SESSION));
    clearHolder.mockClear();

    await firstValueFrom(svc.remove(SESSION.userId));

    expect(client.stopClient).toHaveBeenCalled();
    expect(client.clearStores).toHaveBeenCalledOnce();
    expect(clearHolder).toHaveBeenCalled();
    expect(sessionState().active()).toBeNull();
  });

  it("wipes the account's OWN Rust crypto store (its cryptoDatabasePrefix), not the SDK default", async () => {
    const client = fakeClient();
    const { svc } = setup(client);
    await firstValueFrom(
      svc.init({ ...SESSION, cryptoPrefix: 'trinity-crypto:@me:hs' }),
    );

    await firstValueFrom(svc.remove(SESSION.userId));

    // clearStores() must target THIS account's per-account prefix. Called with no
    // args, the SDK deletes only the default-prefix Rust crypto DB and orphans this
    // account's real store — so a later fresh login (new device id, same
    // userId-derived prefix) reopens a store whose device id mismatches the new one,
    // and initRustCrypto throws "the account in the store doesn't match the account
    // in the constructor".
    expect(client.clearStores).toHaveBeenCalledWith({
      cryptoDatabasePrefix: 'trinity-crypto:@me:hs',
    });
  });

  it('wipes with an undefined prefix for a migrated legacy account (SDK default store)', async () => {
    const client = fakeClient();
    const { svc } = setup(client);
    await firstValueFrom(svc.init(SESSION)); // no cryptoPrefix → SDK default store

    await firstValueFrom(svc.remove(SESSION.userId));

    // A legacy account really lives on the default prefix, so wiping must pass it
    // through unchanged (the SDK falls back to its default) — not invent a prefix.
    expect(client.clearStores).toHaveBeenCalledWith({
      cryptoDatabasePrefix: undefined,
    });
  });

  /** Grab the HttpApiEvent.SessionLoggedOut handler the service registered. */
  function loggedOutHandler(client: ReturnType<typeof fakeClient>) {
    return client.on.mock.calls.find(
      ([evt]) => evt === HttpApiEvent.SessionLoggedOut,
    )?.[1] as (err: unknown) => void;
  }

  function recordEffects(svc: MatrixClientService): SessionStorageEffect[] {
    const effects: SessionStorageEffect[] = [];
    svc.storageEffects.subscribe((effect) => effects.push(effect));
    return effects;
  }

  it('soft-logout stops the account without wiping and marks it for re-auth', async () => {
    const client = fakeClient();
    const { svc } = setup(client);
    await firstValueFrom(svc.init(SESSION));
    const effects = recordEffects(svc);

    loggedOutHandler(client)({ data: { soft_logout: true } });

    expect(client.stopClient).toHaveBeenCalled();
    expect(client.clearStores).not.toHaveBeenCalled(); // stores preserved for re-auth
    expect(effects).toEqual([
      { kind: 'soft-logout', accountId: '@me:hs', activeAccountId: null },
    ]);
    expect(svc.softLoggedOut()).toContain('@me:hs');
    expect(sessionState().active()).toBeNull(); // it was the only account
  });

  it('soft-logout of the active account repoints active to a survivor and reports it', async () => {
    const a = fakeClient();
    const b = fakeClient();
    const { svc } = setup(a, b);
    await firstValueFrom(svc.init(SESSION)); // A active
    await firstValueFrom(svc.add(SESSION_B)); // B added, now active
    const effects = recordEffects(svc);

    loggedOutHandler(b)({ data: { soft_logout: true } });

    expect(svc.activeUserId()).toBe('@me:hs'); // A survives and becomes active
    expect(svc.softLoggedOut()).toContain('@you:other');
    expect(effects).toEqual([
      {
        kind: 'soft-logout',
        accountId: '@you:other',
        activeAccountId: '@me:hs',
      },
    ]);
    expect(sessionState().active()).not.toBeNull();
  });

  it('hard-logout wipes the account and drops its registry entry', async () => {
    const client = fakeClient();
    const { svc } = setup(client);
    await firstValueFrom(svc.init(SESSION));
    const effects = recordEffects(svc);

    loggedOutHandler(client)({ data: { soft_logout: false } });

    expect(client.stopClient).toHaveBeenCalled();
    expect(client.clearStores).toHaveBeenCalledOnce(); // wiped
    expect(effects).toEqual([
      { kind: 'hard-logout', accountId: '@me:hs', activeAccountId: null },
    ]);
    expect(svc.softLoggedOut()).not.toContain('@me:hs');
  });

  it('re-authenticating a soft-logged-out account clears the flag', async () => {
    const a = fakeClient();
    const b = fakeClient();
    const { svc } = setup(a, b);
    await firstValueFrom(svc.init(SESSION));

    loggedOutHandler(a)({ data: { soft_logout: true } });
    expect(svc.softLoggedOut()).toContain('@me:hs');

    // Re-auth = the same account logging back in (its store + registry survived).
    await firstValueFrom(svc.init(SESSION));

    expect(svc.softLoggedOut()).not.toContain('@me:hs');
    expect(sessionState().active()).not.toBeNull();
  });

  describe('a held server logout', () => {
    it('stops the account without wiping or touching the registry, and reports it', async () => {
      const client = fakeClient();
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      const onFact = vi.fn();
      const hold = svc.holdServerLogout('@me:hs', onFact);
      const effects = recordEffects(svc);

      loggedOutHandler(client)({ data: { soft_logout: false } });

      expect(client.stopClient).toHaveBeenCalled();
      expect(client.clearStores).not.toHaveBeenCalled();
      expect(effects).toEqual([]);
      expect(hold.tokenDied()).toBe(true);
      expect(onFact).toHaveBeenCalledExactlyOnceWith('token-died');
      expect(svc.accountIds()).toEqual(['@me:hs']);
    });

    it('replays the recorded logout through the hard path when released as not deleted', async () => {
      const client = fakeClient();
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      const hold = svc.holdServerLogout('@me:hs');
      const effects = recordEffects(svc);
      loggedOutHandler(client)({ data: { soft_logout: false } });

      hold.release({ deleted: false });

      expect(client.clearStores).toHaveBeenCalledOnce();
      expect(effects).toEqual([
        { kind: 'hard-logout', accountId: '@me:hs', activeAccountId: null },
      ]);
    });

    it('forgets the recorded logout once the account signs in again', async () => {
      const old = fakeClient();
      const signedIn = fakeClient();
      const { svc } = setup(old, signedIn);
      await firstValueFrom(svc.init(SESSION));
      const onFact = vi.fn();
      const hold = svc.holdServerLogout('@me:hs', onFact);
      const effects = recordEffects(svc);
      loggedOutHandler(old)({ data: { soft_logout: false } });
      await firstValueFrom(svc.add(SESSION));

      hold.release({ deleted: false });

      expect(hold.tokenDied()).toBe(false);
      expect(onFact.mock.calls).toEqual([['token-died'], ['token-renewed']]);
      expect(signedIn.stopClient).not.toHaveBeenCalled();
      expect(signedIn.clearStores).not.toHaveBeenCalled();
      expect(effects).toEqual([]);
      expect(svc.accountIds()).toEqual(['@me:hs']);
    });

    it('still holds and replays a logout of the account that signed in again', async () => {
      const old = fakeClient();
      const signedIn = fakeClient();
      const { svc } = setup(old, signedIn);
      await firstValueFrom(svc.init(SESSION));
      const hold = svc.holdServerLogout('@me:hs');
      loggedOutHandler(old)({ data: { soft_logout: false } });
      await firstValueFrom(svc.add(SESSION));

      const effects = recordEffects(svc);
      loggedOutHandler(signedIn)({ data: { soft_logout: false } });
      expect(hold.tokenDied()).toBe(true);
      expect(effects).toEqual([]);
      hold.release({ deleted: false });

      expect(signedIn.clearStores).toHaveBeenCalledOnce();
      expect(effects).toEqual([
        { kind: 'hard-logout', accountId: '@me:hs', activeAccountId: null },
      ]);
    });

    it('stops being held once released or once the account is removed another way', async () => {
      const { svc } = setup(fakeClient());
      await firstValueFrom(svc.init(SESSION));
      const released = svc.holdServerLogout('@me:hs');
      const onFact = vi.fn();
      const removed = svc.holdServerLogout('@me:hs', onFact);
      expect(removed.isHeld()).toBe(true);

      released.release({ deleted: false });
      await firstValueFrom(svc.remove('@me:hs'));

      expect(released.isHeld()).toBe(false);
      expect(removed.isHeld()).toBe(false);
      expect(onFact).toHaveBeenCalledExactlyOnceWith('released');
    });

    it('leaves the account to the deletion cleanup when released as deleted', async () => {
      const client = fakeClient();
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      const hold = svc.holdServerLogout('@me:hs');
      const effects = recordEffects(svc);
      loggedOutHandler(client)({ data: { soft_logout: false } });

      hold.release({ deleted: true });

      expect(client.clearStores).not.toHaveBeenCalled();
      expect(effects).toEqual([]);
    });

    it('does nothing on release when the token never died', async () => {
      const client = fakeClient();
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      const effects = recordEffects(svc);

      svc.holdServerLogout('@me:hs').release({ deleted: false });

      expect(client.stopClient).not.toHaveBeenCalled();
      expect(effects).toEqual([]);
      expect(sessionState().active()).not.toBeNull();
    });

    it('takes the hard path again once released', async () => {
      const client = fakeClient();
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      svc.holdServerLogout('@me:hs').release({ deleted: false });
      const effects = recordEffects(svc);

      loggedOutHandler(client)({ data: { soft_logout: false } });

      expect(effects).toEqual([
        { kind: 'hard-logout', accountId: '@me:hs', activeAccountId: null },
      ]);
    });

    it('leaves a soft logout to the ordinary soft path', async () => {
      const client = fakeClient();
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      const hold = svc.holdServerLogout('@me:hs');
      const effects = recordEffects(svc);

      loggedOutHandler(client)({ data: { soft_logout: true } });

      expect(svc.softLoggedOut()).toContain('@me:hs');
      expect(hold.tokenDied()).toBe(false);
      expect(effects).toEqual([
        { kind: 'soft-logout', accountId: '@me:hs', activeAccountId: null },
      ]);
    });

    it('reports a sign-in after a soft logout, but not a plain start', async () => {
      const a = fakeClient();
      const b = fakeClient();
      const { svc } = setup(a, b, fakeClient());
      await firstValueFrom(svc.init(SESSION));
      const onFact = vi.fn();
      svc.holdServerLogout('@me:hs', onFact);

      await firstValueFrom(svc.add(SESSION));
      expect(onFact).not.toHaveBeenCalled();

      loggedOutHandler(b)({ data: { soft_logout: true } });
      await firstValueFrom(svc.add(SESSION));

      expect(onFact).toHaveBeenCalledExactlyOnceWith('signed-in-again');
    });

    it('holds only the named account', async () => {
      const a = fakeClient();
      const b = fakeClient();
      const { svc } = setup(a, b);
      await firstValueFrom(svc.init(SESSION));
      await firstValueFrom(svc.add(SESSION_B));
      svc.holdServerLogout('@me:hs');
      const effects = recordEffects(svc);

      loggedOutHandler(b)({ data: { soft_logout: false } });

      expect(effects).toEqual([
        {
          kind: 'hard-logout',
          accountId: '@you:other',
          activeAccountId: '@me:hs',
        },
      ]);
    });
  });

  it('saves each server logout once, through the session storage effects', async () => {
    const a = fakeClient();
    const b = fakeClient();
    const { svc, storage } = setup(a, b);
    vi.mocked(storage.invalidateToken).mockReturnValue(of(undefined));
    vi.mocked(storage.remove).mockReturnValue(of(undefined));
    vi.mocked(storage.setActive).mockReturnValue(of(undefined));
    TestBed.inject(SessionStorageEffects);
    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B)); // B active

    loggedOutHandler(b)({ data: { soft_logout: true } }); // A becomes active
    loggedOutHandler(a)({ data: { soft_logout: false } }); // nobody is active

    expect(storage.invalidateToken).toHaveBeenCalledExactlyOnceWith(
      '@you:other',
    );
    expect(storage.setActive).toHaveBeenCalledExactlyOnceWith('@me:hs');
    expect(storage.remove).toHaveBeenCalledExactlyOnceWith('@me:hs');
  });

  describe('accountStatus', () => {
    it('reports an account whose token the server still accepts', async () => {
      const client = { ...fakeClient(), whoami: vi.fn().mockResolvedValue({}) };
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));

      await expect(firstValueFrom(svc.accountStatus('@me:hs'))).resolves.toBe(
        'active',
      );
    });

    it.each(['M_UNKNOWN_TOKEN', 'M_USER_DEACTIVATED'])(
      'reports the account gone on %s',
      async (errcode) => {
        const client = {
          ...fakeClient(),
          whoami: vi.fn().mockRejectedValue(new MatrixError({ errcode }, 401)),
        };
        const { svc } = setup(client);
        await firstValueFrom(svc.init(SESSION));

        await expect(firstValueFrom(svc.accountStatus('@me:hs'))).resolves.toBe(
          'gone',
        );
      },
    );

    it('reports an unreachable server', async () => {
      const client = {
        ...fakeClient(),
        whoami: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      };
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));

      await expect(firstValueFrom(svc.accountStatus('@me:hs'))).resolves.toBe(
        'unreachable',
      );
    });

    it('asks the named account, not the active one', async () => {
      const a = { ...fakeClient(), whoami: vi.fn().mockResolvedValue({}) };
      const b = { ...fakeClient(), whoami: vi.fn().mockResolvedValue({}) };
      const { svc } = setup(a, b);
      await firstValueFrom(svc.init(SESSION));
      await firstValueFrom(svc.add(SESSION_B));
      svc.setActive('@you:other');

      await firstValueFrom(svc.accountStatus('@me:hs'));

      expect(a.whoami).toHaveBeenCalledOnce();
      expect(b.whoami).not.toHaveBeenCalled();
    });
  });

  it('maps sync state to connectivity (offline while erroring/reconnecting)', async () => {
    const client = fakeClient();
    const { svc } = setup(client);
    await firstValueFrom(svc.init(SESSION));

    // Before any sync transition the app reads online (no startup offline flash).
    expect(sessionState().connectivity()).toBe('online');

    // Drive the Sync listener the service registered during init().
    const onSync = client.on.mock.calls.find(
      (c: unknown[]) => c[0] === ClientEvent.Sync,
    )?.[1] as (state: SyncState) => void;

    onSync(SyncState.Error);
    await Promise.resolve();
    expect(sessionState().connectivity()).toBe('offline');
    onSync(SyncState.Reconnecting);
    await Promise.resolve();
    expect(sessionState().connectivity()).toBe('offline');
    onSync(SyncState.Syncing);
    await Promise.resolve();
    expect(sessionState().connectivity()).toBe('online');
  });

  it('logs in even when the sync-store startup fails (cache is best-effort)', async () => {
    vi.stubGlobal('indexedDB', {}); // present → an IndexedDBStore is built
    storeMock.startup.mockRejectedValue(new Error('IndexedDB corrupt'));
    const client = fakeClient();
    const { svc } = setup(client);

    await expect(firstValueFrom(svc.init(SESSION))).resolves.toBeUndefined();
    expect(sessionState().active()).not.toBeNull(); // a broken cache must not block login
    expect(client.startClient).toHaveBeenCalledOnce();
  });

  it('closes the sync store on teardown (no leaked IndexedDB connection)', async () => {
    vi.stubGlobal('indexedDB', {});
    const client = fakeClient();
    const { svc } = setup(client);
    await firstValueFrom(svc.init(SESSION));

    await firstValueFrom(svc.stop());
    await Promise.resolve(); // let the best-effort destroy() microtask run

    expect(storeMock.destroy).toHaveBeenCalled();
  });

  // --- multi-account registry -----------------------------------------------

  /** The account's registered ClientEvent.Sync listener. */
  const syncOf = (client: ReturnType<typeof fakeClient>) =>
    client.on.mock.calls.find(
      (c: unknown[]) => c[0] === ClientEvent.Sync,
    )?.[1] as (s: SyncState) => void;

  it('add() keeps existing accounts running and activates the new one', async () => {
    const a = fakeClient();
    const b = fakeClient();
    const { svc } = setup(a, b);

    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B));

    expect(a.stopClient).not.toHaveBeenCalled(); // first account kept running
    expect(activeClient(svc)).toBe(b); // new account active
    expect(svc.activeUserId()).toBe('@you:other');
    expect([...svc.accountIds()].sort()).toEqual(['@me:hs', '@you:other']);
    expect(svc.all().length).toBe(2);
  });

  it('measures projection listeners and retained payload per live Account', async () => {
    const a = fakeClient();
    const b = fakeClient();
    const { svc, projections } = setup(a, b);

    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B));
    expect(projections.diagnostics()).toMatchObject({
      activeProjections: 2,
      listenerCount:
        2 * MATRIX_SYNC_PROJECTION_BASELINE.listenerCountPerLiveAccount,
      retainedBytes: 0,
    });

    const publishSync = syncOf(a);
    publishSync(SyncState.Reconnecting);
    await Promise.resolve();
    publishSync(SyncState.Prepared);
    expect(projections.diagnostics().retainedBytes).toBe(
      MATRIX_SYNC_PROJECTION_BASELINE.maxRetainedBytesPerLiveAccount,
    );
    await Promise.resolve();

    for (const state of Object.values(SyncState)) {
      publishSync(state);
      await Promise.resolve();
      expect(projections.diagnostics().retainedBytes).toBeLessThanOrEqual(
        MATRIX_SYNC_PROJECTION_BASELINE.maxRetainedBytesPerLiveAccount,
      );
    }

    await firstValueFrom(svc.stop());
    expect(projections.diagnostics()).toMatchObject({
      activeProjections: 0,
      listenerCount: 0,
      retainedBytes: 0,
    });
  });

  describe('first server sync', () => {
    type SyncListener = (
      state: SyncState,
      previous: SyncState | null,
      data?: { readonly fromCache?: boolean },
    ) => void;
    const syncWithDataOf = (client: ReturnType<typeof fakeClient>) =>
      syncOf(client) as unknown as SyncListener;

    it('names a SYNCING or a PREPARED that did not come from the cache', () => {
      expect(isServerSync(SyncState.Syncing)).toBe(true);
      expect(isServerSync(SyncState.Prepared)).toBe(true);
      expect(isServerSync(SyncState.Prepared, {})).toBe(true);
      expect(isServerSync(SyncState.Prepared, { fromCache: true })).toBe(false);
      for (const state of [
        SyncState.Reconnecting,
        SyncState.Error,
        SyncState.Stopped,
        SyncState.Catchup,
      ]) {
        expect(isServerSync(state)).toBe(false);
      }
    });

    it('does not report a server sync for a PREPARED replayed from the cache', async () => {
      const client = fakeClient();
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      expect(sessionState().status('@me:hs')?.serverSynced).toBe(false);

      syncWithDataOf(client)(SyncState.Prepared, null, { fromCache: true });
      await Promise.resolve();

      expect(sessionState().syncState()).toBe('prepared');
      expect(sessionState().status('@me:hs')?.serverSynced).toBe(false);
    });

    it.each([
      ['a PREPARED from the homeserver', SyncState.Prepared],
      ['a SYNCING', SyncState.Syncing],
    ])('latches the first server sync: %s', async (_name, state) => {
      const client = fakeClient();
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      const sync = syncWithDataOf(client);

      sync(SyncState.Prepared, null, { fromCache: true });
      sync(state, SyncState.Prepared, {});
      await Promise.resolve();

      expect(sessionState().status('@me:hs')?.serverSynced).toBe(true);
    });

    it('keeps it through RECONNECTING, ERROR and STOPPED', async () => {
      const client = fakeClient();
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      const sync = syncWithDataOf(client);
      sync(SyncState.Prepared, null, {});
      await Promise.resolve();

      for (const state of [
        SyncState.Reconnecting,
        SyncState.Error,
        SyncState.Catchup,
        SyncState.Stopped,
      ]) {
        sync(state, null, {});
        await Promise.resolve();
        expect(sessionState().status('@me:hs')?.serverSynced).toBe(true);
      }
    });

    it('a same-account replacement client starts unsynced; a removed account reports false', async () => {
      const a1 = fakeClient();
      const a2 = fakeClient();
      const b = fakeClient();
      const { svc, storage } = setup(a1, b, a2);
      vi.mocked(storage.remove).mockReturnValue(of(undefined));
      await firstValueFrom(svc.init(SESSION));
      await firstValueFrom(svc.add(SESSION_B));
      syncWithDataOf(a1)(SyncState.Syncing, null, {});
      syncWithDataOf(b)(SyncState.Syncing, null, {});
      await Promise.resolve();
      const synced = TestBed.runInInjectionContext(() =>
        computed(() => sessionState().status('@me:hs')?.serverSynced),
      );
      expect(synced()).toBe(true);

      await firstValueFrom(svc.add(SESSION));
      expect(synced()).toBe(false);
      syncWithDataOf(a2)(SyncState.Prepared, null, {});
      await Promise.resolve();
      expect(synced()).toBe(true);

      await firstValueFrom(svc.remove('@you:other'));
      expect(sessionState().status('@you:other')).toBeNull();
      expect(sessionState().status('@nobody:hs')).toBeNull();
    });

    it('reports rooms prepared once the cache replays, before any server sync', async () => {
      const client = fakeClient();
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      const prepared = TestBed.runInInjectionContext(() =>
        computed(() => sessionState().status('@me:hs')?.roomsPrepared),
      );
      expect(prepared()).toBe(false);

      syncWithDataOf(client)(SyncState.Prepared, null, { fromCache: true });
      await Promise.resolve();
      expect(prepared()).toBe(true);
      expect(sessionState().status('@me:hs')?.serverSynced).toBe(false);

      syncWithDataOf(client)(SyncState.Error, SyncState.Prepared, {});
      await Promise.resolve();
      expect(prepared()).toBe(true);
      expect(sessionState().status('@nobody:hs')).toBeNull();
    });

    it('reports rooms prepared after a first server sync without a cache', async () => {
      const client = fakeClient();
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));

      syncWithDataOf(client)(SyncState.Error, null, {});
      await Promise.resolve();
      expect(sessionState().status('@me:hs')?.roomsPrepared).toBe(false);

      syncWithDataOf(client)(SyncState.Prepared, SyncState.Error, {});
      await Promise.resolve();
      expect(sessionState().status('@me:hs')?.roomsPrepared).toBe(true);
    });

    it('still uses one listener and the same retained bytes per live account', async () => {
      const client = fakeClient();
      const { svc, projections } = setup(client);
      await firstValueFrom(svc.init(SESSION));

      syncWithDataOf(client)(SyncState.Prepared, null, {});
      await Promise.resolve();

      expect(sessionState().status('@me:hs')?.serverSynced).toBe(true);
      expect(
        client.on.mock.calls.filter(([event]) => event === ClientEvent.Sync),
      ).toHaveLength(1);
      expect(projections.diagnostics()).toMatchObject({
        listenerCount:
          MATRIX_SYNC_PROJECTION_BASELINE.listenerCountPerLiveAccount,
        retainedBytes: SyncState.Prepared.length * 2,
      });
    });
  });

  it('setActive() switches the active client (no-op if unknown)', async () => {
    const a = fakeClient();
    const b = fakeClient();
    const { svc } = setup(a, b);
    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B)); // B active

    svc.setActive('@me:hs');
    expect(activeClient(svc)).toBe(a);
    expect(svc.activeUserId()).toBe('@me:hs');

    svc.setActive('@nobody:hs'); // unknown → no change
    expect(svc.activeUserId()).toBe('@me:hs');
  });

  it('remove() signs one account out (wipes its stores); others survive', async () => {
    const a = fakeClient();
    const b = fakeClient();
    const { svc } = setup(a, b);
    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B)); // B active

    await firstValueFrom(svc.remove('@you:other'));

    expect(b.stopClient).toHaveBeenCalled();
    expect(b.clearStores).toHaveBeenCalledOnce(); // its stores wiped
    expect(a.clearStores).not.toHaveBeenCalled(); // the other account untouched
    expect(activeClient(svc)).toBe(a); // active repointed to the survivor
    expect([...svc.accountIds()]).toEqual(['@me:hs']);
  });

  it('add() for an already-signed-in account replaces its client (no leak)', async () => {
    const a1 = fakeClient();
    const a2 = fakeClient();
    const { svc } = setup(a1, a2);
    await firstValueFrom(svc.init(SESSION)); // A via a1
    await firstValueFrom(svc.add(SESSION)); // re-add the same account via a2

    expect(a1.stopClient).toHaveBeenCalled(); // old client torn down, not orphaned
    expect(a1.off).toHaveBeenCalled(); // its Sync listener detached
    expect(activeClient(svc)).toBe(a2);
    expect([...svc.accountIds()]).toEqual(['@me:hs']); // still a single account
    expect(svc.all().length).toBe(1);
  });

  it('re-adds an account after signing it out (awaits its store wipe)', async () => {
    const a1 = fakeClient();
    const a2 = fakeClient();
    const { svc } = setup(a1, a2);
    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.remove(SESSION.userId)); // sign out (background store wipe)
    await firstValueFrom(svc.add(SESSION)); // sign back in

    expect(a1.clearStores).toHaveBeenCalled(); // its stores were wiped
    expect(activeClient(svc)).toBe(a2);
    expect(sessionState().active()).not.toBeNull();
  });

  it('gives a re-added account a later session generation', async () => {
    const { svc } = setup(fakeClient(), fakeClient());
    await firstValueFrom(svc.init(SESSION));
    const first = sessionState().status('@me:hs')?.generation;
    expect(typeof first).toBe('number');

    await firstValueFrom(svc.remove(SESSION.userId));
    expect(sessionState().status('@me:hs')).toBeNull();

    await firstValueFrom(svc.add(SESSION));
    expect(sessionState().status('@me:hs')?.generation).toBeGreaterThan(
      first as number,
    );
  });

  it('clientFor() returns the account client, or null', async () => {
    const a = fakeClient();
    const { svc } = setup(a);
    await firstValueFrom(svc.init(SESSION));

    expect(svc.clientFor('@me:hs')).toBe(a);
    expect(svc.clientFor('@nobody:hs')).toBeNull();
  });

  describe('persisted Account startup outcomes', () => {
    it('serializes the SDK crypto migration critical section across Accounts', async () => {
      const firstClient = fakeClient();
      const secondClient = fakeClient();
      let finishFirst!: () => void;
      firstClient.initRustCrypto.mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishFirst = resolve;
          }),
      );
      const { svc } = setup(firstClient, secondClient);

      const first = firstValueFrom(svc.restorePersisted(SESSION, 'activate'));
      await vi.waitFor(() =>
        expect(firstClient.initRustCrypto).toHaveBeenCalledOnce(),
      );
      const second = firstValueFrom(
        svc.restorePersisted(SESSION_B, 'background'),
      );

      await Promise.resolve();
      expect(secondClient.initRustCrypto).not.toHaveBeenCalled();
      finishFirst();
      await vi.waitFor(() =>
        expect(secondClient.initRustCrypto).toHaveBeenCalledOnce(),
      );
      await expect(Promise.all([first, second])).resolves.toEqual([
        { kind: 'ready' },
        { kind: 'ready' },
      ]);
    });

    it('continues the crypto initialization queue after an Account fails', async () => {
      const firstClient = fakeClient();
      const secondClient = fakeClient();
      let failFirst!: (error: Error) => void;
      firstClient.initRustCrypto.mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            failFirst = reject;
          }),
      );
      const { svc } = setup(firstClient, secondClient);

      const first = firstValueFrom(svc.restorePersisted(SESSION, 'activate'));
      await vi.waitFor(() =>
        expect(firstClient.initRustCrypto).toHaveBeenCalledOnce(),
      );
      const second = firstValueFrom(
        svc.restorePersisted(SESSION_B, 'background'),
      );

      expect(secondClient.initRustCrypto).not.toHaveBeenCalled();
      failFirst(new Error('first Account failed'));

      await expect(first).resolves.toEqual({
        kind: 'failed',
        failure: 'crypto-failure',
      });
      await vi.waitFor(() =>
        expect(secondClient.initRustCrypto).toHaveBeenCalledOnce(),
      );
      await expect(second).resolves.toEqual({ kind: 'ready' });
    });

    it('activates a restored Account only after startup commits', async () => {
      const client = fakeClient();
      const { svc } = setup(client);

      const outcome = await firstValueFrom(
        svc.restorePersisted(SESSION, 'activate'),
      );

      expect(outcome).toEqual({ kind: 'ready' });
      expect(svc.activeUserId()).toBe('@me:hs');
    });

    it('classifies crypto bootstrap failures without exposing their details', async () => {
      const client = fakeClient();
      client.initRustCrypto.mockRejectedValue(
        new Error('secret-bearing crypto detail'),
      );
      const { svc } = setup(client);

      const outcome = await firstValueFrom(
        svc.restorePersisted(SESSION, 'activate'),
      );

      expect(outcome).toEqual({
        kind: 'failed',
        failure: 'crypto-failure',
      });
      expect(JSON.stringify(outcome)).not.toContain('secret-bearing');
      expect(svc.activeUserId()).toBeNull();
    });

    it.each([
      [
        { errcode: 'M_UNKNOWN_TOKEN', httpStatus: 401 },
        'reauthentication-required',
      ],
      [new ConnectionError('offline'), 'transient-network'],
      [
        Object.assign(new Error('refresh failed'), {
          name: 'TokenRefreshError',
        }),
        'transient-network',
      ],
      [{ httpStatus: 503 }, 'transient-network'],
      [{ name: 'TimeoutError' }, 'transient-network'],
    ] as const)(
      'classifies an expected start failure',
      async (error, failure) => {
        const client = fakeClient();
        client.startClient.mockRejectedValue(error);
        const { svc } = setup(client);

        await expect(
          firstValueFrom(svc.restorePersisted(SESSION, 'activate')),
        ).resolves.toEqual({ kind: 'failed', failure });
        expect(svc.activeUserId()).toBeNull();
        expect(svc.softLoggedOut().includes(SESSION.userId)).toBe(
          failure === 'reauthentication-required',
        );
      },
    );

    it('keeps unexpected adapter failures on the Observable error channel', async () => {
      const client = fakeClient();
      client.startClient.mockRejectedValue(new Error('adapter defect'));
      const { svc } = setup(client);

      await expect(
        firstValueFrom(svc.restorePersisted(SESSION, 'activate')),
      ).rejects.toThrow('adapter defect');
    });
  });

  it('syncState/connectivity follow the active account across a switch', async () => {
    const a = fakeClient();
    const b = fakeClient();
    const { svc } = setup(a, b);
    await firstValueFrom(svc.init(SESSION));
    await firstValueFrom(svc.add(SESSION_B)); // B active

    syncOf(a)(SyncState.Syncing);
    syncOf(b)(SyncState.Error);
    await Promise.resolve();
    expect(sessionState().connectivity()).toBe('offline'); // active B is erroring

    svc.setActive('@me:hs');
    expect(sessionState().connectivity()).toBe('online'); // active A is syncing
  });

  // --- per-account crypto isolation -----------------------------------------

  it('wires each account its own 4S holder, reachable by account id', async () => {
    const a = fakeClient();
    const b = fakeClient();
    const { svc } = setup(a, b);

    expect(svc.holderFor(SESSION.userId)).toBeNull(); // nothing signed in yet

    await firstValueFrom(svc.init(SESSION)); // A
    await firstValueFrom(svc.add(SESSION_B)); // B, now active

    // Each client got its OWN cryptoCallbacks, so a background account's key op
    // cannot read or overwrite another account's key.
    const callA = vi.mocked(createClient).mock.calls[0][0];
    const callB = vi.mocked(createClient).mock.calls[1][0];
    expect(callA.cryptoCallbacks?.getSecretStorageKey).not.toBe(
      callB.cryptoCallbacks?.getSecretStorageKey,
    );

    // Each account's holder is the one wired into its own client, active or not.
    const holderA = svc.holderFor(SESSION.userId);
    const holderB = svc.holderFor(SESSION_B.userId);
    expect(holderA!.getSecretStorageKey).toBe(
      callA.cryptoCallbacks?.getSecretStorageKey,
    );
    expect(holderB!.getSecretStorageKey).toBe(
      callB.cryptoCallbacks?.getSecretStorageKey,
    );
    expect(holderA).not.toBe(holderB);
  });

  it('serializes a same-account re-add behind its still-pending store wipe', async () => {
    const a1 = fakeClient();
    const a2 = fakeClient();
    const { svc } = setup(a1, a2);
    await firstValueFrom(svc.init(SESSION));
    expect(createClient).toHaveBeenCalledOnce();

    // Its store wipe never settles yet, so remove()'s background delete stays pending.
    let resolveWipe!: () => void;
    a1.clearStores.mockReturnValue(
      new Promise<void>((resolve) => (resolveWipe = resolve)),
    );
    await firstValueFrom(svc.remove(SESSION.userId)); // sign out — wipe tracked, still pending

    // Re-add the same account: start() must await the pending wipe before opening a
    // second connection to the same per-account store.
    const readded = firstValueFrom(svc.add(SESSION));
    await new Promise((resolve) => setTimeout(resolve, 0)); // drain microtasks
    expect(createClient).toHaveBeenCalledOnce(); // still 1 — blocked on the wipe

    resolveWipe();
    await readded;
    expect(createClient).toHaveBeenCalledTimes(2); // re-add proceeded after the wipe
    expect(activeClient(svc)).toBe(a2);
    expect(sessionState().active()).not.toBeNull();
  });

  it('follows the fresh client when the active account is re-added', async () => {
    const a1 = fakeClient();
    const a2 = fakeClient();
    const { svc } = setup(a1, a2);
    await firstValueFrom(svc.init(SESSION));

    syncOf(a1)(SyncState.Syncing);
    await Promise.resolve();
    expect(sessionState().syncState()).toBe('syncing');

    // Re-add the SAME active account: fresh client + fresh per-account syncState
    // signal, active id net-unchanged.
    await firstValueFrom(svc.add(SESSION));
    expect(sessionState().syncState()).toBe('starting'); // a2 has not transitioned yet

    syncOf(a2)(SyncState.Error); // only the NEW client's listener now feeds state
    await Promise.resolve();
    expect(sessionState().connectivity()).toBe('offline');
  });

  it('ignores a duplicate server logout for an already-removed account', async () => {
    const client = fakeClient();
    const { svc } = setup(client);
    await firstValueFrom(svc.init(SESSION));
    const onLoggedOut = loggedOutHandler(client);

    await firstValueFrom(svc.remove('@me:hs')); // detaches listener, wipes once, drops entry
    expect(client.clearStores).toHaveBeenCalledOnce();
    expect(svc.activeUserId()).toBeNull();
    const effects = recordEffects(svc);

    // A late / duplicate server-side logout for the same, now-gone account.
    expect(() => onLoggedOut({ data: { soft_logout: false } })).not.toThrow();

    expect(client.clearStores).toHaveBeenCalledOnce(); // not wiped a second time
    expect(effects).toEqual([]); // nothing for storage to save
    expect(svc.activeUserId()).toBeNull();
  });

  describe('roomKeysBackedUp', () => {
    /** A live client whose crypto reports this backup version (or rejects with it). */
    async function startWithBackup(version: string | null | Error) {
      const client = fakeClient();
      client.getCrypto.mockReturnValue({
        getActiveSessionBackupVersion: vi.fn(() =>
          version instanceof Error
            ? Promise.reject(version)
            : Promise.resolve(version),
        ),
      });
      const { svc } = setup(client);
      await firstValueFrom(svc.init(SESSION));
      const keysRemaining = (count: number): void =>
        (
          client.on.mock.calls.find(
            ([evt]) => evt === CryptoEvent.KeyBackupSessionsRemaining,
          )?.[1] as (remaining: number) => void
        )(count);
      return { svc, keysRemaining };
    }

    it('is true when key backup is active and nothing waits to upload', async () => {
      const { svc, keysRemaining } = await startWithBackup('3');
      keysRemaining(0);

      expect(await firstValueFrom(svc.roomKeysBackedUp('@me:hs'))).toBe(true);
    });

    it('is not backed up right after start, before the SDK reports what waits to upload', async () => {
      const { svc } = await startWithBackup('3');

      expect(await firstValueFrom(svc.roomKeysBackedUp('@me:hs'))).toBe(false);
    });

    it('is false when key backup is off', async () => {
      const { svc } = await startWithBackup(null);

      expect(await firstValueFrom(svc.roomKeysBackedUp('@me:hs'))).toBe(false);
    });

    it('is false while keys are still waiting to upload', async () => {
      const { svc, keysRemaining } = await startWithBackup('3');

      keysRemaining(12);
      expect(await firstValueFrom(svc.roomKeysBackedUp('@me:hs'))).toBe(false);

      keysRemaining(0);
      expect(await firstValueFrom(svc.roomKeysBackedUp('@me:hs'))).toBe(true);
    });

    it('is null when the account is not live or its crypto cannot answer', async () => {
      const { svc } = await startWithBackup(new Error('store closed'));

      expect(await firstValueFrom(svc.roomKeysBackedUp('@me:hs'))).toBeNull();
      expect(
        await firstValueFrom(svc.roomKeysBackedUp('@nobody:hs')),
      ).toBeNull();
    });
  });

  describe('wiping an account that has no live client', () => {
    // L2. remove() is documented as "stop it + wipe its stores", and the account with
    // nothing to stop — soft-logged-out, or a failed background warm-up — is exactly the
    // one whose crypto store would be orphaned: logout deletes the registry record that
    // carries its cryptoPrefix moments later, and then nothing can name the store.

    /** A minimal IDBFactory that records deletes and reports each as a success. */
    function fakeIndexedDb(deleted: string[]) {
      return {
        deleteDatabase(name: string) {
          deleted.push(name);
          const request: { onsuccess: (() => void) | null } = {
            onsuccess: null,
          };
          setTimeout(() => request.onsuccess?.(), 0);
          return request as unknown as IDBOpenDBRequest;
        },
      };
    }

    it('deletes its databases by name, from the registry record', async () => {
      const deleted: string[] = [];
      vi.stubGlobal('indexedDB', fakeIndexedDb(deleted));
      const { svc, storage } = setup();
      vi.mocked(storage.record).mockReturnValue(
        of({
          userId: '@ghost:hs',
          baseUrl: 'https://hs.example',
          deviceId: 'DEV',
          cryptoPrefix: 'trinity-crypto:@ghost:hs',
        }),
      );

      await firstValueFrom(svc.remove('@ghost:hs')); // never started a client
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect([...deleted].sort()).toEqual([
        'matrix-js-sdk:trinity-sync:@ghost:hs',
        'trinity-crypto:@ghost:hs::matrix-sdk-crypto',
        'trinity-crypto:@ghost:hs::matrix-sdk-crypto-meta',
      ]);
    });

    it('leaves the SDK-default crypto pair alone when no record names it', async () => {
      // Without a record the prefix is unknown, and the default pair may belong to a
      // migrated legacy account — the cold-start orphan sweep owns that case.
      const deleted: string[] = [];
      vi.stubGlobal('indexedDB', fakeIndexedDb(deleted));
      const { svc } = setup(); // record() defaults to null

      await firstValueFrom(svc.remove('@ghost:hs'));
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(deleted).toEqual(['matrix-js-sdk:trinity-sync:@ghost:hs']);
    });
  });

  describe('a start whose caller does not survive it', () => {
    // H1. The callers are route guards, and the Router unsubscribes a guard whose
    // navigation is superseded — mid-chain, i.e. somewhere inside open-IndexedDB → WASM →
    // initRustCrypto → startClient. What must never follow is a SECOND client for the same
    // account: two initRustCrypto calls open one device's crypto store twice.

    /** A client whose crypto bootstrap hangs until the returned resolver is called. */
    function clientWithPendingCrypto() {
      const client = fakeClient();
      let release!: () => void;
      client.initRustCrypto.mockReturnValue(
        new Promise<void>((resolve) => {
          release = () => resolve();
        }),
      );
      return { client, release: () => release() };
    }

    /** Let the (now unblocked) chain run to its end. */
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('rolls the client back when it is unsubscribed mid-initRustCrypto', async () => {
      const { client, release } = clientWithPendingCrypto();
      const { svc } = setup(client);

      svc.init(SESSION).subscribe().unsubscribe(); // navigation superseded
      release();
      await settle();

      // It runs to completion (a promise cannot be cancelled), then undoes itself —
      // rather than syncing on unreachable with its crypto store open.
      expect(client.stopClient).toHaveBeenCalled();
      expect(client.off).toHaveBeenCalledWith(
        ClientEvent.Sync,
        expect.any(Function),
      );
      expect(clearHolder).toHaveBeenCalled();
      expect(sessionState().active()).toBeNull();
      expect([...svc.accountIds()]).toEqual([]);
    });

    it('joins an in-flight start instead of building a second client', async () => {
      // The reachable shape: a deep link completes login for the SAME account while the
      // initial guard is still inside initRustCrypto.
      const { client, release } = clientWithPendingCrypto();
      const { svc } = setup(client);

      const guard = firstValueFrom(svc.init(SESSION));
      const deepLink = firstValueFrom(svc.add(SESSION));
      release();
      await Promise.all([guard, deepLink]);

      expect(createClient).toHaveBeenCalledOnce();
      expect(client.initRustCrypto).toHaveBeenCalledOnce();
      expect([...svc.accountIds()]).toEqual(['@me:hs']);
      expect(activeClient(svc)).toBe(client);
      expect(client.stopClient).not.toHaveBeenCalled(); // both callers wanted it
    });

    it('does not replay a FAILED start to the next caller', async () => {
      // The in-flight entry is dropped the moment the chain settles, so the login after a
      // failure gets a real attempt rather than the cached rejection.
      const failing = fakeClient();
      failing.startClient.mockRejectedValue(new Error('sync boom'));
      const working = fakeClient();
      const { svc } = setup(failing, working);

      await expect(firstValueFrom(svc.init(SESSION))).rejects.toThrow(
        'sync boom',
      );
      expect(failing.stopClient).toHaveBeenCalled();

      await firstValueFrom(svc.init(SESSION));

      expect(createClient).toHaveBeenCalledTimes(2);
      expect(activeClient(svc)).toBe(working);
    });
  });

  describe('CORS origin publishing (desktop)', () => {
    // On desktop the renderer must publish the live homeserver origin set so main's CORS
    // shim can be scoped to it (electron/src/cors.ts). Published on every account-set
    // change; the whole set is REPLACED each time so a signed-out account is revoked.
    it('publishes the live homeserver origins whenever the account set changes', async () => {
      const setAllowedOrigins = vi.fn();
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
        desktopBridgeFixture({
          capabilities: {
            networkCors: { setAllowedOrigins, allowOrigin: vi.fn() },
          },
        });
      try {
        vi.mocked(createClient).mockReturnValueOnce(
          fakeClient('https://hs.example') as never,
        );
        const { svc, storage } = setup();
        vi.mocked(storage.save).mockReturnValue(of(SESSION));
        vi.mocked(storage.setActive).mockReturnValue(of(undefined));

        await firstValueFrom(svc.init(SESSION));
        expect(setAllowedOrigins).toHaveBeenLastCalledWith([
          'https://hs.example',
        ]);

        // A second account joins → the set now carries both origins.
        vi.mocked(createClient).mockReturnValueOnce(
          fakeClient('https://other.example') as never,
        );
        vi.mocked(storage.save).mockReturnValue(of(SESSION_B));
        await firstValueFrom(svc.add(SESSION_B));
        expect(setAllowedOrigins).toHaveBeenLastCalledWith([
          'https://hs.example',
          'https://other.example',
        ]);
      } finally {
        delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
      }
    });

    it('declares the homeserver origin BEFORE the client that calls it is built', async () => {
      // M4. startClient() issues /versions, the thread-support probe and the first /sync
      // before it resolves, so a set published only afterwards leaves all three to be
      // blocked against a homeserver whose proxy strips CORS headers — and a failed
      // getVersions() disables server-side threads for the whole session.
      const order: string[] = [];
      const allowOrigin = vi.fn(() => order.push('allowOrigin'));
      const setAllowedOrigins = vi.fn(() => order.push('setAllowedOrigins'));
      (globalThis as { trinityDesktop?: unknown }).trinityDesktop =
        desktopBridgeFixture({
          capabilities: { networkCors: { setAllowedOrigins, allowOrigin } },
        });
      try {
        const client = fakeClient();
        client.startClient.mockImplementation(() => {
          order.push('startClient');
          return Promise.resolve();
        });
        vi.mocked(createClient).mockImplementation((() => {
          order.push('createClient');
          return client;
        }) as never);
        const { svc } = setup();

        await firstValueFrom(svc.add(SESSION));

        expect(allowOrigin).toHaveBeenCalledWith('https://hs.example');
        expect(order).toEqual([
          'allowOrigin',
          'createClient',
          'startClient',
          // The post-registration publish still runs, so a removal keeps applying.
          'setAllowedOrigins',
        ]);
      } finally {
        delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
      }
    });

    it('does not throw off desktop (no bridge)', async () => {
      delete (globalThis as { trinityDesktop?: unknown }).trinityDesktop;
      vi.mocked(createClient).mockReturnValueOnce(fakeClient() as never);
      const { svc } = setup();

      await expect(firstValueFrom(svc.init(SESSION))).resolves.not.toThrow();
      expect(sessionState().active()).not.toBeNull();
    });
  });

  describe('linked secrets', () => {
    const BUNDLE = { cross_signing: { master_key: 'SECRET-KEY-MATERIAL' } };

    function clientWithCrypto(calls: string[] = []) {
      const crypto = {
        importSecretsBundle: vi.fn(async () => {
          calls.push('import');
        }),
        crossSignDevice: vi.fn().mockResolvedValue(undefined),
        checkKeyBackupAndEnable: vi.fn().mockResolvedValue(null),
        isCrossSigningReady: vi.fn().mockResolvedValue(true),
        getDeviceVerificationStatus: vi
          .fn()
          .mockResolvedValue({ crossSigningVerified: true }),
      };
      const client = {
        ...fakeClient(),
        getUserId: vi.fn().mockReturnValue(SESSION.userId),
        getCrypto: vi.fn().mockReturnValue(crypto),
        startClient: vi.fn(async () => {
          calls.push('startClient');
        }),
      };
      return { client, crypto };
    }

    it('imports a held bundle after startClient for the same user and device', async () => {
      const calls: string[] = [];
      const { client, crypto } = clientWithCrypto(calls);
      const { svc } = setup(client);
      svc.holdLinkedSecrets(SESSION.userId, SESSION.deviceId, BUNDLE);

      await firstValueFrom(svc.restorePersisted(SESSION, 'activate'));

      expect(calls).toEqual(['startClient', 'import']);
      expect(crypto.importSecretsBundle).toHaveBeenCalledWith(BUNDLE);
      expect(crypto.crossSignDevice).toHaveBeenCalledWith(SESSION.deviceId);
      expect(crypto.checkKeyBackupAndEnable).toHaveBeenCalledOnce();
    });

    it('never imports a bundle held for another device or user', async () => {
      const { client, crypto } = clientWithCrypto();
      const { svc } = setup(client);
      svc.holdLinkedSecrets(SESSION.userId, 'OTHER-DEVICE', BUNDLE);
      svc.holdLinkedSecrets('@other:hs', SESSION.deviceId, BUNDLE);

      await firstValueFrom(svc.restorePersisted(SESSION, 'activate'));

      expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
    });

    it('takes a held bundle once', async () => {
      const { client, crypto } = clientWithCrypto();
      const { svc } = setup(client);
      svc.holdLinkedSecrets(SESSION.userId, SESSION.deviceId, BUNDLE);

      await firstValueFrom(svc.restorePersisted(SESSION, 'activate'));
      await firstValueFrom(svc.restorePersisted(SESSION, 'activate'));

      expect(crypto.importSecretsBundle).toHaveBeenCalledOnce();
    });

    it('imports nothing once the bundle is dropped', async () => {
      const { client, crypto } = clientWithCrypto();
      const { svc } = setup(client);
      svc.holdLinkedSecrets(SESSION.userId, SESSION.deviceId, BUNDLE);

      svc.dropLinkedSecrets(SESSION.userId, SESSION.deviceId);
      await firstValueFrom(svc.restorePersisted(SESSION, 'activate'));

      expect(crypto.importSecretsBundle).not.toHaveBeenCalled();
    });

    it("an import failure doesn't fail the start or log the bundle", async () => {
      const { client, crypto } = clientWithCrypto();
      crypto.importSecretsBundle.mockRejectedValue(
        new Error(`rejected ${JSON.stringify(BUNDLE)}`),
      );
      const logged = [
        vi.spyOn(console, 'warn').mockImplementation(() => undefined),
        vi.spyOn(console, 'error').mockImplementation(() => undefined),
        vi.spyOn(console, 'log').mockImplementation(() => undefined),
      ];
      try {
        const { svc } = setup(client);
        svc.holdLinkedSecrets(SESSION.userId, SESSION.deviceId, BUNDLE);

        await expect(
          firstValueFrom(svc.restorePersisted(SESSION, 'activate')),
        ).resolves.toEqual({ kind: 'ready' });

        expect(activeClient(svc)).toBe(client);
        const diagnostics = logged.flatMap((spy) => spy.mock.calls);
        expect(diagnostics).not.toHaveLength(0);
        expect(JSON.stringify(diagnostics)).not.toContain('SECRET-KEY');
      } finally {
        for (const spy of logged) spy.mockRestore();
      }
    });
  });
});
