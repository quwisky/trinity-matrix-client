import { describe, expect, it, vi } from 'vitest';
import {
  dayLabel,
  hasUsableTimestamp,
  startOfLocalDay,
  startOfNextLocalDay,
} from './day-separator';

/**
 * Local noon on a Y/M/D. Every instant in these tests is built with the local-time `Date`
 * constructor rather than a literal epoch, so the assertions hold in UTC, in a whole-hour
 * zone like America/Los_Angeles, and in the half/quarter-hour ones (Asia/Kolkata +05:30,
 * Pacific/Chatham +12:45) that catch offset bugs a UTC-only test never sees. Noon, so no
 * offset can slide the instant into an adjacent calendar day.
 */
function noon(year: number, monthIndex: number, day: number): number {
  return new Date(year, monthIndex, day, 12).getTime();
}

/** Local midnight starting a Y/M/D — the value `startOfLocalDay` is expected to produce. */
function midnight(year: number, monthIndex: number, day: number): number {
  return new Date(year, monthIndex, day).getTime();
}

describe('startOfLocalDay', () => {
  it('returns the local midnight that starts the day', () => {
    expect(startOfLocalDay(noon(2026, 6, 23))).toBe(midnight(2026, 6, 23));
  });

  it('buckets both edges of a day to the same start', () => {
    const first = new Date(2026, 6, 23, 0, 0, 0, 0).getTime();
    const last = new Date(2026, 6, 23, 23, 59, 59, 999).getTime();

    expect(startOfLocalDay(first)).toBe(midnight(2026, 6, 23));
    expect(startOfLocalDay(last)).toBe(midnight(2026, 6, 23));
  });

  it('is already-normalised for a midnight input', () => {
    expect(startOfLocalDay(midnight(2026, 6, 23))).toBe(midnight(2026, 6, 23));
  });
});

describe('startOfNextLocalDay', () => {
  it('returns tomorrow’s local midnight', () => {
    expect(startOfNextLocalDay(noon(2026, 6, 23))).toBe(midnight(2026, 6, 24));
  });

  it('rolls over a month and a year end', () => {
    expect(startOfNextLocalDay(noon(2026, 6, 31))).toBe(midnight(2026, 7, 1));
    expect(startOfNextLocalDay(noon(2026, 11, 31))).toBe(midnight(2027, 0, 1));
  });

  // The whole-year sweep walks both DST transitions of whatever zone the runner sits in.
  // The strictly-future assertion is the one that matters: a 25-hour fall-back day makes
  // `midnight + 24h` normalise back to the midnight it started from, and a caller sleeping
  // until "the next midnight" would then wake instantly and re-arm in a tight loop.
  it('is always strictly in the future and always the next day’s start', () => {
    for (let dayOfYear = 1; dayOfYear <= 365; dayOfYear++) {
      const today = noon(2026, 0, dayOfYear);
      const next = startOfNextLocalDay(today);

      expect(next).toBeGreaterThan(today);
      expect(next).toBe(startOfLocalDay(noon(2026, 0, dayOfYear + 1)));
    }
  });
});

describe('hasUsableTimestamp', () => {
  // safeBuildMessageView degrades an unreadable origin_server_ts to 0. Bucketing that would
  // mint a "1 January 1970" separator, so it has to be rejected along with the other
  // impossible clocks. The high end matters just as much: origin_server_ts is a raw
  // federated number, and a bridge that reports microseconds or nanoseconds is a routine
  // bug rather than an attack.
  it.each([
    ['the unsupported-event fallback', 0],
    ['a negative time', -1],
    ['an implausibly small integer', 1000],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a microsecond-scale clock', 1_784_921_449_986_000],
    ['a nanosecond-scale clock', 1.78e18],
    ['past the representable Date range', 8_640_000_000_000_001],
  ])('rejects %s', (_label, ts) => {
    expect(hasUsableTimestamp(ts)).toBe(false);
  });

  it('accepts a real event time', () => {
    expect(hasUsableTimestamp(Date.now())).toBe(true);
    expect(hasUsableTimestamp(noon(2026, 6, 23))).toBe(true);
  });

  // Bridges backfill imported history at its original time (the appservice `?ts=` parameter),
  // so a room carrying an IRC or mailing-list archive holds genuinely decades-old events. A
  // floor set at Matrix's own launch would classify all of them as "no clock" and silently
  // drop every separator in that room.
  it('accepts a bridged archive predating Matrix', () => {
    expect(hasUsableTimestamp(noon(1995, 5, 12))).toBe(true);
    expect(hasUsableTimestamp(noon(2009, 0, 3))).toBe(true);
  });

  // The bounds exist to keep dayLabel total. A finite timestamp past the Date range makes
  // startOfLocalDay return NaN, NaN compares equal to nothing so both label branches fall
  // through, and Intl.format(NaN) throws — inside the rows computed, which blanks the entire
  // timeline rather than mislabelling one row.
  it('never accepts a timestamp dayLabel cannot format', () => {
    const today = startOfLocalDay(noon(2026, 6, 24));
    const candidates = [
      0,
      -1,
      1,
      1000,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      Number.MAX_SAFE_INTEGER,
      1_784_921_449_986_000,
      1.78e18,
      8_640_000_000_000_000,
      8_640_000_000_000_001,
      noon(1995, 5, 12),
      noon(2026, 6, 24),
      Date.now(),
    ];

    for (const ts of candidates) {
      if (!hasUsableTimestamp(ts)) {
        continue;
      }
      expect(Number.isNaN(startOfLocalDay(ts))).toBe(false);
      expect(() => dayLabel(startOfLocalDay(ts), today)).not.toThrow();
    }
  });
});

describe('dayLabel', () => {
  const today = startOfLocalDay(noon(2026, 6, 24));

  it('labels the current day "Today"', () => {
    expect(dayLabel(today, today)).toBe('Today');
  });

  it('labels the previous day "Yesterday"', () => {
    expect(dayLabel(startOfLocalDay(noon(2026, 6, 23)), today)).toBe(
      'Yesterday',
    );
  });

  // 1 January is "Yesterday" from 2 January, but it is also the first day of the year — the
  // case where any arithmetic that goes via the year number falls over.
  it('crosses a new year boundary', () => {
    const newYearsDay = startOfLocalDay(noon(2027, 0, 1));
    const newYearsEve = startOfLocalDay(noon(2026, 11, 31));

    expect(newYearsEve).not.toBe(newYearsDay);
    expect(dayLabel(newYearsEve, newYearsDay)).toBe('Yesterday');
  });

  // Asserted against the same Intl call rather than a hardcoded string: the label follows the
  // reader's browser locale, so a literal would only pass on an en-US runner.
  it('formats an older day in the current year without the year', () => {
    const older = startOfLocalDay(noon(2026, 6, 20));
    const expected = new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(older);

    expect(dayLabel(older, today)).toBe(expected);
    expect(dayLabel(older, today)).not.toContain('2026');
  });

  it('includes the year for a day in an earlier year', () => {
    const lastYear = startOfLocalDay(noon(2024, 2, 5));

    // Every locale renders `year: 'numeric'` as the four digits, whatever else it reorders.
    expect(dayLabel(lastYear, today)).toContain('2024');
  });

  it('never says "Today" or "Yesterday" for anything older', () => {
    for (let daysBack = 2; daysBack <= 10; daysBack++) {
      const label = dayLabel(
        startOfLocalDay(noon(2026, 6, 24 - daysBack)),
        today,
      );
      expect(label).not.toBe('Today');
      expect(label).not.toBe('Yesterday');
    }
  });

  // Sweeping a whole year of consecutive pairs walks through both DST transitions of
  // whatever zone the runner sits in, without pinning TZ. This is what pins the
  // `startOfLocalDay(todayStart - 1)` implementation: subtracting a fixed 24h instead
  // returns a date rather than "Yesterday" on the day after a spring-forward, and passes
  // the other 363 days a year.
  it('says "Yesterday" for every consecutive pair across a full year', () => {
    for (let dayOfYear = 1; dayOfYear <= 365; dayOfYear++) {
      const previous = startOfLocalDay(noon(2026, 0, dayOfYear));
      const current = startOfLocalDay(noon(2026, 0, dayOfYear + 1));
      expect(dayLabel(previous, current)).toBe('Yesterday');
    }
  });

  // Clock skew and hostile origin_server_ts both produce future events. Showing the literal
  // date is the honest answer; what matters is that it is not mislabelled "Today".
  it('shows a future day as a date', () => {
    expect(dayLabel(startOfLocalDay(noon(2026, 6, 25)), today)).not.toBe(
      'Today',
    );
  });

  // An Intl.DateTimeFormat resolves the time zone once, at construction, and never again —
  // but startOfLocalDay goes through Date, which does re-resolve. Cached forever, the two
  // drift apart when the OS zone moves under a long-lived session and the separator renders
  // a date that disagrees with the messages under it.
  it('rebuilds its formatters when the local UTC offset moves', () => {
    const older = startOfLocalDay(noon(2026, 6, 20));
    dayLabel(older, today); // warm the cache at the runner's real offset

    const construct = vi.spyOn(Intl, 'DateTimeFormat');
    try {
      dayLabel(older, today);
      expect(construct).not.toHaveBeenCalled(); // still cached — the point of the cache

      const real = new Date().getTimezoneOffset();
      const moved = vi
        .spyOn(Date.prototype, 'getTimezoneOffset')
        .mockReturnValue(real + 60);
      dayLabel(older, today);
      expect(construct).toHaveBeenCalled();

      // …and settles again once the new offset is the steady state.
      construct.mockClear();
      dayLabel(older, today);
      expect(construct).not.toHaveBeenCalled();
      moved.mockRestore();
    } finally {
      construct.mockRestore();
    }
  });
});
