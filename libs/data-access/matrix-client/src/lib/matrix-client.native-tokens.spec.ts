import {
  NATIVE_REFRESH_MARKER,
  SessionStorageService,
} from '@trinity/platform-native';
import type { MatrixSession } from '@trinity/util/matrix';
import { HttpApiEvent, TokenRefreshError, createClient } from 'matrix-js-sdk';
import { NEVER, firstValueFrom, of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  METADATA,
  fakeNetwork,
} from './matrix-client.oauth-network.spec-harness';
import { OIDC_SESSION, setup } from './matrix-client.spec-harness';

const storeMock = vi.hoisted(() => ({ startup: vi.fn(), destroy: vi.fn() }));
/** The host a test runs on, read as the real bridge is built, and the plugin it answers from. */
const host = vi.hoisted(() => ({
  native: true,
  plugin: {} as Record<string, unknown>,
}));

vi.mock('@capacitor/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@capacitor/core')>();
  return {
    ...actual,
    Capacitor: {
      ...actual.Capacitor,
      isNativePlatform: () => host.native,
      isPluginAvailable: (name: string) =>
        host.native && name === 'PushHandoff',
    },
    registerPlugin: (name: string) =>
      name === 'PushHandoff'
        ? new Proxy({}, { get: (_, method: string) => host.plugin[method] })
        : actual.registerPlugin(name),
  };
});

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

vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
});

const ME = '@me:hs';
const HOUR_MS = 3_600_000;
const inAnHour = (): number => Date.now() + HOUR_MS;

/** As storage loads a migrated account: no refresh token left in JavaScript. */
const STORED: MatrixSession = {
  ...OIDC_SESSION,
  accessToken: 'at-1',
  accessTokenExpiresAt: undefined,
  refreshToken: undefined,
  lineage: 'L',
  oidc: {
    ...OIDC_SESSION.oidc,
    tokenEndpoint: METADATA.token_endpoint,
    revocationEndpoint: METADATA.revocation_endpoint,
  },
};

interface VaultRecord {
  accessToken: string;
  accessTokenExpiresAt?: number;
  refused?: boolean;
}

interface TokenAnswer {
  kind: string;
  accessToken?: string;
  accessTokenExpiresAt?: number;
}

/** Native's token vault for one account, granting at a provider that goes through `issue`. */
function fakeVault(issue: (accessToken: string) => void) {
  let issued = 1;
  const state: {
    record: VaultRecord | null;
    nextExpiresAt: number | undefined;
  } = {
    record: { accessToken: 'at-1' },
    nextExpiresAt: undefined,
  };
  const withExpiry = (
    kind: string,
    accessToken: string,
    expiresAt: number | undefined,
  ): TokenAnswer => ({
    kind,
    accessToken,
    ...(expiresAt === undefined ? {} : { accessTokenExpiresAt: expiresAt }),
  });
  const held = (): TokenAnswer => {
    if (!state.record) return { kind: 'gone' };
    if (state.record.refused) return { kind: 'refused' };
    return withExpiry(
      'current',
      state.record.accessToken,
      state.record.accessTokenExpiresAt,
    );
  };
  return {
    state,
    currentTokens: vi.fn(
      async (_options: { userId: string; lineage: string }) => held(),
    ),
    refreshTokens: vi.fn(
      async ({
        tokenSeen,
      }: {
        userId: string;
        lineage: string;
        tokenSeen: string;
      }) => {
        if (state.record?.accessToken !== tokenSeen || state.record.refused) {
          return held();
        }
        issued += 1;
        const accessToken = `at-${issued}`;
        issue(accessToken);
        state.record = {
          accessToken,
          accessTokenExpiresAt: state.nextExpiresAt,
        };
        return withExpiry('rotated', accessToken, state.nextExpiresAt);
      },
    ),
    migrateTokens: vi.fn(
      async (record: {
        accessToken: string;
        accessTokenExpiresAt?: number;
      }) => {
        state.record ??= {
          accessToken: record.accessToken,
          accessTokenExpiresAt: record.accessTokenExpiresAt,
        };
        return { stored: true };
      },
    ),
    revokeTokens: vi.fn(
      async (_options: { userId: string; lineage: string }) => {
        const kind = state.record ? 'revoked' : 'gone';
        state.record = null;
        return { kind };
      },
    ),
  };
}

type Vault = ReturnType<typeof fakeVault>;

describe('a phone account whose refresh token native code holds', () => {
  /** A service over a real client and a real bridge, with the vault as `arrange` leaves it. */
  async function service(
    options: { available?: boolean; arrange?: (vault: Vault) => void } = {},
  ) {
    const actual =
      await vi.importActual<typeof import('matrix-js-sdk')>('matrix-js-sdk');
    vi.mocked(createClient).mockImplementation((opts) => {
      const client = actual.createClient(opts);
      vi.spyOn(client, 'initRustCrypto').mockResolvedValue(undefined);
      vi.spyOn(client, 'startClient').mockResolvedValue(undefined);
      vi.spyOn(client, 'clearStores').mockResolvedValue(undefined);
      return client;
    });
    vi.stubGlobal('indexedDB', undefined);
    const net = fakeNetwork('rotate');
    net.live.add('at-1');
    const vault = fakeVault((accessToken) => net.live.add(accessToken));
    options.arrange?.(vault);
    host.native = options.available ?? true;
    host.plugin = vault;
    const ctx = setup();
    const { storage } = ctx;
    vi.mocked(storage.updateTokens).mockReturnValue(of(undefined));
    vi.mocked(storage.updateOidcBinding).mockReturnValue(of(undefined));
    vi.mocked(storage.dropRefreshToken).mockReturnValue(of(undefined));
    vi.mocked(storage.invalidateToken).mockReturnValue(of(undefined));
    vi.mocked(storage.remove).mockReturnValue(of(undefined));
    vi.mocked(storage.setActive).mockReturnValue(of(undefined));
    const rotations: string[] = [];
    ctx.svc.accessTokenRotations.subscribe(({ accessToken }) =>
      rotations.push(accessToken),
    );
    return { ...ctx, net, vault, rotations };
  }

  async function started(
    options: {
      session?: MatrixSession;
      available?: boolean;
      arrange?: (vault: Vault) => void;
    } = {},
  ) {
    const ctx = await service(options);
    await firstValueFrom(ctx.svc.init(options.session ?? STORED));
    return { ...ctx, client: ctx.svc.instance };
  }

  /** Another process rotated the pair: the vault and the homeserver have moved on. */
  function rotatedElsewhere(
    { vault, net }: { vault: Vault; net: { live: Set<string> } },
    accessTokenExpiresAt?: number,
  ): void {
    net.live.delete('at-1');
    net.live.add('at-9');
    vault.state.record = { accessToken: 'at-9', accessTokenExpiresAt };
  }

  beforeEach(() => {
    vi.mocked(createClient).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('refreshes through native at expiry and sends no grant from JS', async () => {
    const { client, net, vault } = await started({
      arrange: (v) => {
        v.state.record = {
          accessToken: 'at-1',
          accessTokenExpiresAt: Date.now() - 1,
        };
      },
    });

    await expect(client.whoami()).resolves.toMatchObject({ user_id: ME });

    expect(vault.refreshTokens).toHaveBeenCalledExactlyOnceWith({
      userId: ME,
      lineage: 'L',
      tokenSeen: 'at-1',
    });
    expect(client.getAccessToken()).toBe('at-2');
    expect(net.whoamiRefused()).toBe(0);
    expect(net.grants).toHaveLength(0);
  });

  it('a refresh before the background goes through native', async () => {
    const { svc, client, net, vault } = await started();

    await expect(
      firstValueFrom(svc.refreshAccessToken(ME, { timeoutMs: 8_000 })),
    ).resolves.toBe(true);

    expect(vault.refreshTokens).toHaveBeenCalledOnce();
    expect(client.getAccessToken()).toBe('at-2');
    expect(net.grants).toHaveLength(0);
  });

  it('adopts the pair another process rotated when a request meets M_UNKNOWN_TOKEN (failure 3)', async () => {
    const ctx = await started();
    const { client, net, vault, storage } = ctx;
    rotatedElsewhere(ctx);

    await expect(client.whoami()).resolves.toMatchObject({ user_id: ME });

    expect(net.whoamiRefused()).toBe(1);
    expect(vault.refreshTokens).not.toHaveBeenCalled();
    expect(client.getAccessToken()).toBe('at-9');
    expect(storage.updateTokens).toHaveBeenCalledExactlyOnceWith(
      ME,
      'L',
      'at-9',
      undefined,
      undefined,
    );
  });

  it('adopts before the far-expiry shortcut: the account stays signed in (failure 4)', async () => {
    const ctx = await started({
      arrange: (v) => {
        v.state.record = {
          accessToken: 'at-1',
          accessTokenExpiresAt: inAnHour(),
        };
      },
    });
    const { svc, client, vault } = ctx;
    rotatedElsewhere(ctx, inAnHour());

    await expect(client.whoami()).resolves.toMatchObject({ user_id: ME });

    expect(vault.refreshTokens).not.toHaveBeenCalled();
    expect(client.getAccessToken()).toBe('at-9');
    expect(svc.accountIds()).toContain(ME);
  });

  it('adopts a changed pair on resume (failure 4)', async () => {
    const ctx = await started();
    const { svc, client, net, rotations } = ctx;
    const expiresAt = inAnHour();
    rotatedElsewhere(ctx, expiresAt);

    await firstValueFrom(svc.adoptNativeTokens());

    expect(client.getAccessToken()).toBe('at-9');
    expect(svc.accessTokenExpiry(ME, 'at-9')).toBe(expiresAt);
    expect(rotations).toEqual(['at-9']);
    await expect(client.whoami()).resolves.toMatchObject({ user_id: ME });
    expect(net.whoamiRefused()).toBe(0);
  });

  it('treats a failed read on resume as unchanged', async () => {
    const { svc, client, vault, rotations } = await started();
    vault.currentTokens.mockRejectedValueOnce(new Error('bridge died'));

    await firstValueFrom(svc.adoptNativeTokens());

    expect(client.getAccessToken()).toBe('at-1');
    expect(rotations).toEqual([]);
  });

  it('treats a host read that rejects on resume as unchanged', async () => {
    const { svc, client } = await started();
    vi.spyOn(client.http.opts.tokenHost!, 'current').mockRejectedValue(
      new Error('bridge died'),
    );

    await expect(
      firstValueFrom(svc.adoptNativeTokens()),
    ).resolves.toBeUndefined();

    expect(client.getAccessToken()).toBe('at-1');
  });

  it('adopts nothing on resume for an account with no host', async () => {
    const { svc, client, vault, rotations } = await started({
      session: OIDC_SESSION,
      available: false,
    });

    await firstValueFrom(svc.adoptNativeTokens());

    expect(vault.currentTokens).not.toHaveBeenCalled();
    expect(client.getAccessToken()).toBe(OIDC_SESSION.accessToken);
    expect(rotations).toEqual([]);
  });

  it('a late native answer does not undo a newer adoption (failure 5)', async () => {
    const { svc, client, net, vault } = await started();
    let answerLate!: (answer: TokenAnswer) => void;
    vault.currentTokens.mockReturnValueOnce(
      new Promise((resolve) => (answerLate = resolve)),
    );

    const adopting = firstValueFrom(svc.adoptNativeTokens());
    await firstValueFrom(svc.refreshAccessToken(ME));
    expect(client.getAccessToken()).toBe('at-2');
    answerLate({ kind: 'current', accessToken: 'at-1' });
    await adopting;

    expect(client.getAccessToken()).toBe('at-2');
    await expect(client.whoami()).resolves.toMatchObject({ user_id: ME });
    expect(net.whoamiRefused()).toBe(0);
  });

  it('starts from the vault pair, not the stored copy (failure 7)', async () => {
    const expiresAt = inAnHour();
    const { svc, client, net, vault } = await started({
      session: { ...STORED, accessToken: 'at-0', accessTokenExpiresAt: 1234 },
      arrange: (v) => {
        v.state.record = {
          accessToken: 'at-5',
          accessTokenExpiresAt: expiresAt,
        };
      },
    });
    net.live.add('at-5');

    expect(client.getAccessToken()).toBe('at-5');
    expect(svc.accessTokenExpiry(ME, 'at-5')).toBe(expiresAt);
    await expect(client.whoami()).resolves.toMatchObject({ user_id: ME });
    expect(net.whoamiRefused()).toBe(0);
    expect(vault.refreshTokens).not.toHaveBeenCalled();
  });

  it('moves a refresh token still in JS and refreshes from native afterwards', async () => {
    const { svc, net, vault, storage } = await started({
      session: { ...STORED, refreshToken: 'rt-1' },
      arrange: (v) => {
        v.state.record = null;
      },
    });

    expect(vault.migrateTokens).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ refreshToken: 'rt-1', lineage: 'L' }),
    );
    expect(storage.dropRefreshToken).toHaveBeenCalledExactlyOnceWith(ME, 'L');
    await expect(firstValueFrom(svc.refreshAccessToken(ME))).resolves.toBe(
      true,
    );
    expect(net.grants).toHaveLength(0);
  });

  describe('the expiry the wire leaves out', () => {
    it('is not kept from the stored copy at start', async () => {
      const { svc, client, vault } = await started({
        session: { ...STORED, accessTokenExpiresAt: Date.now() - 1 },
      });

      expect(svc.accessTokenExpiry(ME, 'at-1')).toBeUndefined();
      await client.whoami();
      expect(vault.refreshTokens).not.toHaveBeenCalled();
    });

    it('clears the known one when a changed pair is adopted', async () => {
      const ctx = await started({
        arrange: (v) => {
          v.state.record = {
            accessToken: 'at-1',
            accessTokenExpiresAt: Date.now() - 1,
          };
        },
      });
      const { svc, client, vault, storage } = ctx;
      rotatedElsewhere(ctx);

      await firstValueFrom(svc.adoptNativeTokens());

      expect(svc.accessTokenExpiry(ME, 'at-9')).toBeUndefined();
      expect(storage.updateTokens).toHaveBeenCalledExactlyOnceWith(
        ME,
        'L',
        'at-9',
        undefined,
        undefined,
      );
      // The old expiry has passed, so keeping it would refresh before sending.
      await client.whoami();
      expect(vault.refreshTokens).not.toHaveBeenCalled();
    });

    it('clears the known one when a refresh rotates with none', async () => {
      const { svc, client, vault, storage } = await started({
        arrange: (v) => {
          v.state.record = {
            accessToken: 'at-1',
            accessTokenExpiresAt: Date.now() - 1,
          };
        },
      });

      await client.whoami();

      expect(vault.refreshTokens).toHaveBeenCalledOnce();
      expect(svc.accessTokenExpiry(ME, 'at-2')).toBeUndefined();
      expect(vi.mocked(storage.updateTokens).mock.calls).toEqual([
        [ME, 'L', 'at-2', undefined, undefined],
      ]);
    });
  });

  describe('a detached client', () => {
    it('a detached client refreshes through native, not its own grant (failure 9)', async () => {
      const { svc, net, vault, storage } = await service();
      net.live.delete('at-1');

      const client = svc.detachedClient(STORED);
      await expect(client.whoami()).resolves.toMatchObject({ user_id: ME });

      expect(vault.refreshTokens).toHaveBeenCalledExactlyOnceWith({
        userId: ME,
        lineage: 'L',
        tokenSeen: 'at-1',
      });
      expect(client.getAccessToken()).toBe('at-2');
      expect(net.grants).toHaveLength(0);
      expect(vi.mocked(storage.updateTokens).mock.calls).toEqual([
        [ME, 'L', 'at-2', undefined, undefined],
      ]);
    });

    it('learns the stored expiry, so an expired token refreshes before it is sent', async () => {
      const { svc, net, vault } = await service();

      const client = svc.detachedClient({
        ...STORED,
        accessTokenExpiresAt: Date.now() - 1,
      });
      await client.whoami();

      expect(vault.refreshTokens).toHaveBeenCalledOnce();
      expect(net.whoamiRefused()).toBe(0);
    });

    it('a detached client revokes through native and never sends the marker', async () => {
      const { svc, net, vault } = await service();

      await svc.detachedClient(STORED).logout();

      expect(vault.revokeTokens).toHaveBeenCalledExactlyOnceWith({
        userId: ME,
        lineage: 'L',
      });
      expect(net.revocations).toEqual([]);
      expect(net.grants).toHaveLength(0);
    });

    it('a detached client with no vault record revokes its access token through the SDK', async () => {
      const { svc, net } = await service({
        arrange: (v) => {
          v.state.record = null;
        },
      });

      await svc.detachedClient(STORED).logout();

      expect(net.revocations).toEqual(['access_token']);
    });

    it('keeps the JS path for a session that still holds its refresh token', async () => {
      const { svc, net, vault } = await service();

      const client = svc.detachedClient({ ...STORED, refreshToken: 'rt-1' });
      await client.logout();

      expect(vault.revokeTokens).not.toHaveBeenCalled();
      expect([...net.revocations].sort()).toEqual([
        'access_token',
        'refresh_token',
      ]);
    });

    it('does not save a refresh when told not to', async () => {
      const { svc, net, storage } = await service();
      net.live.delete('at-1');

      const client = svc.detachedClient(STORED, {
        persistRefreshedTokens: false,
      });
      await client.whoami();

      expect(client.getAccessToken()).toBe('at-2');
      expect(storage.updateTokens).not.toHaveBeenCalled();
    });
  });

  describe('the copy in storage', () => {
    it('a locked keychain fails only the copy and the refreshed token is used', async () => {
      const { svc, client, storage, rotations, net } = await started();
      vi.mocked(storage.updateTokens).mockReturnValue(
        throwError(() => new Error('secure store locked')),
      );

      await expect(firstValueFrom(svc.refreshAccessToken(ME))).resolves.toBe(
        true,
      );

      expect(client.getAccessToken()).toBe('at-2');
      expect(rotations).toEqual(['at-2']);
      await expect(client.whoami()).resolves.toMatchObject({ user_id: ME });
      expect(net.whoamiRefused()).toBe(0);
      expect(svc.accountIds()).toContain(ME);
    });

    it('a write that never settles holds a refresh for 3 s at most, and its token is used', async () => {
      const { svc, client, storage, rotations, net } = await started();
      vi.mocked(storage.updateTokens).mockReturnValue(NEVER);
      vi.useFakeTimers({
        toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
      });

      let answered: boolean | undefined;
      const refreshing = firstValueFrom(svc.refreshAccessToken(ME)).then(
        (refreshed) => (answered = refreshed),
      );
      await vi.advanceTimersByTimeAsync(2_999);
      expect(answered).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await refreshing;
      vi.useRealTimers();

      expect(answered).toBe(true);
      expect(client.getAccessToken()).toBe('at-2');
      expect(rotations).toEqual(['at-2']);
      await expect(client.whoami()).resolves.toMatchObject({ user_id: ME });
      expect(net.whoamiRefused()).toBe(0);
    });

    it('keeps the marker out of storage', async () => {
      const ctx = await started({
        session: { ...STORED, refreshToken: 'rt-1' },
      });
      const { svc, client, storage } = ctx;
      await firstValueFrom(svc.refreshAccessToken(ME));
      rotatedElsewhere(ctx);
      await firstValueFrom(svc.adoptNativeTokens());
      await client.whoami();
      await svc.detachedClient(STORED).logout();

      const updates = vi.mocked(storage.updateTokens).mock.calls;
      expect(updates.map(([, , accessToken]) => accessToken)).toEqual([
        'at-2',
        'at-9',
      ]);
      for (const update of updates) {
        expect(update[3]).toBeUndefined();
      }
      // Every other write too, save, saveNew and persistForEstablishment among them, each of
      // which would store a refresh token it is handed.
      const writers = Object.getOwnPropertyNames(
        SessionStorageService.prototype,
      ) as (keyof SessionStorageService)[];
      expect(writers).toEqual(
        expect.arrayContaining(['save', 'saveNew', 'persistForEstablishment']),
      );
      for (const name of writers) {
        const method = storage[name];
        if (vi.isMockFunction(method)) {
          expect(JSON.stringify(method.mock.calls)).not.toContain(
            NATIVE_REFRESH_MARKER,
          );
        }
      }
      expect(storage.save).not.toHaveBeenCalled();
      expect(storage.saveNew).not.toHaveBeenCalled();
      expect(storage.persistForEstablishment).not.toHaveBeenCalled();
    });
  });

  it('reports canRefreshAccessToken true with the marker', async () => {
    const { svc, client } = await started();

    expect(svc.canRefreshAccessToken(ME)).toBe(true);
    expect(client.getRefreshToken()).toBe(NATIVE_REFRESH_MARKER);
  });

  it('reports no refresh and no host for a lost vault with no JS copy', async () => {
    const { svc, client } = await started({
      arrange: (v) => {
        v.state.record = null;
      },
    });

    expect(svc.canRefreshAccessToken(ME)).toBe(false);
    expect(client.getRefreshToken()).toBeNull();
    expect(client.http.opts.tokenHost).toBeUndefined();
  });

  it('publishes one rotation for one refresh', async () => {
    const { svc, rotations } = await started();

    await firstValueFrom(svc.refreshAccessToken(ME));

    expect(rotations).toEqual(['at-2']);
  });

  describe('starting', () => {
    it('fails a start that native refused without building a client', async () => {
      const { svc, storage } = await service({
        arrange: (v) => {
          v.state.record = { accessToken: 'at-1', refused: true };
        },
      });

      await expect(
        firstValueFrom(svc.restorePersisted(STORED, 'activate')),
      ).resolves.toEqual({
        kind: 'failed',
        failure: 'reauthentication-required',
      });

      expect(createClient).not.toHaveBeenCalled();
      expect(storage.invalidateToken).toHaveBeenCalledExactlyOnceWith(ME);
      expect(svc.softLoggedOut()).toContain(ME);
      expect(svc.accountIds()).toEqual([]);
    });

    it('stops the old client before it reads the vault', async () => {
      const { svc, client, vault } = await started();
      const order: string[] = [];
      vi.spyOn(client, 'stopClient').mockImplementation(() => {
        order.push('stopped');
      });
      vault.currentTokens.mockImplementationOnce(async () => {
        order.push('read');
        return { kind: 'current', accessToken: 'at-1' };
      });

      await firstValueFrom(svc.add(STORED));

      expect(order).toEqual(['stopped', 'read']);
    });
  });

  describe('a token already past its expiry', () => {
    async function expired() {
      const ctx = await started({
        arrange: (v) => {
          v.state.record = {
            accessToken: 'at-1',
            accessTokenExpiresAt: Date.now() - 1,
          };
        },
      });
      const loggedOut = vi.fn();
      ctx.client.on(HttpApiEvent.SessionLoggedOut, loggedOut);
      return { ...ctx, loggedOut };
    }

    it('a transient answer emits no SessionLoggedOut', async () => {
      const { svc, client, net, vault, loggedOut, storage } = await expired();
      net.live.delete('at-1');
      vault.refreshTokens.mockResolvedValue({ kind: 'transient' });

      await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

      expect(vault.refreshTokens).toHaveBeenCalledTimes(2);
      expect(loggedOut).not.toHaveBeenCalled();
      expect(svc.accountIds()).toContain(ME);
      expect(storage.remove).not.toHaveBeenCalled();
    });

    it('a refused answer emits exactly one SessionLoggedOut', async () => {
      const { client, net, vault, loggedOut, storage } = await expired();
      net.live.delete('at-1');
      vault.state.record = { accessToken: 'at-1', refused: true };

      await expect(client.whoami()).rejects.toMatchObject({
        errcode: 'M_UNKNOWN_TOKEN',
      });

      expect(vault.refreshTokens).toHaveBeenCalledTimes(2);
      expect(loggedOut).toHaveBeenCalledOnce();
      expect(storage.remove).toHaveBeenCalledExactlyOnceWith(ME);
    });

    it('makes 4 native refreshes at most for one request the server keeps refusing', async () => {
      const { client, net, vault, loggedOut } = await expired();
      vi.spyOn(net.live, 'has').mockReturnValue(false);
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

      const request = client.whoami();
      request.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(120_000);

      await expect(request).rejects.toBeInstanceOf(TokenRefreshError);
      expect(vault.refreshTokens).toHaveBeenCalledTimes(4);
      expect(loggedOut).not.toHaveBeenCalled();
    });
  });

  it('a refresh during a re-login does not sign the new sign-in out', async () => {
    const { svc, client, net, vault, storage } = await started();
    const loggedOut = vi.fn();
    client.on(HttpApiEvent.SessionLoggedOut, loggedOut);
    // As a same-device sign-in with no refresh token leaves it before the old client stops.
    net.live.delete('at-1');
    vault.state.record = null;
    vi.mocked(storage.record).mockReturnValue(
      of({ userId: ME, lineage: 'L2' } as never),
    );

    await expect(client.whoami()).rejects.toBeInstanceOf(TokenRefreshError);

    expect(loggedOut).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(svc.accountIds()).toContain(ME);
    expect(client.clearStores).not.toHaveBeenCalled();
  });

  describe('off native', () => {
    it('leaves web untouched: no host, grant goes through the SDK', async () => {
      const { svc, client, net, vault, storage } = await started({
        session: OIDC_SESSION,
        available: false,
      });
      net.live.delete(OIDC_SESSION.accessToken);

      await expect(client.whoami()).resolves.toMatchObject({ user_id: ME });
      await svc.detachedClient(OIDC_SESSION).logout();

      expect(client.http.opts.tokenHost).toBeUndefined();
      expect(net.grants).toHaveLength(1);
      expect(net.grants[0].get('refresh_token')).toBe(
        OIDC_SESSION.refreshToken,
      );
      expect(storage.updateTokens).toHaveBeenCalledWith(
        ME,
        undefined,
        expect.any(String),
        expect.any(String),
        expect.any(Number),
      );
      expect(storage.dropRefreshToken).not.toHaveBeenCalled();
      expect(vault.migrateTokens).not.toHaveBeenCalled();
      expect(vault.currentTokens).not.toHaveBeenCalled();
      expect(vault.refreshTokens).not.toHaveBeenCalled();
      expect(vault.revokeTokens).not.toHaveBeenCalled();
    });

    it('still fails a web refresh whose write fails', async () => {
      const { svc, client, storage, rotations } = await started({
        session: OIDC_SESSION,
        available: false,
      });
      vi.mocked(storage.updateTokens).mockReturnValue(
        throwError(() => new Error('secure store locked')),
      );

      await expect(firstValueFrom(svc.refreshAccessToken(ME))).resolves.toBe(
        false,
      );

      expect(client.getAccessToken()).toBe(OIDC_SESSION.accessToken);
      expect(rotations).toEqual([]);
    });
  });
});
