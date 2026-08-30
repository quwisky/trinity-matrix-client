import { ApplicationRef, WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { UnreadAggregatorService } from '@trinity/data-access/rooms';
import {
  HostBadgeService,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import { Observable, Subject, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppBadgeService } from './app-badge.service';

function setup(
  initial: number,
  set = vi.fn((_count: number): Observable<HostOperationOutcome> =>
    of({ kind: 'completed' }),
  ),
): {
  total: WritableSignal<number>;
  service: AppBadgeService;
  set: typeof set;
  flush: () => void;
} {
  const total = signal(initial);
  TestBed.configureTestingModule({
    providers: [
      AppBadgeService,
      { provide: UnreadAggregatorService, useValue: { totalUnread: total } },
      { provide: HostBadgeService, useValue: { set } },
    ],
  });
  const service = TestBed.inject(AppBadgeService);
  const appRef = TestBed.inject(ApplicationRef);
  return { total, service, set, flush: () => appRef.tick() };
}

describe('AppBadgeService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('delegates unread totals to the host operation without platform branching', () => {
    const { total, service, set, flush } = setup(3);
    const lifetime = service.run().subscribe();
    flush();
    expect(set).toHaveBeenLastCalledWith(3);

    total.set(7);
    flush();
    expect(set).toHaveBeenLastCalledWith(7);
    lifetime.unsubscribe();
  });

  it('cancels a stale host write when a newer total arrives', () => {
    const first = new Subject<HostOperationOutcome>();
    const cancelled = vi.fn();
    const set = vi.fn((count: number): Observable<HostOperationOutcome> =>
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
    const { total, service, flush } = setup(1, set);
    const lifetime = service.run().subscribe();
    flush();

    total.set(2);
    flush();

    expect(set).toHaveBeenLastCalledWith(2);
    expect(cancelled).toHaveBeenCalledOnce();
    lifetime.unsubscribe();
  });

  it('reports a broken adapter through the owned session error channel', () => {
    const defect = new Error('adapter defect');
    const set = vi.fn<(count: number) => Observable<HostOperationOutcome>>(() =>
      throwError(() => defect),
    );
    const { service, flush } = setup(1, set);
    const error = vi.fn();
    service.run().subscribe({ error });
    flush();

    expect(error).toHaveBeenCalledWith(defect);
  });
});
