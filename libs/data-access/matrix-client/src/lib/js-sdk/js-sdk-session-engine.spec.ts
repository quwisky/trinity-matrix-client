import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  ConnectionError,
  EventStatus,
  MatrixError,
  SyncState,
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

vi.mock('@trinity/util/matrix', async (importOriginal) => {
  const { of: rxOf } = await import('rxjs');
  return {
    ...(await importOriginal<typeof import('@trinity/util/matrix')>()),
    preloadCryptoWasm: () => rxOf(undefined),
  };
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
    for (const account of snapshot.accounts) {
      expect(account.generation).toBe(
        svc.sessionGenerations().get(account.accountId),
      );
    }
    expect(snapshot.accounts[0]).toEqual({
      accountId: SESSION.userId,
      generation: expect.any(Number),
      syncState: 'starting',
      serverSynced: false,
      roomsPrepared: false,
      waitingCount: 0,
      cryptoStoreEncrypted: false,
    });
    expect(() => assertPlainData(snapshot)).not.toThrow();
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
        { accessToken: 'tok', expiresAt: null, refreshable: false },
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
        { accessToken: 'tok', expiresAt: 1234, refreshable: true },
        { accessToken: 'tok-new', expiresAt: 9_999, refreshable: true },
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
        { accessToken: 'tok-r', expiresAt: 5_555, refreshable: true },
      ]);
    });
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
