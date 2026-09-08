import { ApplicationRef, type WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UnreadAggregatorService } from '@trinity/data-access/room-library';
import {
  HostLifecycleService,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import { Observable, Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BadgeCoordinator } from './badge-coordinator';
import { BADGE_SINK } from './badge-sink';

function setup(
  initial: number,
  write = vi.fn((_count: number): Observable<HostOperationOutcome> =>
    of({ kind: 'completed' }),
  ),
): {
  total: WritableSignal<number>;
  accounts: WritableSignal<ReadonlyMap<string, number>>;
  coordinator: BadgeCoordinator;
  write: typeof write;
  flush: () => void;
  lifecycle: Subject<{ kind: 'active' | 'background' }>;
} {
  const total = signal(initial);
  const accounts = signal<ReadonlyMap<string, number>>(
    new Map([['@me:hs', initial]]),
  );
  const lifecycle = new Subject<{ kind: 'active' | 'background' }>();
  TestBed.configureTestingModule({
    providers: [
      BadgeCoordinator,
      {
        provide: UnreadAggregatorService,
        useValue: { totalUnread: total, unreadByAccount: accounts },
      },
      { provide: HostLifecycleService, useValue: { events: lifecycle } },
      { provide: BADGE_SINK, useValue: { write } },
    ],
  });
  const coordinator = TestBed.inject(BadgeCoordinator);
  const appRef = TestBed.inject(ApplicationRef);
  return {
    total,
    accounts,
    coordinator,
    write,
    lifecycle,
    flush: () => appRef.tick(),
  };
}

describe('BadgeCoordinator', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('writes Room Library aggregate unread state only through BadgeSink', () => {
    const { total, accounts, coordinator, write, flush } = setup(3);
    const lifetime = coordinator.run().subscribe();
    flush();
    expect(write).toHaveBeenLastCalledWith(3);

    accounts.set(new Map([['@me:hs', 7]]));
    total.set(7);
    flush();
    expect(write).toHaveBeenLastCalledWith(7);
    lifetime.unsubscribe();
  });

  it('cancels a stale sink write when a newer total arrives', () => {
    const first = new Subject<HostOperationOutcome>();
    const cancelled = vi.fn();
    const write = vi.fn((count: number): Observable<HostOperationOutcome> =>
      count === 1
        ? new Observable((subscriber) => {
            const subscription = first.subscribe(subscriber);
            return () => {
              cancelled();
              subscription.unsubscribe();
            };
          })
        : of({ kind: 'completed' }),
    );
    const { total, accounts, coordinator, flush } = setup(1, write);
    const lifetime = coordinator.run().subscribe();
    flush();

    accounts.set(new Map([['@me:hs', 2]]));
    total.set(2);
    flush();

    expect(write).toHaveBeenLastCalledWith(2);
    expect(cancelled).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('rewrites the aggregate when a per-account generation changes', () => {
    const { total, accounts, coordinator, write, flush } = setup(5);
    const lifetime = coordinator.run().subscribe();
    flush();
    expect(write).toHaveBeenLastCalledWith(5);

    // A native background snapshot may have written 7 while Matrix still says 5.
    accounts.set(new Map([['@me:hs', 5]]));
    flush();
    expect(write).toHaveBeenLastCalledWith(5);
    expect(total()).toBe(5);
    lifetime.unsubscribe();
  });

  it('restores zero when the last account is removed', () => {
    const { total, accounts, coordinator, write, flush } = setup(5);
    const lifetime = coordinator.run().subscribe();
    flush();
    accounts.set(new Map());
    total.set(0);
    flush();
    expect(write).toHaveBeenLastCalledWith(0);
    lifetime.unsubscribe();
  });

  it('rewrites the current total when the host becomes active', () => {
    const { lifecycle, coordinator, write, flush } = setup(5);
    const lifetime = coordinator.run().subscribe();
    flush();
    write.mockClear();

    lifecycle.next({ kind: 'active' });
    expect(write).toHaveBeenLastCalledWith(5);
    lifetime.unsubscribe();
  });

  it('stops observing host lifecycle events after teardown', () => {
    const { lifecycle, coordinator, write, flush } = setup(5);
    const lifetime = coordinator.run().subscribe();
    flush();
    lifetime.unsubscribe();
    write.mockClear();

    lifecycle.next({ kind: 'active' });
    expect(write).not.toHaveBeenCalled();
  });

  it('rebinds the generation observer after a stop and restart', () => {
    const { total, accounts, coordinator, write, flush } = setup(5);
    const first = coordinator.run().subscribe();
    flush();
    first.unsubscribe();

    accounts.set(new Map([['@me:hs', 2]]));
    total.set(2);
    const second = coordinator.run().subscribe();
    flush();
    expect(write).toHaveBeenLastCalledWith(2);
    second.unsubscribe();
  });

  it('does not track signal reads made by synchronous outcome subscribers', () => {
    const health = signal(0);
    const write = vi.fn((_count: number): Observable<HostOperationOutcome> =>
      of({ kind: 'unavailable', reason: 'not-supported' }),
    );
    const { total, accounts, coordinator, flush } = setup(0, write);
    const lifetime = coordinator.run().subscribe(() => {
      // Host health reads its previous snapshot before publishing a new one.
      // Bound the update so a regression fails without spinning the test runner.
      if (health() === 0) health.set(1);
    });
    flush();
    expect(write).toHaveBeenCalledTimes(1);

    health.set(2);
    flush();
    expect(write).toHaveBeenCalledTimes(1);

    accounts.set(new Map([['@me:hs', 3]]));
    total.set(3);
    flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(3);
    lifetime.unsubscribe();
  });

  it('turns an unexpected sink error into a warning-ready typed outcome', () => {
    const write = vi.fn<(count: number) => Observable<HostOperationOutcome>>(
      () => throwError(() => new Error('adapter defect')),
    );
    const { coordinator, flush } = setup(1, write);
    const outcomes: HostOperationOutcome[] = [];
    const lifetime = coordinator
      .run()
      .subscribe((value) => outcomes.push(value));
    flush();

    expect(outcomes).toEqual([
      {
        kind: 'rejected',
        diagnostic: { code: 'badge-sink-failed' },
      },
    ]);
    expect(lifetime.closed).toBe(false);
    lifetime.unsubscribe();
  });
});
