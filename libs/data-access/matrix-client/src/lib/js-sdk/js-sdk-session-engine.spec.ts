import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  ConnectionError,
  EventStatus,
  HTTPError,
  HttpApiEvent,
  MatrixError,
  SyncState,
  TokenRefreshError,
  createClient,
} from 'matrix-js-sdk';
import { firstValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertPlainData, type EngineResult } from '@trinity/util/matrix';
import {
  JsSdkSessionEngine,
  toSessionSyncState,
} from './js-sdk-session-engine';
import {
  OIDC_SESSION,
  SESSION,
  SESSION_B,
  fakeClient,
  setup,
} from './matrix-client.spec-harness';
import {
  connectivityOf,
  type SessionAccessToken,
  type SessionSnapshot,
} from '../session-engine';

const storeMock = vi.hoisted(() => ({ startup: vi.fn(), destroy: vi.fn() }));

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

vi.mock('./crypto-wasm-loader', async () => {
  const { of: rxOf } = await import('rxjs');
  return { preloadCryptoWasm: () => rxOf(undefined) };
});

const KEYED = {
  ...SESSION,
  cryptoPrefix: 'trinity-crypto:@me:hs:DEV',
  cryptoStoreKeyed: true as const,
};

function collect<T>(source: { subscribe(next: (value: T) => void): unknown }) {
  const values: T[] = [];
  source.subscribe((value) => values.push(value));
  return values;
}

describe('JsSdkSessionEngine', () => {
  beforeEach(() => {
    vi.mocked(createClient).mockReset();
    storeMock.startup.mockReset().mockResolvedValue(undefined);
    storeMock.destroy.mockReset().mockResolvedValue(undefined);
  });

  async function live(...clients: ReturnType<typeof fakeClient>[]) {
    const harness = setup(...clients);
    await firstValueFrom(harness.svc.restorePersisted(SESSION, 'activate'));
    if (clients.length > 1) {
      await firstValueFrom(
        harness.svc.restorePersisted(SESSION_B, 'background'),
      );
    }
    return { ...harness, engine: TestBed.inject(JsSdkSessionEngine) };
  }

  it('maps every SDK sync state', () => {
    expect(toSessionSyncState(null)).toBe('starting');
    expect(
      [
        SyncState.Prepared,
        SyncState.Syncing,
        SyncState.Catchup,
        SyncState.Reconnecting,
        SyncState.Error,
        SyncState.Stopped,
      ].map(toSessionSyncState),
    ).toEqual([
      'prepared',
      'syncing',
      'catchup',
      'reconnecting',
      'error',
      'stopped',
    ]);
    expect(
      (
        [
          null,
          'starting',
          'prepared',
          'syncing',
          'catchup',
          'reconnecting',
          'error',
          'stopped',
        ] as const
      ).filter((state) => connectivityOf(state) === 'offline'),
    ).toEqual(['reconnecting', 'error']);
  });

  it('snapshots the registry in order', async () => {
    const { svc, engine } = await live(
      fakeClient(),
      fakeClient('https://other.example'),
    );

    const snapshot = engine.snapshot();

    expect(snapshot.accounts.map((a) => a.accountId)).toEqual(svc.accountIds());
    expect(snapshot.activeAccountId).toBe(svc.activeUserId());
    expect(snapshot.accounts.map((a) => a.generation)).toEqual(
      svc.all().map((a) => a.generation),
    );
    expect(snapshot.accounts[0]).toEqual({
      accountId: SESSION.userId,
      deviceId: SESSION.deviceId,
      generation: expect.any(Number),
      syncState: 'starting',
      serverSynced: false,
      roomsPrepared: false,
      waitingCount: 0,
      cryptoStoreEncrypted: false,
    });
    expect(() => assertPlainData(snapshot)).not.toThrow();
  });

  it('lists an account only once its client is registered', async () => {
    const harness = setup(fakeClient(), fakeClient('https://other.example'));
    const engine = TestBed.inject(JsSdkSessionEngine);
    const listedWithoutClient: string[] = [];
    engine.session().subscribe((snapshot) => {
      for (const { accountId } of snapshot.accounts) {
        if (!harness.svc.clientFor(accountId)) {
          listedWithoutClient.push(accountId);
        }
      }
    });

    await firstValueFrom(harness.svc.restorePersisted(SESSION, 'activate'));
    TestBed.tick();
    await firstValueFrom(harness.svc.restorePersisted(SESSION_B, 'background'));
    TestBed.tick();

    expect(engine.snapshot().accounts).toHaveLength(2);
    expect(listedWithoutClient).toEqual([]);
  });

  it('reflects a sync transition', async () => {
    const client = fakeClient();
    const { engine } = await live(client);
    const onSync = client.on.mock.calls.find(
      ([event]) => event === ClientEvent.Sync,
    )![1] as (state: SyncState, previous: SyncState | null) => void;

    onSync(SyncState.Syncing, null);

    await vi.waitFor(() =>
      expect(engine.snapshot().accounts[0]).toMatchObject({
        syncState: 'syncing',
        serverSynced: true,
        roomsPrepared: true,
      }),
    );
  });

  it('emits the current snapshot first and then changes only', async () => {
    const { svc, engine } = await live(
      fakeClient(),
      fakeClient('https://other.example'),
    );

    const first = collect<SessionSnapshot>(engine.session());
    const second = collect<SessionSnapshot>(engine.session());
    TestBed.tick();
    expect(first).toEqual([engine.snapshot()]);
    expect(second).toEqual(first);

    await firstValueFrom(engine.setActive(SESSION_B.userId));
    TestBed.tick();
    expect(first.map((s) => s.activeAccountId)).toEqual([
      SESSION.userId,
      SESSION_B.userId,
    ]);

    const before = engine.snapshot();
    svc.all()[0].waitingCount.set(1);
    svc.all()[0].waitingCount.set(0);
    TestBed.tick();
    expect(engine.snapshot()).toBe(before);
    expect(first).toHaveLength(2);
  });

  describe('maps each start failure', () => {
    it.each([
      [
        'reauthentication-required',
        'authentication',
        true,
        (client: ReturnType<typeof fakeClient>) =>
          client.startClient.mockRejectedValue(
            new MatrixError({ errcode: 'M_UNKNOWN_TOKEN' }, 401),
          ),
      ],
      [
        'transient-network',
        'network',
        false,
        (client: ReturnType<typeof fakeClient>) =>
          client.startClient.mockRejectedValue(new ConnectionError('offline')),
      ],
      [
        'crypto-failure',
        'unexpected',
        false,
        (client: ReturnType<typeof fakeClient>) =>
          client.initRustCrypto.mockRejectedValue(new Error('crypto detail')),
      ],
    ] as const)('%s', async (reason, kind, softLoggedOut, fail) => {
      const client = fakeClient();
      fail(client);
      setup(client);
      const engine = TestBed.inject(JsSdkSessionEngine);

      const result = await firstValueFrom(
        engine.restorePersisted(SESSION, 'activate'),
      );

      expect(result).toMatchObject({
        ok: false,
        failure: { code: 'account-start-failed', params: { reason }, kind },
      });
      expect(() => assertPlainData(result)).not.toThrow();
      expect(engine.snapshot().softLoggedOut.includes(SESSION.userId)).toBe(
        softLoggedOut,
      );
    });

    it.each([
      ['crypto-store-key-lost', { kind: 'missing' as const }, true],
      ['secure-storage-unavailable', { kind: 'unavailable' as const }, false],
    ] as const)('%s', async (reason, read, softLoggedOut) => {
      const { storeKeys } = setup(fakeClient());
      vi.mocked(storeKeys.read).mockResolvedValue(read);
      const engine = TestBed.inject(JsSdkSessionEngine);

      const result = await firstValueFrom(
        engine.restorePersisted(KEYED, 'activate'),
      );

      expect(result).toMatchObject({
        ok: false,
        failure: {
          code: 'account-start-failed',
          params: { reason },
          kind: 'unexpected',
        },
      });
      expect(engine.snapshot().softLoggedOut.includes(SESSION.userId)).toBe(
        softLoggedOut,
      );
    });

    it('errors the stream for a fault that is not a start failure', async () => {
      const client = fakeClient();
      client.startClient.mockRejectedValue(new Error('boom'));
      setup(client);
      const engine = TestBed.inject(JsSdkSessionEngine);

      await expect(
        firstValueFrom(engine.restorePersisted(SESSION, 'activate')),
      ).rejects.toThrow('boom');
    });

    it('reports a started account as ok', async () => {
      const { svc } = setup(fakeClient());
      const engine = TestBed.inject(JsSdkSessionEngine);

      await expect(
        firstValueFrom(engine.restorePersisted(SESSION, 'activate')),
      ).resolves.toEqual({ ok: true, value: null });
      expect(svc.activeUserId()).toBe(SESSION.userId);
    });
  });

  it('refuses to activate an account that is not live', async () => {
    const { svc, engine } = await live(
      fakeClient(),
      fakeClient('https://other.example'),
    );

    await expect(
      firstValueFrom(engine.activateAccount('@nobody:invalid', 'keep')),
    ).resolves.toEqual({
      ok: false,
      failure: {
        kind: 'unexpected',
        code: 'account-not-live',
        diagnostic: { kind: 'unexpected' },
      },
    } satisfies EngineResult<null>);
    await expect(
      firstValueFrom(engine.activateAccount(SESSION_B.userId, 'keep')),
    ).resolves.toEqual({ ok: true, value: null });
    expect(svc.activeUserId()).toBe(SESSION_B.userId);
  });

  it('keeps commands cold', async () => {
    const { svc, engine } = await live(
      fakeClient(),
      fakeClient('https://other.example'),
    );

    const command = engine.setActive(SESSION_B.userId);
    expect(svc.activeUserId()).toBe(SESSION.userId);

    let completed = false;
    const values: unknown[] = [];
    command.subscribe({
      next: (value) => values.push(value),
      complete: () => (completed = true),
    });
    expect(values).toEqual([null]);
    expect(completed).toBe(true);
    expect(svc.activeUserId()).toBe(SESSION_B.userId);
  });

  describe('confines tokens', () => {
    it('keeps them out of the snapshot', async () => {
      const { engine } = await live(
        fakeClient(),
        fakeClient('https://other.example'),
      );

      const text = JSON.stringify(engine.snapshot());
      expect(text).not.toContain(SESSION.accessToken);
      expect(text).not.toContain(SESSION_B.accessToken);
    });

    it('emits null for an account that is not live', async () => {
      const { engine } = await live(fakeClient());

      expect(collect(engine.accessToken('@nobody:invalid'))).toEqual([null]);
    });

    it("emits a password session's token without expiry", async () => {
      const client = {
        ...fakeClient(),
        getAccessToken: vi.fn().mockReturnValue(SESSION.accessToken),
      };
      const { engine } = await live(client);

      expect(collect(engine.accessToken(SESSION.userId))).toEqual([
        {
          homeserverUrl: 'https://hs.example',
          accessToken: 'tok',
          expiresAt: null,
          refreshable: false,
        },
      ]);
    });

    it("follows the live client's refresh", async () => {
      const { svc, storage } = setup(fakeClient());
      vi.mocked(storage.updateTokens).mockReturnValue(of(undefined));
      await firstValueFrom(svc.restorePersisted(OIDC_SESSION, 'activate'));
      const engine = TestBed.inject(JsSdkSessionEngine);
      const values = collect<SessionAccessToken | null>(
        engine.accessToken(SESSION.userId),
      );

      await vi.mocked(createClient).mock.calls[0][0].onTokenRefresh?.({
        accessToken: 'tok-new',
        refreshToken: 'refresh-new',
        expiry: new Date(9_999),
      });

      expect(values).toEqual([
        {
          homeserverUrl: 'https://hs.example',
          accessToken: 'tok',
          expiresAt: 1234,
          refreshable: true,
        },
        {
          homeserverUrl: 'https://hs.example',
          accessToken: 'tok-new',
          expiresAt: 9_999,
          refreshable: true,
        },
      ]);
    });

    it('emits nothing for a refresh from a replaced client', async () => {
      const { svc, storage } = setup(fakeClient(), fakeClient());
      vi.mocked(storage.updateTokens).mockReturnValue(of(undefined));
      await firstValueFrom(svc.restorePersisted(OIDC_SESSION, 'activate'));
      const replaced = vi.mocked(createClient).mock.calls[0][0];
      await firstValueFrom(
        svc.restorePersisted(
          {
            ...OIDC_SESSION,
            accessToken: 'tok-r',
            accessTokenExpiresAt: 5_555,
          },
          'activate',
        ),
      );
      const engine = TestBed.inject(JsSdkSessionEngine);
      const values = collect<SessionAccessToken | null>(
        engine.accessToken(SESSION.userId),
      );

      await replaced.onTokenRefresh?.({
        accessToken: 'tok-late',
        refreshToken: 'refresh-late',
        expiry: new Date(7_777),
      });
      TestBed.tick();

      expect(values).toEqual([
        {
          homeserverUrl: 'https://hs.example',
          accessToken: 'tok-r',
          expiresAt: 5_555,
          refreshable: true,
        },
      ]);
    });
  });

  describe('holds a server logout', () => {
    function loggedOut(client: ReturnType<typeof fakeClient>) {
      const [, handler] = client.on.mock.calls.find(
        ([event]) => event === HttpApiEvent.SessionLoggedOut,
      ) as [string, (err: MatrixError) => void];
      handler(new MatrixError({ errcode: 'M_UNKNOWN_TOKEN' }, 401));
    }

    it('reports the dead token as it happens and replays it once released', async () => {
      const client = fakeClient();
      const { engine } = await live(client);
      const effects = collect(engine.storageEffects());
      let completed = false;
      const updates: unknown[] = [];
      engine.holdServerLogout(SESSION.userId).subscribe({
        next: (update) => updates.push(update),
        complete: () => (completed = true),
      });

      loggedOut(client);

      expect(updates).toEqual([
        { kind: 'held', holdId: '1', tokenDied: false },
        { kind: 'token-died' },
      ]);
      expect(engine.snapshot().accounts).toHaveLength(1);
      await firstValueFrom(engine.releaseServerLogoutHold('1', false));
      expect(completed).toBe(true);
      expect(engine.snapshot().accounts).toEqual([]);
      expect(effects).toEqual([
        {
          kind: 'hard-logout',
          accountId: SESSION.userId,
          activeAccountId: null,
        },
      ]);
    });

    it('releases as not deleted on unsubscribe, and ends when the account leaves', async () => {
      const client = fakeClient();
      const { engine } = await live(client);
      const dropped = engine.holdServerLogout(SESSION.userId).subscribe();
      const kept = collect(engine.holdServerLogout(SESSION.userId));
      loggedOut(client);

      dropped.unsubscribe();
      expect(engine.snapshot().accounts).toHaveLength(1);
      await firstValueFrom(engine.remove(SESSION.userId));

      expect(kept.map((u) => (u as { kind: string }).kind)).toEqual([
        'held',
        'token-died',
        'released',
      ]);
    });

    it('sends the deactivation with the auth given and maps a UIA challenge', async () => {
      const client = {
        ...fakeClient(),
        deactivateAccount: vi
          .fn()
          .mockRejectedValueOnce(
            new MatrixError(
              { flows: [{ stages: ['m.login.password'] }], session: 's' },
              401,
            ),
          )
          .mockResolvedValueOnce({}),
      };
      const { engine } = await live(client);

      const probe = await firstValueFrom(
        engine.deactivateAccount(SESSION.userId, true, null),
      );
      const done = await firstValueFrom(
        engine.deactivateAccount(SESSION.userId, false, { session: 's' }),
      );

      expect(probe).toEqual({
        ok: false,
        failure: {
          kind: 'http',
          code: 'uia-required',
          diagnostic: { kind: 'http', httpStatus: 401 },
          params: {
            challenge: {
              flows: [{ stages: ['m.login.password'] }],
              completed: [],
              session: 's',
            },
          },
        },
      });
      expect(done).toEqual({ ok: true, value: null });
      expect(client.deactivateAccount.mock.calls).toEqual([
        [undefined, true],
        [{ session: 's' }, false],
      ]);
    });

    it.each([
      [new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 400), 'unsupported'],
      [new MatrixError({}, 404), 'unsupported'],
      [new MatrixError({}, 405), 'unsupported'],
      [new MatrixError({ errcode: 'M_NOT_FOUND' }, 404), 'request-failed'],
      [new MatrixError({ errcode: 'M_FORBIDDEN' }, 403), 'forbidden'],
      [new HTTPError('not found', 404), 'request-failed'],
      [new MatrixError({ errcode: 'M_UNKNOWN_TOKEN' }, 401), 'request-failed'],
      [new ConnectionError('offline'), 'request-failed'],
    ])('maps %s to %s', async (error, code) => {
      const client = {
        ...fakeClient(),
        deactivateAccount: vi.fn().mockRejectedValue(error),
      };
      const { engine } = await live(client);

      const result = await firstValueFrom(
        engine.deactivateAccount(SESSION.userId, false, null),
      );

      expect(!result.ok && result.failure.code).toBe(code);
      expect(() => assertPlainData(result)).not.toThrow();
    });

    it('marks a request that failed on a token refresh with that cause', async () => {
      const client = {
        ...fakeClient(),
        deactivateAccount: vi
          .fn()
          .mockRejectedValue(new TokenRefreshError(new Error('offline'))),
      };
      const { engine } = await live(client);

      const result = await firstValueFrom(
        engine.deactivateAccount(SESSION.userId, false, null),
      );

      expect(!result.ok && result.failure).toMatchObject({
        code: 'request-failed',
        params: { cause: 'session-refresh' },
      });
      expect(() => assertPlainData(result)).not.toThrow();
    });

    it('logs out with the live client, or a detached one that saves no refresh', async () => {
      const client = { ...fakeClient(), logout: vi.fn(async () => ({})) };
      const { engine, svc } = await live(client);
      const detached = { logout: vi.fn(async () => ({})) };
      const detach = vi
        .spyOn(svc, 'detachedClient')
        .mockReturnValue(detached as never);

      await expect(
        firstValueFrom(engine.logoutRemote(SESSION.userId)),
      ).resolves.toEqual({ ok: true, value: null });
      await expect(
        firstValueFrom(engine.logoutSession(OIDC_SESSION)),
      ).resolves.toEqual({ ok: true, value: null });

      expect(client.logout).toHaveBeenCalledWith(true);
      expect(detach).toHaveBeenCalledWith(OIDC_SESSION, {
        persistRefreshedTokens: false,
      });
      expect(detached.logout).toHaveBeenCalledWith(true);
    });

    it('logoutSession drops a held bundle', async () => {
      const importSecretsBundle = vi.fn().mockResolvedValue(undefined);
      const client = {
        ...fakeClient(),
        getUserId: vi.fn(() => SESSION.userId),
        getCrypto: vi.fn(() => ({
          importSecretsBundle,
          crossSignDevice: vi.fn().mockResolvedValue(undefined),
          checkKeyBackupAndEnable: vi.fn().mockResolvedValue(null),
          isCrossSigningReady: vi.fn().mockResolvedValue(true),
          getDeviceVerificationStatus: vi
            .fn()
            .mockResolvedValue({ crossSigningVerified: true }),
        })),
      };
      const { svc } = setup(client);
      const engine = TestBed.inject(JsSdkSessionEngine);
      vi.spyOn(svc, 'detachedClient').mockReturnValue({
        logout: vi.fn(async () => ({})),
      } as never);
      svc.holdLinkedSecrets(SESSION.userId, SESSION.deviceId, { held: true });

      await firstValueFrom(engine.logoutSession(SESSION));
      await firstValueFrom(svc.restorePersisted(SESSION, 'activate'));

      expect(importSecretsBundle).not.toHaveBeenCalled();
    });
  });

  it('reads the live tokens once, the refresh token included', async () => {
    const client = {
      ...fakeClient(),
      // Not the restored session's token: the engine must read the client's current one.
      getRefreshToken: vi.fn(() => 'rotated-refresh'),
    };
    const { svc } = setup(client);
    await firstValueFrom(svc.restorePersisted(OIDC_SESSION, 'activate'));
    const engine = TestBed.inject(JsSdkSessionEngine);

    await expect(
      firstValueFrom(engine.liveCredentials(SESSION.userId)),
    ).resolves.toEqual({ accessToken: 'tok', refreshToken: 'rotated-refresh' });
    await expect(
      firstValueFrom(engine.liveCredentials(SESSION_B.userId)),
    ).resolves.toBeNull();
  });

  it('reports outgoing work and pending texts as plain data', async () => {
    const echo = {
      status: EventStatus.NOT_SENT,
      getId: () => '~!room:hs:txn1',
      getType: () => 'm.room.message',
      getContent: () => ({ msgtype: 'm.text', body: 'see you' }),
      isRelation: () => false,
      threadRootId: undefined,
      getTxnId: () => undefined,
    };
    const room = {
      roomId: '!room:hs',
      getLiveTimeline: () => ({ getEvents: () => [echo] }),
      getThreads: () => [],
      getMyMembership: () => 'join',
      hasEncryptionStateEvent: () => true,
      txnToEvent: new Map(),
    };
    const client = {
      ...fakeClient(),
      getCurrentUploads: vi.fn(() => []),
      getRooms: vi.fn(() => [room]),
    };
    const { engine } = await live(client);

    await expect(firstValueFrom(engine.hasOutgoingWork())).resolves.toBe(false);
    const texts = await firstValueFrom(engine.pendingTextMessages());
    expect(texts).toEqual([
      {
        accountId: SESSION.userId,
        roomId: '!room:hs',
        threadRootId: null,
        text: 'see you',
      },
    ]);
    expect(() => assertPlainData(texts)).not.toThrow();
  });
});

const FORBIDDEN_IMPORT =
  /js-sdk\/|matrix-js-sdk|matrix-client\.service|session-engine\.token/;

function importSpecifiers(file: string): string[] {
  const source = readFileSync(join(import.meta.dirname, '..', file), 'utf8');
  return [...source.matchAll(/from '([^']+)'/g)].map(([, s]) => s);
}

describe('SDK-free boundary files', () => {
  it('session-engine.ts imports neither matrix-js-sdk nor the js-sdk adapter', () => {
    expect(importSpecifiers('session-engine.ts')).toEqual([
      'rxjs',
      '@trinity/util/matrix',
    ]);
  });

  it.each(
    readdirSync(join(import.meta.dirname, '../../contract')).filter((f) =>
      f.endsWith('.ts'),
    ),
  )('contract/%s imports no SDK, adapter or wiring', (file) => {
    expect(
      importSpecifiers(`../contract/${file}`).filter((s) =>
        FORBIDDEN_IMPORT.test(s),
      ),
    ).toEqual([]);
  });

  it('session-state.service.ts reaches the engine only through the token', () => {
    expect(
      importSpecifiers('session-state.service.ts').filter((s) =>
        FORBIDDEN_IMPORT.test(s),
      ),
    ).toEqual(['./session-engine.token']);
  });
});
