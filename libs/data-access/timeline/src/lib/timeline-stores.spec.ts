import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject, finalize, tap } from 'rxjs';
import { describe, expect, it } from 'vitest';
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
import { TIMELINE_ENGINE } from './timeline-engine.token';
import { TimelineStores } from './timeline-store';

const ROOM = '!room:example.org';

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

describe('TimelineStores', () => {
  it('resubscribes on a new generation and closes when the account leaves', () => {
    const fake = new FakeTimelineEngine();
    const alice = fake.alice;
    let open = 0;
    let subscribes = 0;
    const timeline = fake.timeline.bind(fake);
    fake.timeline = (...args) =>
      timeline(...args).pipe(
        tap({
          subscribe: () => {
            open += 1;
            subscribes += 1;
          },
        }),
        finalize(() => (open -= 1)),
      );
    const snapshot = signal<SessionSnapshot>({
      ...EMPTY_SESSION,
      accounts: [liveAccount(alice)],
    });
    const session$ = new Subject<SessionSnapshot>();
    const publish = (accounts: SessionSnapshot['accounts']) => {
      snapshot.set({ ...EMPTY_SESSION, accounts });
      session$.next(snapshot());
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: TIMELINE_ENGINE, useValue: fake },
        { provide: SESSION_SNAPSHOT, useValue: snapshot },
        { provide: SESSION_ENGINE, useValue: { session: () => session$ } },
        { provide: MediaPipeline, useValue: { present: () => ({}) } },
      ],
    });
    fake.seed(alice, ROOM, [fakeEventItem('$a', fake.bob)]);
    const store = TestBed.inject(TimelineStores).open(
      { accountId: alice, roomId: ROOM },
      { kind: 'live' },
    );
    expect([open, subscribes]).toEqual([1, 1]);

    publish([liveAccount(alice, 1)]);
    expect([open, subscribes]).toEqual([1, 1]);

    publish([liveAccount(alice, 2)]);

    // The first subscription closed and a second one opened.
    expect([open, subscribes]).toEqual([1, 2]);
    expect(store.available()).toBe(true);
    fake.seed(alice, ROOM, [fakeEventItem('$b', fake.bob)]);
    expect(store.item('$b')).not.toBeNull();

    publish([]);

    expect(open).toBe(0);
    expect(store.available()).toBe(false);
    expect(store.items()).toEqual([]);

    publish([liveAccount(alice, 3)]);

    expect([open, subscribes]).toEqual([1, 3]);
    expect(store.item('$b')).not.toBeNull();

    store.close();
    publish([liveAccount(alice, 4)]);

    expect(open).toBe(0);
  });
});
