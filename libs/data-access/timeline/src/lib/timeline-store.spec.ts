import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject, finalize, merge } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPipeline } from '@trinity/data-access/media';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import {
  FakeTimelineEngine,
  fakeEventItem,
} from '../contract/fake-timeline-engine';
import type { EventTimelineItem, TimelineItem } from './timeline-engine';
import { TIMELINE_ENGINE } from './timeline-engine.token';
import { TimelineStores } from './timeline-store';
import { keepWhileWaiting } from './waiting-draft';

const ROOM = '!room:example.org';
const LIVE = { kind: 'live' } as const;
const MARKER: TimelineItem = { kind: 'readMarker', uniqueId: 'read-marker' };

function liveAccount(accountId: string, generation = 1): SessionAccountStatus {
  return {
    accountId,
    generation,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

describe('TimelineStore', () => {
  let fake: FakeTimelineEngine;
  let stores: TimelineStores;
  let alice: string;
  let bob: string;

  const open = () => stores.open({ accountId: alice, roomId: ROOM }, LIVE);
  const ids = (store: ReturnType<typeof open>) =>
    store.messages().map((m) => m.id);

  beforeEach(() => {
    fake = new FakeTimelineEngine();
    alice = fake.alice;
    bob = fake.bob;
    TestBed.configureTestingModule({
      providers: [
        { provide: TIMELINE_ENGINE, useValue: fake },
        {
          provide: SESSION_SNAPSHOT,
          useValue: signal<SessionSnapshot>({
            ...EMPTY_SESSION,
            accounts: [liveAccount(alice)],
          }),
        },
        {
          provide: SESSION_ENGINE,
          useValue: { session: () => new Subject<SessionSnapshot>() },
        },
        { provide: MediaPipeline, useValue: { present: () => ({}) } },
      ],
    });
    stores = TestBed.inject(TimelineStores);
  });

  it('populates in the same turn it opens', () => {
    fake.seed(alice, ROOM, [fakeEventItem('$a', bob)], {
      hasEncryptionStateEvent: true,
    });

    const store = open();

    expect(store.available()).toBe(true);
    expect(store.items().map((i) => i.uniqueId)).toEqual(['ev:$a']);
    expect(ids(store)).toEqual(['$a']);
    expect(store.room()?.hasEncryptionStateEvent).toBe(true);
    expect(store.backPagination()).toBe('idle');
    expect(store.item('$a')?.sender).toBe(bob);
    expect(store.item('$missing')).toBeNull();
  });

  it('keeps unchanged MessageViews by reference', () => {
    const a = fakeEventItem('$a', bob);
    const b = fakeEventItem('$b', bob);
    fake.seed(alice, ROOM, [a, b]);
    const store = open();
    const [viewA, viewB] = store.messages();

    fake.emitDiffs(alice, ROOM, [
      {
        op: 'set',
        index: 1,
        value: fakeEventItem('$b', bob, {
          reactions: [
            { key: '👍', count: 1, reactedByMe: false, senders: [bob] },
          ],
        }),
      },
    ]);

    const [nextA, nextB] = store.messages();
    expect(nextA).toBe(viewA);
    expect(nextB).not.toBe(viewB);
    expect(nextB.reactions.map((r) => r.key)).toEqual(['👍']);
  });

  it('reuses a MessageView for a plainEqual item that is not ===', () => {
    fake.seed(alice, ROOM, [fakeEventItem('$a', bob)]);
    const store = open();
    const [view] = store.messages();

    fake.seed(alice, ROOM, [fakeEventItem('$a', bob)]);

    expect(store.messages()[0]).toBe(view);
  });

  it('folds non-reset diffs', () => {
    fake.seed(alice, ROOM, [fakeEventItem('$b', bob)]);
    const store = open();

    fake.emitDiffs(alice, ROOM, [
      { op: 'pushFront', value: fakeEventItem('$a', bob) },
      { op: 'pushBack', value: fakeEventItem('$c', bob) },
      { op: 'remove', index: 1 },
    ]);

    expect(ids(store)).toEqual(['$a', '$c']);
    expect(store.item('$b')).toBeNull();
  });

  it('firstUnreadId stays on its anchor when the readMarker moves', () => {
    fake.seed(alice, ROOM, [
      fakeEventItem('$read', bob),
      MARKER,
      fakeEventItem('$unread', bob),
      fakeEventItem('$later', bob),
    ]);
    const store = open();
    expect(store.firstUnreadId()).toBe('$unread');

    // Reading the room moves m.fully_read; a new message follows.
    fake.emitDiffs(alice, ROOM, [
      { op: 'remove', index: 1 },
      { op: 'insert', index: 3, value: MARKER },
      { op: 'pushBack', value: fakeEventItem('$new', bob) },
    ]);

    expect(store.firstUnreadId()).toBe('$unread');
  });

  it('firstUnreadId skips own messages and system lines after its anchor', () => {
    fake.seed(alice, ROOM, [
      fakeEventItem('$read', bob),
      MARKER,
      fakeEventItem('$mine', alice, { isOwn: true }),
      fakeEventItem('$renamed', bob, {
        content: {
          kind: 'state',
          change: {
            kind: 'room-name',
            actorId: bob,
            previousName: null,
            name: 'Room',
          },
        },
      }),
      fakeEventItem('$unread', bob),
    ]);

    expect(open().firstUnreadId()).toBe('$unread');
  });

  it('firstUnreadId appears once its anchor is paged in', () => {
    fake.seed(alice, ROOM, [
      fakeEventItem('$unread', bob),
      fakeEventItem('$later', bob),
    ]);
    const store = open();
    expect(store.firstUnreadId()).toBeNull();

    fake.emitDiffs(alice, ROOM, [
      { op: 'pushFront', value: MARKER },
      { op: 'pushFront', value: fakeEventItem('$read', bob) },
    ]);

    expect(store.firstUnreadId()).toBe('$unread');
  });

  it('room-unavailable clears items and available', () => {
    fake.seed(alice, ROOM, [fakeEventItem('$a', bob)]);
    const store = open();

    fake.emit(alice, ROOM, { kind: 'room-unavailable' });

    expect(store.available()).toBe(false);
    expect(store.items()).toEqual([]);
    expect(store.messages()).toEqual([]);
    expect(store.room()).toBeNull();
    expect(store.item('$a')).toBeNull();
  });

  it('presents only the last 100 items while hidden', () => {
    const events = Array.from({ length: 150 }, (_, i) =>
      fakeEventItem(`$e${i}`, bob),
    );
    const items = [...events.slice(0, 120), MARKER, ...events.slice(120)];
    fake.seed(alice, ROOM, items);
    const store = open();
    const visibleViews = store.messages();
    expect(visibleViews).toHaveLength(150);

    store.setVisible(false);

    expect(store.items()).toHaveLength(151);
    expect(ids(store)).toEqual(events.slice(-100).map((i) => i.eventId));
    expect(store.messages()[0]).toBe(visibleViews[50]);

    store.setVisible(true);

    expect(store.messages()).toEqual(visibleViews);
    store.messages().forEach((view, i) => expect(view).toBe(visibleViews[i]));
  });

  it('a feed error clears the store to unavailable', () => {
    const errors$ = new Subject<never>();
    const timeline = fake.timeline.bind(fake);
    fake.timeline = (...args) => merge(timeline(...args), errors$);
    fake.seed(alice, ROOM, [fakeEventItem('$a', bob)]);
    const store = open();
    expect(store.available()).toBe(true);

    errors$.error(new Error('engine failed'));

    expect(store.available()).toBe(false);
    expect(store.items()).toEqual([]);
    expect(store.messages()).toEqual([]);
    expect(store.room()).toBeNull();
  });

  it('re-presents every row when the room gains its encryption state event', () => {
    fake.seed(alice, ROOM, [fakeEventItem('$a', bob)]);
    const store = open();
    const [view] = store.messages();

    fake.seed(alice, ROOM, [fakeEventItem('$a', bob)], {
      hasEncryptionStateEvent: true,
    });

    const [next] = store.messages();
    expect(next).not.toBe(view);
    expect(next.previewEncrypted).toBe(true);
  });

  it('close stops folding and leaves the store empty', () => {
    fake.seed(alice, ROOM, [fakeEventItem('$a', bob)]);
    const store = open();

    store.close();
    fake.seed(alice, ROOM, [fakeEventItem('$b', bob)]);

    expect(store.available()).toBe(false);
    expect(store.items()).toEqual([]);
  });
  it('sendStates emits the current state at once and completes when the item leaves', () => {
    const echo = (patch: Partial<EventTimelineItem>) =>
      fakeEventItem('$sent', alice, {
        uniqueId: 'txn:t1',
        eventId: null,
        transactionId: 't1',
        isOwn: true,
        ...patch,
      });
    fake.seed(alice, ROOM, [echo({ sendState: { kind: 'waiting' } })]);
    const store = open();
    const states: unknown[] = [];
    let completed = false;

    store.sendStates('t1').subscribe({
      next: (state) => states.push(state),
      complete: () => (completed = true),
    });
    expect(states).toEqual([{ kind: 'waiting' }]);

    // An echo with no state and no event id yet is still on its way.
    fake.emitDiffs(alice, ROOM, [
      { op: 'set', index: 0, value: echo({ sendState: null }) },
    ]);
    fake.emitDiffs(alice, ROOM, [
      { op: 'set', index: 0, value: echo({ eventId: '$sent' }) },
    ]);
    expect(states).toEqual([{ kind: 'waiting' }, { kind: 'sending' }, null]);
    expect(completed).toBe(false);

    fake.emitDiffs(alice, ROOM, [{ op: 'remove', index: 0 }]);
    expect(completed).toBe(true);

    let unknownCompleted = false;
    store.sendStates('t2').subscribe({
      next: () => expect.unreachable(),
      complete: () => (unknownCompleted = true),
    });
    expect(unknownCompleted).toBe(true);
  });

  it('ends a send state watch when the store clears, keeping its held draft', () => {
    fake.seed(alice, ROOM, [
      fakeEventItem('$sent', alice, {
        uniqueId: 'txn:t1',
        eventId: null,
        transactionId: 't1',
        isOwn: true,
        sendState: { kind: 'waiting' },
      }),
    ]);
    const store = open();
    const drafts = { holdWaiting: vi.fn(), releaseWaiting: vi.fn() };
    let watching = true;
    keepWhileWaiting(drafts, 'draft', 'hello', {
      transactionId: 't1',
      states: store.sendStates('t1').pipe(finalize(() => (watching = false))),
    });
    expect(drafts.holdWaiting).toHaveBeenCalledOnce();

    fake.emit(alice, ROOM, { kind: 'room-unavailable' });

    expect(watching).toBe(false);
    // The echo left unsent: no proof the text is safe, so it stays held.
    expect(drafts.releaseWaiting).not.toHaveBeenCalled();
  });
});
