import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ClientEvent, SyncState, type MatrixClient } from 'matrix-js-sdk';
import { Subject, of } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MessageView } from './message-presentation';
import {
  ConversationTimelineReadiness,
  type ReadinessTimeline,
} from './conversation-timeline-readiness';

type Handler = (...args: unknown[]) => void;

function fakeClient(sync: SyncState | null = SyncState.Syncing) {
  const handlers = new Map<string, Set<Handler>>();
  const rooms = new Set<string>();
  let state = sync;
  const client = {
    rooms,
    setSync: (next: SyncState) => {
      state = next;
      for (const h of [...(handlers.get(ClientEvent.Sync) ?? [])]) h(next);
    },
    addRoom: (roomId: string) => {
      rooms.add(roomId);
      for (const h of [...(handlers.get(ClientEvent.Room) ?? [])])
        h({ roomId });
    },
    getRoom: (roomId: string) => (rooms.has(roomId) ? { roomId } : null),
    getSyncState: () => state,
    on: (event: string, h: Handler) => {
      handlers.set(event, (handlers.get(event) ?? new Set()).add(h));
    },
    off: (event: string, h: Handler) => handlers.get(event)?.delete(h),
    listeners: () => [...handlers.values()].reduce((n, s) => n + s.size, 0),
  };
  return client;
}

function fakeTimeline() {
  const messages = signal<MessageView[]>([]);
  const canLoadOlder = signal(false);
  const loadingOlder = signal(false);
  const pages: Subject<void>[] = [];
  const timeline = {
    messages,
    canLoadOlder,
    loadingOlder,
    open: vi.fn(),
    setVisible: vi.fn(),
    loadOlder: vi.fn(() => {
      const page = new Subject<void>();
      pages.push(page);
      return page.asObservable();
    }),
  };
  return { timeline, messages, canLoadOlder, loadingOlder, pages };
}

const message = { id: '$m' } as unknown as MessageView;
const ROOM = '!a:hs';

function start(
  client: ReturnType<typeof fakeClient>,
  timeline: ReadinessTimeline,
) {
  const readiness = TestBed.runInInjectionContext(
    () => new ConversationTimelineReadiness(),
  );
  readiness.start(ROOM, client as unknown as MatrixClient, timeline);
  return readiness;
}

describe('ConversationTimelineReadiness', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is ready in the same call when the Room has messages and sync is done', () => {
    const client = fakeClient();
    client.rooms.add(ROOM);
    const { timeline, messages } = fakeTimeline();
    timeline.open.mockImplementation(() => messages.set([message]));
    const readiness = start(client, timeline);
    expect(timeline.open).toHaveBeenCalledWith(ROOM, client);
    expect(readiness.state()).toEqual({ kind: 'ready' });
  });

  it('is empty in the same call when nothing is displayable and there is no older history', () => {
    const client = fakeClient();
    client.rooms.add(ROOM);
    const readiness = start(client, fakeTimeline().timeline);
    expect(readiness.state()).toEqual({ kind: 'empty' });
  });

  it('waits for a pending Room, then opens it', () => {
    const client = fakeClient(null);
    const { timeline, messages } = fakeTimeline();
    const readiness = start(client, timeline);
    expect(readiness.state()).toEqual({
      kind: 'loading',
      reason: 'room-pending',
      partial: false,
    });
    expect(timeline.open).not.toHaveBeenCalled();
    timeline.open.mockImplementation(() => messages.set([message]));
    client.addRoom(ROOM);
    expect(timeline.open).toHaveBeenCalledOnce();
    client.setSync(SyncState.Syncing);
    expect(readiness.state()).toEqual({ kind: 'ready' });
    expect(client.listeners()).toBe(0);
  });

  it('fails a pending Room after the next completed sync still lacks it', () => {
    const client = fakeClient(null);
    const readiness = start(client, fakeTimeline().timeline);
    client.setSync(SyncState.Syncing);
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'room-unavailable',
    });
    // Still watching for the Room to arrive.
    expect(client.listeners()).toBe(2);
  });

  it('reports an absent Room at once when the Account has already synced', () => {
    const client = fakeClient();
    const readiness = start(client, fakeTimeline().timeline);
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'room-unavailable',
    });
  });

  it('opens the Room when it arrives after room-unavailable', () => {
    const client = fakeClient();
    const { timeline } = fakeTimeline();
    const readiness = start(client, timeline);
    expect(readiness.state()).toMatchObject({ reason: 'room-unavailable' });
    client.addRoom(ROOM);
    expect(timeline.open).toHaveBeenCalledWith(ROOM, client);
    expect(readiness.state()).toEqual({ kind: 'empty' });
  });

  it('stops listening for the Room when stopped in the error state', () => {
    const client = fakeClient();
    const { timeline } = fakeTimeline();
    const readiness = start(client, timeline);
    readiness.stop();
    expect(client.listeners()).toBe(0);
    client.addRoom(ROOM);
    expect(timeline.open).not.toHaveBeenCalled();
  });

  it('fails with sync-stopped when sync stops or errors while waiting', () => {
    for (const state of [SyncState.Stopped, SyncState.Error]) {
      const client = fakeClient(null);
      const readiness = start(client, fakeTimeline().timeline);
      client.setSync(state);
      expect(readiness.state()).toEqual({
        kind: 'error',
        reason: 'sync-stopped',
      });
    }
  });

  it('retries a failed wait from the start', () => {
    const client = fakeClient();
    const { timeline } = fakeTimeline();
    const readiness = start(client, timeline);
    client.setSync(SyncState.Syncing);
    client.rooms.add(ROOM);
    readiness.retry();
    expect(timeline.open).toHaveBeenCalledOnce();
    expect(readiness.state()).toEqual({ kind: 'empty' });
  });

  it('reports initial sync with partial messages and settles when sync is prepared', () => {
    const client = fakeClient(null);
    client.rooms.add(ROOM);
    const { timeline, messages } = fakeTimeline();
    const readiness = start(client, timeline);
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
    client.setSync(SyncState.Prepared);
    expect(readiness.state()).toEqual({ kind: 'ready' });
  });

  it('backfills an empty Room until a page brings messages', () => {
    const client = fakeClient();
    client.rooms.add(ROOM);
    const { timeline, messages, canLoadOlder, pages } = fakeTimeline();
    canLoadOlder.set(true);
    const readiness = start(client, timeline);
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
    const client = fakeClient();
    client.rooms.add(ROOM);
    const { timeline, canLoadOlder, pages } = fakeTimeline();
    canLoadOlder.set(true);
    const readiness = start(client, timeline);
    pages[0].complete();
    pages[1].complete();
    pages[2].complete();
    expect(pages).toHaveLength(3);
    expect(readiness.state()).toEqual({ kind: 'empty' });
  });

  it('reports a failed backfill and retries it', () => {
    const client = fakeClient();
    client.rooms.add(ROOM);
    const { timeline, messages, canLoadOlder, pages } = fakeTimeline();
    canLoadOlder.set(true);
    const readiness = start(client, timeline);
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
    const client = fakeClient();
    client.rooms.add(ROOM);
    const { timeline, messages, canLoadOlder, pages } = fakeTimeline();
    canLoadOlder.set(true);
    const readiness = start(client, timeline);
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

  it('ignores events after stop and detaches every listener', () => {
    const client = fakeClient(null);
    const { timeline } = fakeTimeline();
    const readiness = start(client, timeline);
    readiness.stop();
    expect(client.listeners()).toBe(0);
    client.addRoom(ROOM);
    readiness.retry();
    expect(timeline.open).not.toHaveBeenCalled();
    expect(readiness.state()).toEqual({
      kind: 'loading',
      reason: 'room-pending',
      partial: false,
    });
  });

  it('unsubscribes an in-flight backfill on stop', () => {
    const client = fakeClient();
    client.rooms.add(ROOM);
    const { timeline, canLoadOlder, pages } = fakeTimeline();
    canLoadOlder.set(true);
    const readiness = start(client, timeline);
    readiness.stop();
    expect(pages[0].observed).toBe(false);
  });

  it('does not settle empty on a synchronous no-op page, then backfills once it can', () => {
    const client = fakeClient();
    client.rooms.add(ROOM);
    const { timeline, messages, canLoadOlder, pages } = fakeTimeline();
    canLoadOlder.set(true);
    timeline.loadOlder.mockImplementation(() => of(void 0));
    const readiness = start(client, timeline);
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
    const client = fakeClient();
    client.rooms.add(ROOM);
    const { timeline, canLoadOlder, pages } = fakeTimeline();
    canLoadOlder.set(true);
    let calls = 0;
    timeline.loadOlder.mockImplementation(() => {
      if (++calls === 1) return of(void 0);
      const page = new Subject<void>();
      pages.push(page);
      return page.asObservable();
    });
    const readiness = start(client, timeline);
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
    const client = fakeClient();
    client.rooms.add(ROOM);
    const { timeline, canLoadOlder, loadingOlder, pages } = fakeTimeline();
    canLoadOlder.set(true);
    loadingOlder.set(true);
    start(client, timeline);
    expect(timeline.loadOlder).not.toHaveBeenCalled();
    loadingOlder.set(false);
    TestBed.tick();
    expect(pages).toHaveLength(1);
  });

  it('fails sync-stopped immediately when a pending Room meets an already stopped sync', () => {
    const client = fakeClient(SyncState.Stopped);
    const readiness = start(client, fakeTimeline().timeline);
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'sync-stopped',
    });
  });

  it('settles from the store when an already synced Account is Reconnecting, Catchup or Error', () => {
    for (const state of [
      SyncState.Reconnecting,
      SyncState.Catchup,
      SyncState.Error,
    ]) {
      const client = fakeClient(state);
      client.rooms.add(ROOM);
      const { timeline, messages } = fakeTimeline();
      timeline.open.mockImplementation(() => messages.set([message]));
      expect(start(client, timeline).state()).toEqual({ kind: 'ready' });
    }
  });

  it('backfills in an Errored client instead of failing', () => {
    const client = fakeClient(SyncState.Error);
    client.rooms.add(ROOM);
    const { timeline, canLoadOlder, pages } = fakeTimeline();
    canLoadOlder.set(true);
    const readiness = start(client, timeline);
    expect(pages).toHaveLength(1);
    expect(readiness.state()).toEqual({
      kind: 'loading',
      reason: 'backfill',
      partial: false,
    });
  });

  it('keeps waiting for a Room through Reconnecting and Catchup', () => {
    const client = fakeClient(null);
    const readiness = start(client, fakeTimeline().timeline);
    client.setSync(SyncState.Reconnecting);
    client.setSync(SyncState.Catchup);
    expect(readiness.state()).toMatchObject({ reason: 'room-pending' });
  });

  it('re-runs when sync resumes after sync-stopped, and stop detaches the recovery listener', () => {
    const client = fakeClient(null);
    client.rooms.add(ROOM);
    const { timeline } = fakeTimeline();
    const readiness = start(client, timeline);
    client.setSync(SyncState.Error);
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'sync-stopped',
    });
    expect(client.listeners()).toBe(1);
    client.setSync(SyncState.Syncing);
    expect(readiness.state()).toEqual({ kind: 'empty' });
    expect(client.listeners()).toBe(0);

    const stopped = fakeClient(SyncState.Stopped);
    const again = start(stopped, fakeTimeline().timeline);
    expect(stopped.listeners()).toBe(1);
    again.stop();
    expect(stopped.listeners()).toBe(0);
  });

  it('attaches no recovery listener when stop runs earlier in the same Sync emit that fails the wait', () => {
    const client = fakeClient();
    const readiness = TestBed.runInInjectionContext(
      () => new ConversationTimelineReadiness(),
    );
    // Registered before start(), so it runs first in the emit's listener snapshot.
    const stopper = (): void => {
      client.off(ClientEvent.Sync, stopper);
      readiness.stop();
    };
    client.on(ClientEvent.Sync, stopper);
    readiness.start(
      ROOM,
      client as unknown as MatrixClient,
      fakeTimeline().timeline,
    );
    const pending = readiness.state();
    client.setSync(SyncState.Error);
    expect(client.listeners()).toBe(0);
    expect(readiness.state()).toBe(pending);
  });

  it('re-hides the timeline when its Room arrives while hidden', () => {
    const client = fakeClient();
    const { timeline } = fakeTimeline();
    const readiness = start(client, timeline);
    readiness.setVisible(false);
    client.addRoom(ROOM);
    expect(timeline.setVisible).toHaveBeenCalledWith(false);
    expect(timeline.setVisible.mock.invocationCallOrder[0]).toBeGreaterThan(
      timeline.open.mock.invocationCallOrder[0],
    );
  });

  it('does not count a page cancelled by hide toward the cap', () => {
    const client = fakeClient();
    client.rooms.add(ROOM);
    const { timeline, canLoadOlder, pages } = fakeTimeline();
    canLoadOlder.set(true);
    const readiness = start(client, timeline);
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
});
