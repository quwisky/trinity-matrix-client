import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
  type SessionSyncState,
} from '@trinity/data-access/matrix-client';
import { MediaPipeline } from '@trinity/data-access/media';
import type { MessageView } from './message-presentation';
import {
  ConversationTimelineReadiness,
  type ReadinessTimeline,
} from './conversation-timeline-readiness';
import {
  FakeTimelineEngine,
  fakeEventItem,
} from '../contract/fake-timeline-engine';
import { CONVERSATION_MESSAGE_ADAPTER } from './conversation-message-adapter.service';
import { TIMELINE_ENGINE } from './timeline-engine.token';
import { TimelineService } from './timeline.service';

const ROOM = '!a:hs';
const KEY = { accountId: '@me:hs', roomId: ROOM };

/**
 * The Account's session status as the js-sdk session engine reports it: `roomsPrepared`
 * and `serverSynced` latch like the client's, and a `prepared` from the cache is not a
 * server sync. An empty `history` leaves the Account `starting`.
 */
function fakeSession(history: readonly SessionSyncState[] = ['syncing']) {
  let status: SessionAccountStatus = {
    accountId: KEY.accountId,
    generation: 1,
    syncState: 'starting',
    serverSynced: false,
    roomsPrepared: false,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
  const apply = (syncState: SessionSyncState, fromCache: boolean): void => {
    const prepared = syncState === 'prepared' || syncState === 'syncing';
    status = {
      ...status,
      syncState,
      roomsPrepared: status.roomsPrepared || prepared,
      serverSynced: status.serverSynced || (prepared && !fromCache),
    };
  };
  for (const state of history) apply(state, false);
  const snapshot = signal<SessionSnapshot>({
    ...EMPTY_SESSION,
    accounts: [status],
  });
  const sync = (
    syncState: SessionSyncState,
    { fromCache = false }: { fromCache?: boolean } = {},
  ): void => {
    apply(syncState, fromCache);
    snapshot.set({ ...EMPTY_SESSION, accounts: [status] });
    TestBed.tick();
  };
  TestBed.configureTestingModule({
    providers: [{ provide: SESSION_SNAPSHOT, useValue: snapshot }],
  });
  return { sync, snapshot };
}

function fakeTimeline() {
  const available = signal(false);
  const messages = signal<MessageView[]>([]);
  const canLoadOlder = signal(false);
  const loadingOlder = signal(false);
  const pages: Subject<void>[] = [];
  const timeline = {
    available,
    messages,
    canLoadOlder,
    loadingOlder,
    loadOlder: vi.fn(() => {
      const page = new Subject<void>();
      pages.push(page);
      return page.asObservable();
    }),
  };
  /** The engine delivers the Room: the store becomes available with `rows`. */
  const addRoom = (rows: MessageView[] = []): void => {
    messages.set(rows);
    available.set(true);
    TestBed.tick();
  };
  return {
    timeline,
    available,
    messages,
    canLoadOlder,
    loadingOlder,
    pages,
    addRoom,
  };
}

const message = { id: '$m' } as unknown as MessageView;

function start(timeline: ReadinessTimeline) {
  const readiness = TestBed.runInInjectionContext(
    () => new ConversationTimelineReadiness(),
  );
  readiness.start(KEY, timeline);
  return readiness;
}

describe('ConversationTimelineReadiness', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is ready in the same call when the Room has messages and sync is done', () => {
    fakeSession();
    const { timeline, messages, available } = fakeTimeline();
    available.set(true);
    messages.set([message]);
    const readiness = start(timeline);
    expect(readiness.state()).toEqual({ kind: 'ready' });
  });

  it('is empty in the same call when nothing is displayable and there is no older history', () => {
    fakeSession();
    const { timeline, available } = fakeTimeline();
    available.set(true);
    const readiness = start(timeline);
    expect(readiness.state()).toEqual({ kind: 'empty' });
  });

  it('waits for a pending Room, then follows it', () => {
    const session = fakeSession([]);
    const { timeline, addRoom } = fakeTimeline();
    const readiness = start(timeline);
    TestBed.tick();
    expect(readiness.state()).toEqual({
      kind: 'loading',
      reason: 'room-pending',
      partial: false,
    });
    addRoom([message]);
    expect(readiness.state()).toMatchObject({ reason: 'initial-sync' });
    session.sync('syncing');
    expect(readiness.state()).toEqual({ kind: 'ready' });
  });

  it('fails a pending Room after the next completed sync still lacks it', () => {
    const session = fakeSession([]);
    const { timeline, addRoom } = fakeTimeline();
    const readiness = start(timeline);
    session.sync('syncing');
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'room-unavailable',
    });
    // Still watching for the Room to arrive.
    addRoom();
    expect(readiness.state()).toEqual({ kind: 'empty' });
  });

  it('reports an absent Room at once when the Account has already synced', () => {
    fakeSession();
    const readiness = start(fakeTimeline().timeline);
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'room-unavailable',
    });
  });

  it('keeps a pending Room loading through a sync restored from the cache', () => {
    const session = fakeSession([]);
    const readiness = start(fakeTimeline().timeline);
    session.sync('prepared', { fromCache: true });
    expect(readiness.state()).toMatchObject({
      kind: 'loading',
      reason: 'room-pending',
    });
    session.sync('syncing');
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'room-unavailable',
    });
  });

  it('keeps an absent Room loading when only the cached sync has been restored', () => {
    const session = fakeSession([]);
    session.sync('prepared', { fromCache: true });
    const { timeline, addRoom } = fakeTimeline();
    const readiness = start(timeline);
    expect(readiness.state()).toMatchObject({
      kind: 'loading',
      reason: 'room-pending',
    });
    // Joined since the cache was written: delivered by the live catch-up sync.
    addRoom([message]);
    expect(readiness.state()).toEqual({ kind: 'ready' });
  });

  it('fails a pending Room on a live prepared (no cache) that still lacks it', () => {
    const session = fakeSession([]);
    const readiness = start(fakeTimeline().timeline);
    session.sync('prepared');
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'room-unavailable',
    });
  });

  it('follows the Room when it arrives after room-unavailable', () => {
    fakeSession();
    const { timeline, addRoom } = fakeTimeline();
    const readiness = start(timeline);
    expect(readiness.state()).toMatchObject({ reason: 'room-unavailable' });
    addRoom();
    expect(readiness.state()).toEqual({ kind: 'empty' });
  });

  it('stops watching for the Room when stopped in the error state', () => {
    fakeSession();
    const { timeline, addRoom } = fakeTimeline();
    const readiness = start(timeline);
    readiness.stop();
    addRoom();
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'room-unavailable',
    });
  });

  it('fails with sync-stopped when sync stops or errors while waiting', () => {
    for (const state of ['stopped', 'error'] as const) {
      TestBed.resetTestingModule();
      const session = fakeSession([]);
      const readiness = start(fakeTimeline().timeline);
      session.sync(state);
      expect(readiness.state()).toEqual({
        kind: 'error',
        reason: 'sync-stopped',
      });
    }
  });

  it('retries a failed wait from the start', () => {
    fakeSession();
    const { timeline, available } = fakeTimeline();
    const readiness = start(timeline);
    expect(readiness.state()).toMatchObject({ reason: 'room-unavailable' });
    available.set(true);
    readiness.retry();
    expect(readiness.state()).toEqual({ kind: 'empty' });
  });

  it('reports initial sync with partial messages and settles when sync is prepared', () => {
    const session = fakeSession([]);
    const { timeline, available, messages } = fakeTimeline();
    available.set(true);
    const readiness = start(timeline);
    expect(readiness.state()).toEqual({
      kind: 'loading',
      reason: 'initial-sync',
      partial: false,
    });
    messages.set([message]);
    expect(readiness.state()).toEqual({
      kind: 'loading',
      reason: 'initial-sync',
      partial: true,
    });
    session.sync('prepared');
    expect(readiness.state()).toEqual({ kind: 'ready' });
  });

  it('settles an initial sync whose prepared and error arrive in one change', () => {
    const { snapshot } = fakeSession([]);
    const { timeline, available } = fakeTimeline();
    available.set(true);
    const readiness = start(timeline);
    expect(readiness.state()).toMatchObject({ reason: 'initial-sync' });
    snapshot.update((s) => ({
      ...s,
      accounts: s.accounts.map((a) => ({
        ...a,
        syncState: 'error' as const,
        roomsPrepared: true,
      })),
    }));
    TestBed.tick();
    expect(readiness.state()).toEqual({ kind: 'empty' });
  });

  it('backfills an empty Room until a page brings messages', () => {
    fakeSession();
    const { timeline, available, messages, canLoadOlder, pages } =
      fakeTimeline();
    available.set(true);
    canLoadOlder.set(true);
    const readiness = start(timeline);
    expect(readiness.state()).toEqual({
      kind: 'loading',
      reason: 'backfill',
      partial: false,
    });
    pages[0].complete();
    expect(pages).toHaveLength(2);
    messages.set([message]);
    pages[1].complete();
    expect(readiness.state()).toEqual({ kind: 'ready' });
  });

  it('settles empty after 3 pages without messages', () => {
    fakeSession();
    const { timeline, available, canLoadOlder, pages } = fakeTimeline();
    available.set(true);
    canLoadOlder.set(true);
    const readiness = start(timeline);
    pages[0].complete();
    pages[1].complete();
    pages[2].complete();
    expect(pages).toHaveLength(3);
    expect(readiness.state()).toEqual({ kind: 'empty' });
  });

  it('reports a failed backfill and retries it', () => {
    fakeSession();
    const { timeline, available, messages, canLoadOlder, pages } =
      fakeTimeline();
    available.set(true);
    canLoadOlder.set(true);
    const readiness = start(timeline);
    pages[0].error(new Error('500'));
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'backfill-failed',
    });
    readiness.retry();
    messages.set([message]);
    pages[1].complete();
    expect(readiness.state()).toEqual({ kind: 'ready' });
  });

  it('pauses backfill while hidden and resumes when visible', () => {
    fakeSession();
    const { timeline, available, messages, canLoadOlder, pages } =
      fakeTimeline();
    available.set(true);
    canLoadOlder.set(true);
    const readiness = start(timeline);
    readiness.setVisible(false);
    expect(pages[0].observed).toBe(false);
    expect(readiness.state()).toEqual({
      kind: 'loading',
      reason: 'backfill',
      partial: false,
    });
    readiness.setVisible(true);
    messages.set([message]);
    pages[1].complete();
    expect(readiness.state()).toEqual({ kind: 'ready' });
  });

  it('ignores changes after stop', () => {
    const session = fakeSession([]);
    const { timeline, addRoom } = fakeTimeline();
    const readiness = start(timeline);
    readiness.stop();
    addRoom([message]);
    session.sync('syncing');
    readiness.retry();
    expect(readiness.state()).toEqual({
      kind: 'loading',
      reason: 'room-pending',
      partial: false,
    });
  });

  it('unsubscribes an in-flight backfill on stop', () => {
    fakeSession();
    const { timeline, available, canLoadOlder, pages } = fakeTimeline();
    available.set(true);
    canLoadOlder.set(true);
    const readiness = start(timeline);
    readiness.stop();
    expect(pages[0].observed).toBe(false);
  });

  it('does not settle empty on a synchronous no-op page, then backfills once it can', () => {
    fakeSession();
    const { timeline, available, messages, canLoadOlder, pages } =
      fakeTimeline();
    available.set(true);
    canLoadOlder.set(true);
    timeline.loadOlder.mockImplementation(() => of(void 0));
    const readiness = start(timeline);
    expect(timeline.loadOlder).toHaveBeenCalledTimes(1);
    expect(readiness.state()).toEqual({
      kind: 'loading',
      reason: 'backfill',
      partial: false,
    });
    timeline.loadOlder.mockImplementation(() => {
      const page = new Subject<void>();
      pages.push(page);
      return page.asObservable();
    });
    canLoadOlder.set(false);
    canLoadOlder.set(true);
    TestBed.tick();
    expect(pages).toHaveLength(1);
    messages.set([message]);
    pages[0].complete();
    expect(readiness.state()).toEqual({ kind: 'ready' });
  });

  it('ignores a live page after a synchronous one when stopped', () => {
    fakeSession();
    const { timeline, available, canLoadOlder, pages } = fakeTimeline();
    available.set(true);
    canLoadOlder.set(true);
    let calls = 0;
    timeline.loadOlder.mockImplementation(() => {
      if (++calls === 1) return of(void 0);
      const page = new Subject<void>();
      pages.push(page);
      return page.asObservable();
    });
    const readiness = start(timeline);
    TestBed.tick();
    canLoadOlder.set(false);
    canLoadOlder.set(true);
    TestBed.tick();
    expect(pages).toHaveLength(1);
    readiness.stop();
    expect(pages[0].observed).toBe(false);
    pages[0].complete();
    expect(readiness.state()).toEqual({
      kind: 'loading',
      reason: 'backfill',
      partial: false,
    });
  });

  it('waits for loadingOlder to drop before paging', () => {
    fakeSession();
    const { timeline, available, canLoadOlder, loadingOlder, pages } =
      fakeTimeline();
    available.set(true);
    canLoadOlder.set(true);
    loadingOlder.set(true);
    start(timeline);
    expect(timeline.loadOlder).not.toHaveBeenCalled();
    loadingOlder.set(false);
    TestBed.tick();
    expect(pages).toHaveLength(1);
  });

  it('fails sync-stopped immediately when a pending Room meets an already stopped sync', () => {
    fakeSession(['stopped']);
    const readiness = start(fakeTimeline().timeline);
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'sync-stopped',
    });
  });

  it('settles from the store when an already synced Account is Reconnecting, Catchup or Error', () => {
    for (const state of ['reconnecting', 'catchup', 'error'] as const) {
      TestBed.resetTestingModule();
      fakeSession(['syncing', state]);
      const { timeline, available, messages } = fakeTimeline();
      available.set(true);
      messages.set([message]);
      expect(start(timeline).state()).toEqual({ kind: 'ready' });
    }
  });

  it('backfills in an Errored client instead of failing', () => {
    fakeSession(['syncing', 'error']);
    const { timeline, available, canLoadOlder, pages } = fakeTimeline();
    available.set(true);
    canLoadOlder.set(true);
    const readiness = start(timeline);
    TestBed.tick();
    expect(pages).toHaveLength(1);
    expect(readiness.state()).toEqual({
      kind: 'loading',
      reason: 'backfill',
      partial: false,
    });
  });

  it('keeps waiting for a Room through Reconnecting and Catchup', () => {
    const session = fakeSession([]);
    const readiness = start(fakeTimeline().timeline);
    session.sync('reconnecting');
    session.sync('catchup');
    expect(readiness.state()).toMatchObject({ reason: 'room-pending' });
  });

  it('re-runs when sync resumes after sync-stopped, and stop ends the recovery', () => {
    const session = fakeSession([]);
    const { timeline, available } = fakeTimeline();
    available.set(true);
    const readiness = start(timeline);
    session.sync('error');
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'sync-stopped',
    });
    session.sync('syncing');
    expect(readiness.state()).toEqual({ kind: 'empty' });

    TestBed.resetTestingModule();
    const stopped = fakeSession(['stopped']);
    const again = start(fakeTimeline().timeline);
    expect(again.state()).toMatchObject({ reason: 'sync-stopped' });
    again.stop();
    stopped.sync('syncing');
    expect(again.state()).toMatchObject({ reason: 'sync-stopped' });
  });

  it('does not fail a wait when stop runs in the same turn as the sync error', () => {
    const { snapshot } = fakeSession([]);
    const { timeline } = fakeTimeline();
    const readiness = start(timeline);
    TestBed.tick();
    const pending = readiness.state();
    snapshot.update((s) => ({
      ...s,
      accounts: s.accounts.map((a) => ({ ...a, syncState: 'error' as const })),
    }));
    readiness.stop();
    TestBed.tick();
    expect(readiness.state()).toBe(pending);
  });

  it('pages nothing for a Room that arrives while hidden until it is shown', () => {
    fakeSession();
    const { timeline, canLoadOlder, addRoom, pages } = fakeTimeline();
    canLoadOlder.set(true);
    const readiness = start(timeline);
    readiness.setVisible(false);
    addRoom();
    expect(readiness.state()).toMatchObject({ reason: 'backfill' });
    expect(pages).toHaveLength(0);
    readiness.setVisible(true);
    expect(pages).toHaveLength(1);
  });

  it('does not count a page cancelled by hide toward the cap', () => {
    fakeSession();
    const { timeline, available, canLoadOlder, pages } = fakeTimeline();
    available.set(true);
    canLoadOlder.set(true);
    const readiness = start(timeline);
    for (let i = 0; i < 3; i++) {
      readiness.setVisible(false);
      readiness.setVisible(true);
    }
    expect(pages).toHaveLength(4);
    pages[3].complete();
    pages[4].complete();
    expect(readiness.state()).toMatchObject({ reason: 'backfill' });
    pages[5].complete();
    expect(readiness.state()).toEqual({ kind: 'empty' });
  });

  /** Real TimelineService and readiness over a fake engine, with `fake.alice` synced. */
  function overFake(fake: FakeTimelineEngine) {
    const acknowledge = vi.fn(() => of({ kind: 'applied' }));
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        ConversationTimelineReadiness,
        { provide: TIMELINE_ENGINE, useValue: fake },
        { provide: CONVERSATION_MESSAGE_ADAPTER, useValue: { acknowledge } },
        {
          provide: SESSION_SNAPSHOT,
          useValue: signal<SessionSnapshot>({
            ...EMPTY_SESSION,
            accounts: [
              {
                accountId: fake.alice,
                generation: 1,
                syncState: 'syncing',
                serverSynced: true,
                roomsPrepared: true,
                waitingCount: 0,
                cryptoStoreEncrypted: true,
              },
            ],
          }),
        },
        {
          provide: SESSION_ENGINE,
          useValue: { session: () => new Subject<SessionSnapshot>() },
        },
        { provide: MediaPipeline, useValue: { present: () => ({}) } },
      ],
    });
    return {
      acknowledge,
      timeline: TestBed.inject(TimelineService),
      readiness: TestBed.inject(ConversationTimelineReadiness),
    };
  }

  it('readiness never shows backfill when the snapshot is synchronous', () => {
    const fake = new FakeTimelineEngine();
    const key = { accountId: fake.alice, roomId: ROOM };
    fake.seed(fake.alice, ROOM, [fakeEventItem('$1', fake.bob)]);
    const { timeline, readiness } = overFake(fake);
    const seen: string[] = [];
    timeline.open(key);
    readiness.start(key, timeline);
    seen.push(readiness.state().kind);
    TestBed.tick();
    seen.push(readiness.state().kind);
    expect(timeline.messages().map((m) => m.id)).toEqual(['$1']);
    expect(seen).toEqual(['ready', 'ready']);
  });

  it('keeps a Conversation hidden when its Room arrives while hidden', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const fake = new FakeTimelineEngine();
    const key = { accountId: fake.alice, roomId: ROOM };
    const { timeline, readiness, acknowledge } = overFake(fake);
    timeline.open(key);
    readiness.start(key, timeline);
    timeline.setVisible(false);
    readiness.setVisible(false);
    expect(readiness.state()).toMatchObject({ reason: 'room-unavailable' });

    const events = Array.from({ length: 101 }, (_, i) =>
      fakeEventItem(`$${i}`, fake.bob),
    );
    fake.seed(fake.alice, ROOM, events);
    TestBed.tick();

    expect(timeline.available()).toBe(true);
    expect(readiness.state()).toEqual({ kind: 'ready' });
    // Still compacted to the hidden window, and nothing marked read.
    expect(timeline.messages()).toHaveLength(100);
    expect(timeline.messages()[0].id).toBe('$1');
    expect(acknowledge).not.toHaveBeenCalled();

    timeline.setVisible(true);
    expect(timeline.messages()).toHaveLength(101);
    expect(acknowledge).toHaveBeenCalledOnce();
  });
});
