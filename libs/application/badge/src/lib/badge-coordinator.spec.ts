import { ApplicationRef, type WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UnreadAggregatorService } from '@trinity/data-access/room-library';
import type { HostOperationOutcome } from '@trinity/runtime/host';
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
  coordinator: BadgeCoordinator;
  write: typeof write;
  flush: () => void;
} {
  const total = signal(initial);
  TestBed.configureTestingModule({
    providers: [
      BadgeCoordinator,
      { provide: UnreadAggregatorService, useValue: { totalUnread: total } },
      { provide: BADGE_SINK, useValue: { write } },
    ],
  });
  const coordinator = TestBed.inject(BadgeCoordinator);
  const appRef = TestBed.inject(ApplicationRef);
  return { total, coordinator, write, flush: () => appRef.tick() };
}

describe('BadgeCoordinator', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('writes Room Library aggregate unread state only through BadgeSink', () => {
    const { total, coordinator, write, flush } = setup(3);
    const lifetime = coordinator.run().subscribe();
    flush();
    expect(write).toHaveBeenLastCalledWith(3);

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
    const { total, coordinator, flush } = setup(1, write);
    const lifetime = coordinator.run().subscribe();
    flush();

    total.set(2);
    flush();

    expect(write).toHaveBeenLastCalledWith(2);
    expect(cancelled).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('does not track signal reads made by synchronous outcome subscribers', () => {
    const health = signal(0);
    const write = vi.fn((_count: number): Observable<HostOperationOutcome> =>
      of({ kind: 'unavailable', reason: 'not-supported' }),
    );
    const { total, coordinator, flush } = setup(0, write);
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
