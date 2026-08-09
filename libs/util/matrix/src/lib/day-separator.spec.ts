import { describe, expect, it } from 'vitest';
import {
  dayLabel,
  hasUsableTimestamp,
  isoDateOf,
  localDayStartFromIso,
  startOfLocalDay,
  startOfNextLocalDay,
} from './day-separator';
import { type DateTimePrefs } from './date-format';

/**
 * "Match system" on both axes with the locale pinned, so these tests assert the day-bucketing
 * logic rather than the runner's locale. The formatting itself is date-format.spec.ts's job.
 */
const SYSTEM: DateTimePrefs = {
  locales: ['en-US'],
  time: 'system',
  date: 'system',
};

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
      expect(() => dayLabel(startOfLocalDay(ts), today, SYSTEM)).not.toThrow();
    }
  });
});

describe('dayLabel', () => {
  const today = startOfLocalDay(noon(2026, 6, 24));

  it('labels the current day "Today"', () => {
    expect(dayLabel(today, today, SYSTEM)).toBe('Today');
  });

  it('labels the previous day "Yesterday"', () => {
    expect(dayLabel(startOfLocalDay(noon(2026, 6, 23)), today, SYSTEM)).toBe(
      'Yesterday',
    );
  });

  // 1 January is "Yesterday" from 2 January, but it is also the first day of the year — the
  // case where any arithmetic that goes via the year number falls over.
  it('crosses a new year boundary', () => {
    const newYearsDay = startOfLocalDay(noon(2027, 0, 1));
    const newYearsEve = startOfLocalDay(noon(2026, 11, 31));

    expect(newYearsEve).not.toBe(newYearsDay);
    expect(dayLabel(newYearsEve, newYearsDay, SYSTEM)).toBe('Yesterday');
  });

  // Asserted against the same Intl call rather than a hardcoded string, so this survives an
  // ICU update reordering the parts.
  it('formats an older day in the current year without the year', () => {
    const older = startOfLocalDay(noon(2026, 6, 20));
    const expected = new Intl.DateTimeFormat(SYSTEM.locales, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(older);

    expect(dayLabel(older, today, SYSTEM)).toBe(expected);
    expect(dayLabel(older, today, SYSTEM)).not.toContain('2026');
  });

  it('includes the year for a day in an earlier year', () => {
    const lastYear = startOfLocalDay(noon(2024, 2, 5));

    // Every locale renders `year: 'numeric'` as the four digits, whatever else it reorders.
    expect(dayLabel(lastYear, today, SYSTEM)).toContain('2024');
  });

  // #22: the date preference governs separators too, so the setting does not half-apply. An
  // explicit order always carries its year, so a same-year and an older day render alike.
  it.each([
    ['dmy' as const, '20/07/2026'],
    ['mdy' as const, '07/20/2026'],
    ['iso' as const, '2026-07-20'],
  ])(
    'renders an older day as %s under an explicit date order',
    (date, expected) => {
      const older = startOfLocalDay(noon(2026, 6, 20));

      expect(dayLabel(older, today, { ...SYSTEM, date })).toBe(expected);
    },
  );

  // The prose labels are not timestamps — no format preference touches them. Translating them
  // is the i18n work's job, not this one's.
  it.each([['dmy' as const], ['mdy' as const], ['iso' as const]])(
    'keeps Today and Yesterday under %s',
    (date) => {
      const prefs = { ...SYSTEM, date };

      expect(dayLabel(today, today, prefs)).toBe('Today');
      expect(dayLabel(startOfLocalDay(noon(2026, 6, 23)), today, prefs)).toBe(
        'Yesterday',
      );
    },
  );

  it('never says "Today" or "Yesterday" for anything older', () => {
    for (let daysBack = 2; daysBack <= 10; daysBack++) {
      const label = dayLabel(
        startOfLocalDay(noon(2026, 6, 24 - daysBack)),
        today,
        SYSTEM,
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
      expect(dayLabel(previous, current, SYSTEM)).toBe('Yesterday');
    }
  });

  // Clock skew and hostile origin_server_ts both produce future events. Showing the literal
  // date is the honest answer; what matters is that it is not mislabelled "Today".
  it('shows a future day as a date', () => {
    expect(
      dayLabel(startOfLocalDay(noon(2026, 6, 25)), today, SYSTEM),
    ).not.toBe('Today');
  });
});

describe('localDayStartFromIso', () => {
  it('returns LOCAL midnight, not the UTC instant', () => {
    const ms = localDayStartFromIso('2026-08-03');

    const local = new Date(ms!);
    expect(local.getFullYear()).toBe(2026);
    expect(local.getMonth()).toBe(7); // August
    expect(local.getDate()).toBe(3);
    expect(local.getHours()).toBe(0);
    expect(local.getMinutes()).toBe(0);
  });

  it('lands on the right calendar day WEST of Greenwich', () => {
    // The assertion above cannot catch the real bug on its own, and finding that out is
    // why this exists. `new Date('2026-08-03')` parses as UTC; a following
    // setHours(0,0,0,0) then repairs it in any POSITIVE-offset zone, because UTC midnight
    // is still the same local calendar day there. West of Greenwich it is the previous
    // evening, so normalising gives midnight of the WRONG day — and the whole jump lands
    // a day early for the Americas while passing for everyone who wrote or reviewed it in
    // Europe. Pinned with an explicit zone so the result does not depend on the machine.
    const original = process.env['TZ'];
    try {
      process.env['TZ'] = 'America/New_York';
      const local = new Date(localDayStartFromIso('2026-08-03')!);
      expect(local.getDate()).toBe(3);
      expect(local.getHours()).toBe(0);
    } finally {
      // DELETE when it was unset. `process.env.TZ = undefined` stores the STRING
      // "undefined", which ICU cannot resolve and silently falls back to UTC — leaving
      // every later test in this file running in a different zone than it thinks.
      if (original === undefined) {
        delete process.env['TZ'];
      } else {
        process.env['TZ'] = original;
      }
    }
  });

  it('round-trips with isoDateOf', () => {
    expect(isoDateOf(localDayStartFromIso('2026-02-28')!)).toBe('2026-02-28');
    expect(isoDateOf(localDayStartFromIso('2024-02-29')!)).toBe('2024-02-29');
  });

  it('agrees with startOfLocalDay for a timestamp on that day', () => {
    const noon = new Date(2026, 7, 3, 12, 34, 56).getTime();
    expect(localDayStartFromIso('2026-08-03')).toBe(startOfLocalDay(noon));
  });

  it('rejects a date that is not real, including one that would roll over', () => {
    // `new Date(2026, 1, 30)` is 2 March — it does not throw, so without the check a user
    // asking for 30 February would silently be sent to a different day.
    expect(localDayStartFromIso('2026-02-30')).toBeNull();
    expect(localDayStartFromIso('2026-13-01')).toBeNull();
    expect(localDayStartFromIso('2025-02-29')).toBeNull(); // not a leap year
  });

  it('rejects anything that is not YYYY-MM-DD', () => {
    for (const bad of ['', '2026-8-3', '03/08/2026', 'yesterday', '2026-08']) {
      expect(localDayStartFromIso(bad), bad).toBeNull();
    }
  });
});
