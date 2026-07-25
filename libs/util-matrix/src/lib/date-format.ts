/**
 * The single engine behind every timestamp the app renders.
 *
 * Pure and DI-free: the preference arrives as a parameter, so the caller (a signal-driven
 * service) decides when values re-derive and a test can pin a format without any DI. The
 * injectable choke point that reads the stored preference is `DateTimeFormatService` in
 * `@trinity/platform-native`; this module holds the option catalogues, the formatting itself,
 * and the one `Intl.DateTimeFormat` cache.
 *
 * Everything goes through `Intl`, never Angular's `DatePipe`. That is not a style preference:
 * `DatePipe` formats via Angular's own bundled locale data, so honouring the reader's actual
 * locale through it would throw NG0701 for every locale not passed to `registerLocaleData` —
 * i.e. it would mean shipping the world's CLDR data. `Intl` is already in every target.
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
   * `navigator.languages` rather than `navigator.language`: the full chain lets `Intl`
   * negotiate down when the engine lacks data for the first entry, where a single tag would
   * instead fall through to the *runtime* default — which is `en-US` under jsdom and in the
   * Electron shell, quietly reinstating the bug this preference exists to fix.
   */
  readonly locales: readonly string[] | undefined;
  readonly time: TimeFormat;
  readonly date: DateFormat;
}

/** The distinct `Intl` option sets we ever build. Part of the cache key. */
type Shape =
  | 'clock'
  | 'clock-seconds'
  | 'date'
  | 'date-time'
  | 'date-time-seconds'
  | 'day'
  | 'day-with-year';

// Constructing an Intl.DateTimeFormat costs ~25µs and the timeline re-formats on every
// incoming event, so instances are cached. Two things make the cache correct rather than
// merely fast:
//
//  - It is keyed by shape AND both preferences AND the locale chain, so changing a format in
//    Settings cannot hand back a formatter built for the old one.
//  - It is dropped wholesale when the local UTC offset moves. A DateTimeFormat resolves its
//    time zone once, at construction, and never again; held across a zone change (a laptop
//    opened in another country) it would render dates that disagree with the local-day
//    arithmetic in day-separator.ts, which goes through `Date` and does re-resolve. The offset
//    is the key rather than the zone name because it is what decides the rendered value, and
//    reading it is ~430x cheaper (0.06µs vs 25µs) — probing the name per call would cost as
//    much as the construction the cache exists to avoid.
const formatters = new Map<string, Intl.DateTimeFormat>();
let cachedOffset: number | undefined;

function formatterFor(shape: Shape, prefs: DateTimePrefs): Intl.DateTimeFormat {
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
  const built = new Intl.DateTimeFormat(
    prefs.locales,
    optionsFor(shape, prefs),
  );
  formatters.set(key, built);
  return built;
}

function clockOptions(
  time: TimeFormat,
  withSeconds: boolean,
): Intl.DateTimeFormatOptions {
  const base: Intl.DateTimeFormatOptions = {
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' as const } : {}),
  };
  // `hourCycle`, not `hour12`. `hour12: false` selects the h24 cycle in several locales,
  // which renders midnight as "24:00" — a real complaint against clients that use it. h23 is
  // the 00–23 cycle every reader expects from a 24-hour clock.
  //
  // The hour width differs per choice because the conventions genuinely differ: someone who
  // asked for a 24-hour clock means HH:mm, and `hour: 'numeric'` would give them "9:05" in
  // every locale except en-US. A 12-hour clock is conventionally NOT padded ("9:05 AM", not
  // "09:05 AM"). Under Match system the locale decides, which is the whole point.
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
    // The day-separator shapes: the weekday within the current year (how people locate a
    // recent day), the year instead of it further back.
    case 'day':
      return { weekday: 'long', month: 'long', day: 'numeric' };
    case 'day-with-year':
      return { year: 'numeric', month: 'long', day: 'numeric' };
  }
}

/**
 * A date in an explicitly chosen order, zero-padded with a four-digit year.
 *
 * Deliberately `/` and `-` rather than the locale's own separator: the reader has opted out
 * of their locale's convention, and this is exactly the string the Settings option previews.
 * Reordering locale-formatted parts instead would need `formatToParts` surgery for a case the
 * user has already told us to ignore.
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
  return formatterFor(withSeconds ? 'clock-seconds' : 'clock', prefs).format(
    ts,
  );
}

/** A numeric date alone — "7/24/2026" / "24/07/2026" / "2026-07-24". */
export function formatDateOnly(ts: number, prefs: DateTimePrefs): string {
  return prefs.date === 'system'
    ? formatterFor('date', prefs).format(ts)
    : explicitDate(ts, prefs.date);
}

/**
 * Date and time together — the shape most of the app shows.
 *
 * Under `system` this is ONE formatter carrying both option sets, so the *locale* supplies the
 * connector: "7/24/2026, 3:45 PM" (en-US), "24.07.2026, 15:45" (de-DE), "2026-07-24 15:45"
 * (sv-SE — note the space, which a hardcoded ", " would get wrong). Once the date half is
 * ours, so is the join.
 */
export function formatDateTime(
  ts: number,
  prefs: DateTimePrefs,
  withSeconds = false,
): string {
  if (prefs.date === 'system') {
    return formatterFor(
      withSeconds ? 'date-time-seconds' : 'date-time',
      prefs,
    ).format(ts);
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
  return formatterFor(withYear ? 'day-with-year' : 'day', prefs).format(ts);
}

// Both accept `undefined` as well as `null` so a caller can narrow the value it actually
// holds. `hlm-select`'s valueChange is `string | null | undefined`, and narrowing a massaged
// expression (`isTimeFormat(value ?? null)`) leaves the original binding un-narrowed — which
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
