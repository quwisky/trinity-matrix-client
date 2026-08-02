import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DATE_FORMAT,
  DEFAULT_TIME_FORMAT,
  formatClockTime,
  formatDateOnly,
  formatDaySeparator,
  formatDateTime,
  isDateFormat,
  isTimeFormat,
  type DateFormat,
  type DateTimePrefs,
  type TimeFormat,
} from './date-format';

/**
 * Local wall-clock instant. Every timestamp here is built with the local-time `Date`
 * constructor rather than a literal epoch, so the assertions hold in any zone — including the
 * half/quarter-hour ones (Asia/Kolkata +05:30, Pacific/Chatham +12:45) that catch offset bugs a
 * UTC-only test never sees.
 */
function at(
  year: number,
  monthIndex: number,
  day: number,
  hour = 12,
  minute = 0,
  second = 0,
): number {
  return new Date(year, monthIndex, day, hour, minute, second).getTime();
}

/** Locales are pinned per-case so nothing depends on the runner's own locale. */
function prefs(
  time: TimeFormat,
  date: DateFormat,
  locales: readonly string[] | undefined = ['en-US'],
): DateTimePrefs {
  return { locales, time, date };
}

describe('formatClockTime', () => {
  // The reason the implementation uses hourCycle:'h23' rather than hour12:false — the latter
  // selects the h24 cycle in several locales, rendering midnight as "24:00".
  it('renders midnight as 00:30, never 24:30, in every locale under 24-hour', () => {
    const midnight = at(2026, 6, 24, 0, 30);

    for (const locale of ['en-US', 'de-DE', 'ja-JP', 'en-GB', 'fr-FR']) {
      const rendered = formatClockTime(
        midnight,
        prefs('h24', 'system', [locale]),
      );
      expect(rendered, locale).toBe('00:30');
    }
  });

  // Someone who asked for a 24-hour clock means HH:mm. `hour: 'numeric'` would hand them
  // "9:05" in every locale except en-US, which is not what the setting promises.
  it('zero-pads the hour under 24-hour but not under 12-hour', () => {
    const morning = at(2026, 6, 24, 9, 5);

    for (const locale of ['en-US', 'de-DE', 'ja-JP', 'fr-FR']) {
      expect(
        formatClockTime(morning, prefs('h24', 'system', [locale])),
        locale,
      ).toBe('09:05');
    }
    expect(formatClockTime(morning, prefs('h12', 'system', ['en-US']))).toBe(
      '9:05 AM',
    );
  });

  it('renders afternoon as 15 under 24-hour and 3 under 12-hour', () => {
    const afternoon = at(2026, 6, 24, 15, 45);

    expect(formatClockTime(afternoon, prefs('h24', 'system'))).toBe('15:45');
    const twelve = formatClockTime(afternoon, prefs('h12', 'system'));
    expect(twelve).toContain('3:45');
    expect(twelve).not.toContain('15');
  });

  it('lets the locale choose the cycle under Match system', () => {
    const afternoon = at(2026, 6, 24, 15, 45);

    // en-US is a 12-hour locale, de-DE a 24-hour one — the point of "Match system".
    expect(
      formatClockTime(afternoon, prefs('system', 'system', ['en-US'])),
    ).toContain('3:45');
    expect(
      formatClockTime(afternoon, prefs('system', 'system', ['de-DE'])),
    ).toContain('15:45');
  });

  it('adds seconds only when asked', () => {
    const instant = at(2026, 6, 24, 15, 45, 12);

    expect(formatClockTime(instant, prefs('h24', 'system'))).toBe('15:45');
    expect(formatClockTime(instant, prefs('h24', 'system'), true)).toBe(
      '15:45:12',
    );
  });
});

describe('formatDateOnly', () => {
  const noon = at(2026, 6, 24);

  it.each([
    ['dmy' as const, '24/07/2026'],
    ['mdy' as const, '07/24/2026'],
    ['iso' as const, '2026-07-24'],
  ])(
    'renders %s as %s, zero-padded with a four-digit year',
    (date, expected) => {
      // The explicit orders are locale-independent by design — the reader opted out.
      for (const locale of ['en-US', 'de-DE', 'ja-JP']) {
        expect(formatDateOnly(noon, prefs('system', date, [locale]))).toBe(
          expected,
        );
      }
    },
  );

  it('follows the locale under Match system, with a four-digit year', () => {
    expect(formatDateOnly(noon, prefs('system', 'system', ['en-US']))).toBe(
      '7/24/2026',
    );
    expect(formatDateOnly(noon, prefs('system', 'system', ['de-DE']))).toBe(
      '24.7.2026',
    );
  });

  it('pads a single-digit day and month in the explicit orders', () => {
    const early = at(2026, 0, 5);

    expect(formatDateOnly(early, prefs('system', 'dmy'))).toBe('05/01/2026');
    expect(formatDateOnly(early, prefs('system', 'iso'))).toBe('2026-01-05');
  });
});

describe('formatDateTime', () => {
  const instant = at(2026, 6, 24, 15, 45);

  // One formatter carrying both option sets, so the LOCALE supplies the connector. sv-SE uses
  // a space rather than a comma — a hardcoded ", " would be wrong there.
  it('lets the locale join date and time under Match system', () => {
    const expected = (locale: string) =>
      new Intl.DateTimeFormat(locale, {
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(instant);

    for (const locale of ['en-US', 'de-DE', 'sv-SE', 'ja-JP']) {
      expect(
        formatDateTime(instant, prefs('system', 'system', [locale])),
        locale,
      ).toBe(expected(locale));
    }
  });

  it('joins with a comma once the date order is ours', () => {
    expect(formatDateTime(instant, prefs('h24', 'dmy'))).toBe(
      '24/07/2026, 15:45',
    );
    expect(formatDateTime(instant, prefs('h24', 'iso'))).toBe(
      '2026-07-24, 15:45',
    );
  });

  it('carries seconds through both paths', () => {
    const withSeconds = at(2026, 6, 24, 15, 45, 12);

    expect(formatDateTime(withSeconds, prefs('h24', 'iso'), true)).toBe(
      '2026-07-24, 15:45:12',
    );
    expect(
      formatDateTime(withSeconds, prefs('h24', 'system', ['en-GB']), true),
    ).toContain('15:45:12');
  });

  it('applies the time preference regardless of the date preference', () => {
    // The two settings are independent; a 24-hour clock must survive an explicit date order
    // and vice versa.
    expect(formatDateTime(instant, prefs('h12', 'iso'))).toContain('3:45');
    expect(
      formatDateTime(instant, prefs('h24', 'system', ['en-US'])),
    ).toContain('15:45');
  });
});

describe('formatDaySeparator', () => {
  const noon = at(2026, 6, 24);

  it('keeps the long weekday form under Match system', () => {
    expect(
      formatDaySeparator(noon, prefs('system', 'system', ['en-US']), false),
    ).toBe(
      new Intl.DateTimeFormat('en-US', {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }).format(noon),
    );
  });

  it('swaps the weekday for the year on an older day under Match system', () => {
    const rendered = formatDaySeparator(
      noon,
      prefs('system', 'system', ['en-US']),
      true,
    );
    expect(rendered).toContain('2026');
    expect(rendered).not.toContain('Friday');
  });

  // The user's decision on #22: the date preference governs separators too, so the setting
  // does not half-apply. An explicit order always carries its year, so `withYear` is moot.
  it.each([
    ['dmy' as const, '24/07/2026'],
    ['mdy' as const, '07/24/2026'],
    ['iso' as const, '2026-07-24'],
  ])(
    'renders %s as %s whether or not the year is asked for',
    (date, expected) => {
      expect(formatDaySeparator(noon, prefs('system', date), false)).toBe(
        expected,
      );
      expect(formatDaySeparator(noon, prefs('system', date), true)).toBe(
        expected,
      );
    },
  );
});

describe('formatter cache', () => {
  const instant = at(2026, 6, 24, 15, 45);

  // Vitest 4 made spies genuinely constructible, so a bare `vi.spyOn` on a built-in
  // constructor no longer yields a usable instance: `new` runs through the spy, whose
  // prototype lacks the internal slot that `format` is an accessor for, so calls fail
  // with "format is not a function". Under Vitest 3 the spy fell back to calling the
  // original as a plain function — which `Intl.DateTimeFormat` happens to permit — so
  // this read as an ordinary pass-through spy and needed no implementation.
  //
  // The implementation has to be a `function` rather than an arrow: Vitest 4 invokes it
  // with `new`, and an arrow cannot be constructed.
  const spyOnDateTimeFormat = () => {
    const RealDateTimeFormat = Intl.DateTimeFormat;
    return vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(function (
      ...args: ConstructorParameters<typeof Intl.DateTimeFormat>
    ) {
      return new RealDateTimeFormat(...args);
    } as unknown as typeof Intl.DateTimeFormat);
  };

  it('reuses a formatter for repeated calls with the same preference', () => {
    formatDateTime(instant, prefs('h24', 'system', ['en-US'])); // warm

    const construct = spyOnDateTimeFormat();
    try {
      formatDateTime(instant, prefs('h24', 'system', ['en-US']));
      expect(construct).not.toHaveBeenCalled();
    } finally {
      construct.mockRestore();
    }
  });

  // The bug the key exists to prevent: changing a format in Settings must not hand back the
  // formatter built for the old one.
  it('does not serve a stale formatter after the preference changes', () => {
    expect(formatClockTime(instant, prefs('h24', 'system', ['en-US']))).toBe(
      '15:45',
    );
    expect(
      formatClockTime(instant, prefs('h12', 'system', ['en-US'])),
    ).toContain('3:45');
    expect(formatClockTime(instant, prefs('h24', 'system', ['en-US']))).toBe(
      '15:45',
    );
  });

  it('keeps locales apart', () => {
    expect(formatDateOnly(instant, prefs('system', 'system', ['en-US']))).toBe(
      '7/24/2026',
    );
    expect(formatDateOnly(instant, prefs('system', 'system', ['de-DE']))).toBe(
      '24.7.2026',
    );
  });

  // A DateTimeFormat resolves its zone once at construction and never again, while the
  // local-day arithmetic in day-separator.ts goes through Date, which does re-resolve.
  it('rebuilds when the local UTC offset moves', () => {
    formatDateTime(instant, prefs('h24', 'system', ['en-US'])); // warm

    const construct = spyOnDateTimeFormat();
    try {
      const real = new Date().getTimezoneOffset();
      const moved = vi
        .spyOn(Date.prototype, 'getTimezoneOffset')
        .mockReturnValue(real + 60);

      formatDateTime(instant, prefs('h24', 'system', ['en-US']));
      expect(construct).toHaveBeenCalled();

      construct.mockClear();
      formatDateTime(instant, prefs('h24', 'system', ['en-US']));
      expect(construct).not.toHaveBeenCalled(); // settled at the new offset
      moved.mockRestore();
    } finally {
      construct.mockRestore();
    }
  });
});

describe('type guards', () => {
  it('accepts every catalogued id and rejects anything else', () => {
    expect(isTimeFormat('system')).toBe(true);
    expect(isTimeFormat('h12')).toBe(true);
    expect(isTimeFormat('h24')).toBe(true);
    expect(isTimeFormat('12h')).toBe(false);
    expect(isTimeFormat(null)).toBe(false);

    expect(isDateFormat('iso')).toBe(true);
    expect(isDateFormat('dmy')).toBe(true);
    expect(isDateFormat('mdy')).toBe(true);
    expect(isDateFormat('ymd')).toBe(false);
    expect(isDateFormat(null)).toBe(false);
  });

  it('defaults to Match system on both axes', () => {
    expect(DEFAULT_TIME_FORMAT).toBe('system');
    expect(DEFAULT_DATE_FORMAT).toBe('system');
  });
});
