import { TestBed } from '@angular/core/testing';
import { ErrorHandler, computed, signal } from '@angular/core';
import {
  Subject,
  type Subscription,
  finalize,
  firstValueFrom,
  map,
  merge,
  tap,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EMPTY_SESSION,
  SESSION_ENGINE,
  SESSION_SNAPSHOT,
  type SessionAccountStatus,
  type SessionEngine,
  type SessionSnapshot,
} from '@trinity/data-access/matrix-client';
import { FakeNotificationEngine } from '../contract/fake-notification-engine';
import { NOTIFICATION_ENGINE } from './notification-engine.token';
import { NotificationSettingsStore } from './notification-settings.store';

const UNLOADED = {
  loaded: false,
  defaultRules: [],
  keywords: [],
  roomModes: {},
  sound: true,
  reactionNotifications: false,
};

function account(accountId: string, generation = 1): SessionAccountStatus {
  return {
    accountId,
    deviceId: 'DEVICE',
    generation,
    syncState: 'syncing',
    serverSynced: true,
    roomsPrepared: true,
    waitingCount: 0,
    cryptoStoreEncrypted: true,
  };
}

describe('NotificationSettingsStore', () => {
  let fake: FakeNotificationEngine;
  let snapshot: ReturnType<typeof signal<SessionSnapshot>>;
  let session$: Subject<SessionSnapshot>;
  let store: NotificationSettingsStore;
  let alice: string;
  let open: number;
  let running: Subscription | undefined;
  let faults: Subject<void>;
  let handleError: ReturnType<typeof vi.fn>;

  // Moves only the snapshot signal; the engine's session() stream may emit later.
  const goLive = (...accounts: SessionAccountStatus[]) =>
    snapshot.set({ ...EMPTY_SESSION, accounts });
  const publish = () => session$.next(snapshot());
  const run = () => (running = store.run().subscribe());

  beforeEach(() => {
    fake = new FakeNotificationEngine();
    alice = fake.alice;
    open = 0;
    faults = new Subject();
    handleError = vi.fn();
    const settings = fake.settings.bind(fake);
    fake.settings = (accountId) =>
      merge(
        settings(accountId),
        faults.pipe(
          map((): never => {
            throw new Error(`engine fault for ${accountId}`);
          }),
        ),
      ).pipe(
        tap({ subscribe: () => (open += 1) }),
        finalize(() => (open -= 1)),
      );
    snapshot = signal(EMPTY_SESSION);
    session$ = new Subject();
    const sessionEngine: Pick<SessionEngine, 'session'> = {
      session: () => session$,
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: NOTIFICATION_ENGINE, useValue: fake },
        { provide: SESSION_SNAPSHOT, useValue: snapshot },
        { provide: SESSION_ENGINE, useValue: sessionEngine },
        { provide: ErrorHandler, useValue: { handleError } },
      ],
    });
    store = TestBed.inject(NotificationSettingsStore);
  });

  afterEach(() => running?.unsubscribe());

  it('returns the settings in the same turn the account goes live', () => {
    run();
    const view = computed(() => store.settings(alice));
    expect(view()).toEqual(UNLOADED);

    goLive(account(alice));

    expect(view().loaded).toBe(true);
    expect(store.settings(alice).defaultRules).toContainEqual({
      ruleId: '.m.rule.master',
      kind: 'override',
      enabled: false,
    });
  });

  it('follows changes reactively, holding a command reply already', async () => {
    run();
    goLive(account(alice));
    const keywords = computed(() => store.settings(alice).keywords);
    expect(keywords()).toEqual([]);

    await firstValueFrom(fake.setKeyword(alice, 'cat'));

    expect(keywords()).toEqual([{ pattern: 'cat', enabled: true }]);
  });

  it('subscribes once per account, again for a new generation, and closes on sign-out', () => {
    run();
    goLive(account(alice));
    store.settings(alice);
    store.settings(alice);
    expect(open).toBe(1);

    goLive(account(alice, 2));
    publish();
    expect(open).toBe(1);
    expect(store.settings(alice).loaded).toBe(true);

    goLive();
    publish();
    expect(open).toBe(0);
    expect(store.settings(alice)).toEqual(UNLOADED);
  });

  it('closes the feed of an account that leaves and keeps the other one following', async () => {
    const bob = '@bob:fake';
    run();
    goLive(account(alice), account(bob));
    const keywords = computed(() => store.settings(alice).keywords);
    expect(keywords()).toEqual([]);
    expect(open).toBe(2);

    goLive(account(alice));
    publish();
    expect(open).toBe(1);
    await firstValueFrom(fake.setKeyword(alice, 'cat'));

    expect(keywords()).toEqual([{ pattern: 'cat', enabled: true }]);
    expect(store.settings(bob)).toEqual(UNLOADED);
  });

  it('reports an engine fault and drops the stale settings', () => {
    run();
    goLive(account(alice));
    const loaded = computed(() => store.settings(alice).loaded);
    expect(loaded()).toBe(true);

    faults.next();

    expect(handleError).toHaveBeenCalledExactlyOnceWith(
      new Error(`engine fault for ${alice}`),
    );
    expect(open).toBe(0);
    expect(loaded()).toBe(false);
  });

  it('subscribes for a live account without being read', () => {
    run();
    goLive(account(alice));
    expect(open).toBe(0);

    publish();

    expect(open).toBe(1);
  });

  it('holds nothing while not running, and closes every subscription when stopped', () => {
    goLive(account(alice));
    publish();
    expect(store.settings(alice)).toEqual(UNLOADED);
    expect(open).toBe(0);

    run();
    expect(store.settings(alice).loaded).toBe(true);
    running?.unsubscribe();

    expect(open).toBe(0);
    expect(store.settings(alice)).toEqual(UNLOADED);
  });
});
