import {
  ApplicationRef,
  ErrorHandler,
  WritableSignal,
  signal,
} from '@angular/core';
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
  set: typeof set;
  handleError: ReturnType<typeof vi.fn>;
  flush: () => void;
} {
  const total = signal(initial);
  const handleError = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      AppBadgeService,
      { provide: UnreadAggregatorService, useValue: { totalUnread: total } },
      { provide: HostBadgeService, useValue: { set } },
      { provide: ErrorHandler, useValue: { handleError } },
    ],
  });
  TestBed.inject(AppBadgeService);
  const appRef = TestBed.inject(ApplicationRef);
  return { total, set, handleError, flush: () => appRef.tick() };
}

describe('AppBadgeService', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('delegates unread totals to the host operation without platform branching', () => {
    const { total, set, flush } = setup(3);
    flush();
    expect(set).toHaveBeenLastCalledWith(3);

    total.set(7);
    flush();
    expect(set).toHaveBeenLastCalledWith(7);
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
    const { total, flush } = setup(1, set);
    flush();

    total.set(2);
    flush();

    expect(set).toHaveBeenLastCalledWith(2);
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('reports a broken adapter without killing future badge updates', () => {
    const defect = new Error('adapter defect');
    const set = vi
      .fn<(count: number) => Observable<HostOperationOutcome>>()
      .mockReturnValueOnce(throwError(() => defect))
      .mockReturnValue(of({ kind: 'completed' }));
    const { total, handleError, flush } = setup(1, set);
    flush();

    expect(handleError).toHaveBeenCalledWith(defect);
    total.set(2);
    flush();
    expect(set).toHaveBeenLastCalledWith(2);
  });
});
