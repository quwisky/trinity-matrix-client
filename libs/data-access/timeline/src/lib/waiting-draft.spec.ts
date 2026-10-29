import { type WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, EMPTY, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MediaPipeline } from '@trinity/data-access/media';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import {
  FakeTimelineEngine,
  fakeEventItem,
} from '../contract/fake-timeline-engine';
import type { EventTimelineItem, SendState } from './timeline-engine';
import { TIMELINE_ENGINE } from './timeline-engine.token';
import { TimelineStores } from './timeline-store';
import { keepWhileWaiting } from './waiting-draft';

const WAITING: SendState = { kind: 'waiting' };
const SENDING: SendState = { kind: 'sending' };
const REFUSED: SendState = { kind: 'failed', recoverable: true };

/** An echo whose states a test pushes, starting from `first`. */
function echo(first: SendState | null = WAITING) {
  const states = new BehaviorSubject<SendState | null>(first);
  return { transactionId: 'txn-1', states, observed: () => states.observed };
}

function drafts() {
  return { holdWaiting: vi.fn(), releaseWaiting: vi.fn() };
}

describe('keepWhileWaiting', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('holds the text of an echo waiting to send under its transaction id', () => {
    const store = drafts();

    expect(keepWhileWaiting(store, 'key', 'hello', echo())).toBe(true);

    expect(store.holdWaiting).toHaveBeenCalledWith('key', 'txn-1', 'hello');
  });

  it('holds nothing for an echo the server refused', () => {
    const store = drafts();
    const refused = echo(REFUSED);

    expect(keepWhileWaiting(store, 'key', 'hello', refused)).toBe(false);
    expect(
      keepWhileWaiting(store, 'key', 'hello', {
        transactionId: 'txn-1',
        states: EMPTY,
      }),
    ).toBe(false);

    expect(store.holdWaiting).not.toHaveBeenCalled();
    expect(refused.observed()).toBe(false);
  });

  it('releases the text once the echo is sent, not while it is being resent', () => {
    const store = drafts();
    const waiting = echo();
    keepWhileWaiting(store, 'key', 'hello', waiting);

    waiting.states.next(SENDING);
    expect(store.releaseWaiting).not.toHaveBeenCalled();
    waiting.states.next(null);

    expect(store.releaseWaiting).toHaveBeenCalledOnce();
    expect(store.releaseWaiting).toHaveBeenCalledWith('key', 'txn-1');
    expect(waiting.observed()).toBe(false);
  });

  it('keeps the text when the echo leaves without being sent, and stops watching', () => {
    const store = drafts();
    const waiting = echo();
    keepWhileWaiting(store, 'key', 'hello', waiting);

    // A cancel releases the text itself; any other way out may leave it unsent.
    waiting.states.complete();

    expect(store.releaseWaiting).not.toHaveBeenCalled();
    expect(waiting.observed()).toBe(false);
  });

  it('keeps the text when the resend fails offline again or is refused', () => {
    const store = drafts();
    const waiting = echo();
    keepWhileWaiting(store, 'key', 'hello', waiting);

    waiting.states.next(SENDING);
    waiting.states.next(WAITING);
    waiting.states.next(SENDING);
    waiting.states.next(REFUSED);

    expect(store.releaseWaiting).not.toHaveBeenCalled();
  });

  it("releases a refused echo's text once a manual retry sends it", () => {
    const store = drafts();
    const waiting = echo();
    keepWhileWaiting(store, 'key', 'hello', waiting);
    waiting.states.next(REFUSED);
    expect(store.releaseWaiting).not.toHaveBeenCalled();

    waiting.states.next(SENDING);
    waiting.states.next(null);

    expect(store.releaseWaiting).toHaveBeenCalledOnce();
  });

  describe('over a TimelineStore', () => {
    const roomId = '!room:example.org';
    let fake: FakeTimelineEngine;
    let session: Subject<SessionSnapshot>;
    let snapshot: WritableSignal<SessionSnapshot>;

    const live = (generation: number | null): SessionSnapshot => ({
      ...EMPTY_SESSION,
      accounts:
        generation === null
          ? []
          : [
              {
                accountId: fake.alice,
                deviceId: 'DEVICE',
                generation,
                syncState: 'syncing',
                serverSynced: true,
                roomsPrepared: true,
                waitingCount: 0,
                cryptoStoreEncrypted: true,
              },
            ],
    });
    const publish = (generation: number | null): void => {
      snapshot.set(live(generation));
      session.next(snapshot());
    };
    const item = (patch: Partial<EventTimelineItem> = {}) =>
      fakeEventItem('$e', fake.alice, {
        uniqueId: 'txn:txn-1',
        eventId: null,
        transactionId: 'txn-1',
        isOwn: true,
        sendState: WAITING,
        ...patch,
      });
    /** An offline echo in an open store, its text held. */
    const held = () => {
      fake.seed(fake.alice, roomId, [fakeEventItem('$a', fake.bob), item()]);
      const timeline = TestBed.inject(TimelineStores).open(
        { accountId: fake.alice, roomId },
        { kind: 'live' },
      );
      const store = drafts();
      expect(
        keepWhileWaiting(store, 'key', 'hello', {
          transactionId: 'txn-1',
          states: timeline.sendStates('txn-1'),
        }),
      ).toBe(true);
      expect(store.holdWaiting).toHaveBeenCalledWith('key', 'txn-1', 'hello');
      return store;
    };

    beforeEach(() => {
      fake = new FakeTimelineEngine();
      session = new Subject<SessionSnapshot>();
      snapshot = signal(live(1));
      TestBed.configureTestingModule({
        providers: [
          { provide: TIMELINE_ENGINE, useValue: fake },
          { provide: SESSION_SNAPSHOT, useValue: snapshot },
          { provide: SESSION_ENGINE, useValue: { session: () => session } },
          { provide: MediaPipeline, useValue: { present: () => ({}) } },
        ],
      });
    });

    it('holds the draft while the echo waits and releases on sent', () => {
      const store = held();

      // Reconnected: resending, then the remote echo, on the same row.
      fake.emitDiffs(fake.alice, roomId, [
        { op: 'set', index: 1, value: item({ sendState: SENDING }) },
      ]);
      expect(store.releaseWaiting).not.toHaveBeenCalled();
      fake.emitDiffs(fake.alice, roomId, [
        {
          op: 'set',
          index: 1,
          value: item({ eventId: '$e', sendState: null }),
        },
      ]);

      expect(store.releaseWaiting).toHaveBeenCalledOnce();
      expect(store.releaseWaiting).toHaveBeenCalledWith('key', 'txn-1');
    });

    it('keeps the draft when a timeline reset drops the echo', () => {
      const store = held();

      fake.seed(fake.alice, roomId, [fakeEventItem('$a', fake.bob)]);

      expect(store.releaseWaiting).not.toHaveBeenCalled();
    });

    it('keeps the draft when a restarted client has no echo', () => {
      const store = held();

      publish(null);
      fake.seed(fake.alice, roomId, [fakeEventItem('$a', fake.bob)]);
      publish(2);

      expect(store.releaseWaiting).not.toHaveBeenCalled();
    });
  });
});
