import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DayBoundaryService } from './day-boundary.service';

/** Local midnight starting a Y/M/D — timezone-agnostic, unlike a literal epoch. */
function midnight(year: number, monthIndex: number, day: number): number {
  return new Date(year, monthIndex, day).getTime();
}

describe('DayBoundaryService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function make(): DayBoundaryService {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [DayBoundaryService] });
    return TestBed.inject(DayBoundaryService);
  }

  it('publishes the local day it was created in', () => {
    vi.setSystemTime(new Date(2026, 6, 24, 23, 59, 0));

    expect(make().todayStart()).toBe(midnight(2026, 6, 24));
  });

  it('rolls over at local midnight and re-arms for the day after', () => {
    vi.setSystemTime(new Date(2026, 6, 24, 23, 59, 0));
    const svc = make();

    vi.advanceTimersByTime(60_001);
    expect(svc.todayStart()).toBe(midnight(2026, 6, 25));

    // The re-arm is the point: one timer has to keep firing every day, not just once.
    vi.advanceTimersByTime(24 * 60 * 60 * 1000);
    expect(svc.todayStart()).toBe(midnight(2026, 6, 26));
  });

  // A timer armed for a target in the past would fire, re-arm, fire again… pinning a core.
  // Advancing a single millisecond past the rollover must produce exactly one more wake-up.
  it('arms the next timer a full day out, not immediately', () => {
    vi.setSystemTime(new Date(2026, 6, 24, 23, 59, 59, 999));
    const svc = make();

    vi.advanceTimersByTime(1);
    expect(svc.todayStart()).toBe(midnight(2026, 6, 25));

    vi.advanceTimersByTime(60_000);
    expect(svc.todayStart()).toBe(midnight(2026, 6, 25));
    expect(vi.getTimerCount()).toBe(1);
  });

  it('resolves the day from the clock on each fire, so a slept-through wake-up is correct', () => {
    vi.setSystemTime(new Date(2026, 6, 24, 23, 59, 0));
    const svc = make();

    // The machine suspends and comes back three days later: the timer fires once, late, and
    // must report the day it woke up in rather than the one it was armed for.
    vi.setSystemTime(new Date(2026, 6, 27, 9, 0, 0));
    vi.advanceTimersByTime(60_001);

    expect(svc.todayStart()).toBe(midnight(2026, 6, 27));
  });

  // setTimeout deadlines are measured against a monotonic clock that does not advance while
  // a device is suspended, so the midnight timer simply does not fire for a phone asleep at
  // 00:00 — it stays pending for the un-elapsed remainder, which can approach a full day.
  // Without a wake-up re-derive, yesterday's messages keep their "Today" heading all morning.
  it('re-derives the day when the app returns to the foreground', () => {
    vi.setSystemTime(new Date(2026, 6, 24, 23, 0, 0));
    const svc = make();
    expect(svc.todayStart()).toBe(midnight(2026, 6, 24));

    // The device sleeps through midnight: wall-clock time moves, the pending timer does not.
    vi.setSystemTime(new Date(2026, 6, 25, 8, 0, 0));
    expect(svc.todayStart()).toBe(midnight(2026, 6, 24));

    document.dispatchEvent(new Event('visibilitychange'));
    expect(svc.todayStart()).toBe(midnight(2026, 6, 25));
  });

  // Re-arming without clearing would leave the stale timer pending, and every resume would
  // add another — each one later firing with a day that is already published.
  it('does not accumulate timers across repeated resumes', () => {
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    make();
    expect(vi.getTimerCount()).toBe(1);

    for (let i = 0; i < 5; i++) {
      document.dispatchEvent(new Event('visibilitychange'));
    }

    expect(vi.getTimerCount()).toBe(1);
  });

  it('ignores a visibilitychange that hides the app', () => {
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    const svc = make();
    const hidden = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');

    vi.setSystemTime(new Date(2026, 6, 25, 8, 0, 0));
    document.dispatchEvent(new Event('visibilitychange'));

    // Backgrounding is not a wake-up; the day is re-read when the user comes back.
    expect(svc.todayStart()).toBe(midnight(2026, 6, 24));
    hidden.mockRestore();
  });

  it('clears its timer when the injector is destroyed', () => {
    vi.setSystemTime(new Date(2026, 6, 24, 12, 0, 0));
    make();
    expect(vi.getTimerCount()).toBe(1);

    TestBed.resetTestingModule();
    expect(vi.getTimerCount()).toBe(0);
  });
});
