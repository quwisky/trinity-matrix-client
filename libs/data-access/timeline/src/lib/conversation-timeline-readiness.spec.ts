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
    const client = fakeClient();
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
    expect(readiness.state()).toEqual({ kind: 'ready' });
    expect(client.listeners()).toBe(0);
  });

  it('fails a pending Room after the next completed sync still lacks it', () => {
    const client = fakeClient();
    const readiness = start(client, fakeTimeline().timeline);
    client.setSync(SyncState.Syncing);
    expect(readiness.state()).toEqual({
      kind: 'error',
      reason: 'room-unavailable',
    });
    expect(client.listeners()).toBe(0);
  });

  it('fails with sync-stopped when sync stops or errors while waiting', () => {
    for (const state of [SyncState.Stopped, SyncState.Error]) {
      const client = fakeClient();
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
    const client = fakeClient();
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

  it('fails sync-stopped immediately when sync is already stopped or errored', () => {
    for (const [state, hasRoom] of [
      [SyncState.Stopped, false],
      [SyncState.Error, true],
    ] as const) {
      const client = fakeClient(state);
      if (hasRoom) client.rooms.add(ROOM);
      const readiness = start(client, fakeTimeline().timeline);
      expect(readiness.state()).toEqual({
        kind: 'error',
        reason: 'sync-stopped',
      });
      expect(client.listeners()).toBe(0);
    }
  });
});
