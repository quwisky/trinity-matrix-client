/**
 * The single engine behind every timestamp the app renders.
 *
 * Pure and DI-free: the preference arrives as a parameter. Holds the option catalogues, the
 * formatting itself and the one `Intl.DateTimeFormat` cache.
 *
 * Everything goes through `Intl`, never Angular's `DatePipe`: `DatePipe` uses Angular's
 * bundled locale data and throws NG0701 for any locale not passed to `registerLocaleData`.
 */

/** How the clock is rendered. `system` lets the locale decide 12- vs 24-hour. */
export const TRINITY_TIME_FORMATS = [
  { id: 'system', label: 'Match system' },
  { id: 'h12', label: '12-hour' },
  { id: 'h24', label: '24-hour' },
] as const;

export type TimeFormat = (typeof TRINITY_TIME_FORMATS)[number]['id'];

export const DEFAULT_TIME_FORMAT: TimeFormat = 'system';

/** How a numeric date is ordered. `system` lets the locale decide order and separator. */
export const TRINITY_DATE_FORMATS = [
  { id: 'system', label: 'Match system' },
  { id: 'dmy', label: 'Day first' },
  { id: 'mdy', label: 'Month first' },
  { id: 'iso', label: 'ISO' },
] as const;

export type DateFormat = (typeof TRINITY_DATE_FORMATS)[number]['id'];

export const DEFAULT_DATE_FORMAT: DateFormat = 'system';

/** Everything the formatters need: the reader's locales plus both explicit choices. */
export interface DateTimePrefs {
  /**
   * Locale chain, most-preferred first, or undefined to accept the runtime default.
   *
   * Use `navigator.languages`, not `navigator.language`: with a single tag `Intl` falls
   * through to the runtime default (`en-US` under jsdom and in the Electron shell) when the
   * engine lacks data for it.
   */
  readonly locales: readonly string[] | undefined;
  readonly time: TimeFormat;
  readonly date: DateFormat;
}

/** The distinct `Intl` option sets we build; part of the cache key. */
type Shape =
  | 'clock'
  | 'clock-seconds'
  | 'date'
  | 'date-time'
  | 'date-time-seconds'
  | 'day'
  | 'day-with-year';

// Formatters are cached because the timeline re-formats on every incoming event. The cache is
// keyed by shape, both preferences and the locale chain, and dropped wholesale when the local
// UTC offset moves: a DateTimeFormat resolves its time zone once at construction, so after a
// zone change it would disagree with the `Date` arithmetic in day-separator.ts. The offset is
// the key, not the zone name, because it decides the rendered value and is cheap to read.
//
// Each entry also memoises the strings it produced, bounded because history is unbounded.
const MAX_MEMOISED_STRINGS = 2000;

interface CachedFormatter {
  readonly formatter: Intl.DateTimeFormat;
  readonly text: Map<number, string>;
}

const formatters = new Map<string, CachedFormatter>();
let cachedOffset: number | undefined;

function formatterFor(shape: Shape, prefs: DateTimePrefs): CachedFormatter {
  const offset = new Date().getTimezoneOffset();
  if (offset !== cachedOffset) {
    cachedOffset = offset;
    formatters.clear();
  }
  const key = `${shape}|${prefs.time}|${prefs.date}|${prefs.locales?.join(',') ?? ''}`;
  const cached = formatters.get(key);
  if (cached) {
    return cached;
  }
  const built: CachedFormatter = {
    formatter: new Intl.DateTimeFormat(prefs.locales, optionsFor(shape, prefs)),
    text: new Map(),
  };
  formatters.set(key, built);
  return built;
}

function formatWith(shape: Shape, prefs: DateTimePrefs, ts: number): string {
  const { formatter, text } = formatterFor(shape, prefs);
  let formatted = text.get(ts);
  if (formatted === undefined) {
    if (text.size >= MAX_MEMOISED_STRINGS) {
      text.clear();
    }
    formatted = formatter.format(ts);
    text.set(ts, formatted);
  }
  return formatted;
}

function clockOptions(
  time: TimeFormat,
  withSeconds: boolean,
): Intl.DateTimeFormatOptions {
  const base: Intl.DateTimeFormatOptions = {
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' as const } : {}),
  };
  // `hourCycle`, not `hour12`: `hour12: false` selects h24 in several locales, rendering
  // midnight as "24:00". The hour width differs on purpose: 24-hour is padded (HH:mm, which
  // `numeric` would not give outside en-US), 12-hour is not ("9:05 AM"), and Match system
  // leaves it to the locale.
  switch (time) {
    case 'h12':
      return { ...base, hour: 'numeric', hourCycle: 'h12' };
    case 'h24':
      return { ...base, hour: '2-digit', hourCycle: 'h23' };
    case 'system':
      return { ...base, hour: 'numeric' };
  }
}

/** Numeric year/month/day, ordered by the locale. Only used when `date` is `system`. */
const SYSTEM_DATE_OPTIONS: Intl.DateTimeFormatOptions = {
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
};

function optionsFor(
  shape: Shape,
  prefs: DateTimePrefs,
): Intl.DateTimeFormatOptions {
  switch (shape) {
    case 'clock':
      return clockOptions(prefs.time, false);
    case 'clock-seconds':
      return clockOptions(prefs.time, true);
    case 'date':
      return SYSTEM_DATE_OPTIONS;
    case 'date-time':
      return { ...SYSTEM_DATE_OPTIONS, ...clockOptions(prefs.time, false) };
    case 'date-time-seconds':
      return { ...SYSTEM_DATE_OPTIONS, ...clockOptions(prefs.time, true) };
    // The day-separator shapes: weekday within the current year, year further back.
    case 'day':
      return { weekday: 'long', month: 'long', day: 'numeric' };
    case 'day-with-year':
      return { year: 'numeric', month: 'long', day: 'numeric' };
  }
}

/**
 * A date in an explicitly chosen order, zero-padded with a four-digit year. Uses `/` and `-`
 * rather than the locale's separator: the reader has opted out of the locale's convention.
 */
function explicitDate(ts: number, date: Exclude<DateFormat, 'system'>): string {
  const at = new Date(ts);
  const year = String(at.getFullYear()).padStart(4, '0');
  const month = String(at.getMonth() + 1).padStart(2, '0');
  const day = String(at.getDate()).padStart(2, '0');
  switch (date) {
    case 'dmy':
      return `${day}/${month}/${year}`;
    case 'mdy':
      return `${month}/${day}/${year}`;
    case 'iso':
      return `${year}-${month}-${day}`;
  }
}

/** Clock time alone — "3:45 PM" / "15:45". */
export function formatClockTime(
  ts: number,
  prefs: DateTimePrefs,
  withSeconds = false,
): string {
  return formatWith(withSeconds ? 'clock-seconds' : 'clock', prefs, ts);
}

/** A numeric date alone — "7/24/2026" / "24/07/2026" / "2026-07-24". */
export function formatDateOnly(ts: number, prefs: DateTimePrefs): string {
  return prefs.date === 'system'
    ? formatWith('date', prefs, ts)
    : explicitDate(ts, prefs.date);
}

/**
 * Date and time together. Under `system` one formatter carries both option sets so the
 * locale supplies the connector (sv-SE uses a space, which a hardcoded ", " would get wrong).
 */
export function formatDateTime(
  ts: number,
  prefs: DateTimePrefs,
  withSeconds = false,
): string {
  if (prefs.date === 'system') {
    return formatWith(
      withSeconds ? 'date-time-seconds' : 'date-time',
      prefs,
      ts,
    );
  }
  return `${explicitDate(ts, prefs.date)}, ${formatClockTime(ts, prefs, withSeconds)}`;
}

/**
 * The label under a timeline day separator, for a day that is neither today nor yesterday.
 * `withYear` is for days in an earlier year, where the year replaces the weekday.
 *
 * An explicitly ordered date always carries its year, so `withYear` only affects `system`.
 */
export function formatDaySeparator(
  ts: number,
  prefs: DateTimePrefs,
  withYear: boolean,
): string {
  if (prefs.date !== 'system') {
    return explicitDate(ts, prefs.date);
  }
  return formatWith(withYear ? 'day-with-year' : 'day', prefs, ts);
}

// Both accept `undefined` as well as `null` so a caller can narrow the value it holds:
// narrowing `isTimeFormat(value ?? null)` leaves the original binding un-narrowed, which
// type-checks under vitest and fails only in the Angular build.
export function isTimeFormat(
  value: string | null | undefined,
): value is TimeFormat {
  return TRINITY_TIME_FORMATS.some((option) => option.id === value);
}

export function isDateFormat(
  value: string | null | undefined,
): value is DateFormat {
  return TRINITY_DATE_FORMATS.some((option) => option.id === value);
}
