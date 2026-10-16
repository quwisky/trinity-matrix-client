/**
 * Local calendar-day helpers for the timeline's day separators.
 *
 * Pure and DI-free: "now" and the format preference are always parameters. Days are *local*
 * calendar days.
 */
import { formatDaySeparator, type DateTimePrefs } from './date-format';

/**
 * Smallest timestamp treated as a real event time. The unsupported-event fallback reports
 * `timestamp: 0` when `origin_server_ts` can't be read, and a hostile event can report
 * anything, so without a floor one malformed event mints a "1 January 1970" separator.
 *
 * Deliberately well before Matrix's launch: bridges backfill imported history at its
 * original time (appservice `?ts=`), so IRC or mailing-list archives hold decades-old events.
 */
const MIN_PLAUSIBLE_TS = 631_152_000_000; // 1990-01-01T00:00:00Z

/**
 * Largest timestamp treated as a real event time. `origin_server_ts` is a raw federated
 * number nothing clamps, and a bridge reporting microseconds or nanoseconds lands far past
 * this. Anything beyond the ECMA-262 time range (±8.64e15) makes `startOfLocalDay` return
 * NaN, which reaches `Intl.format(NaN)` and throws inside the timeline's `rows` computed,
 * blanking the whole room. Rejecting it behaves like the missing-clock case: no separator.
 */
const MAX_PLAUSIBLE_TS = 7_258_118_400_000; // 2200-01-01T00:00:00Z

/**
 * Whether a timestamp is usable for day bucketing: finite and within
 * {@link MIN_PLAUSIBLE_TS}…{@link MAX_PLAUSIBLE_TS}, so it cannot make {@link dayLabel} throw.
 */
export function hasUsableTimestamp(ts: number): boolean {
  return (
    Number.isFinite(ts) && ts >= MIN_PLAUSIBLE_TS && ts <= MAX_PLAUSIBLE_TS
  );
}

/** Epoch ms of the local midnight that starts the calendar day containing `ts`. */
export function startOfLocalDay(ts: number): number {
  const day = new Date(ts);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * Epoch ms of the local midnight that starts the day *after* the one containing `ts` — the
 * instant a "Today" label stops being true.
 *
 * Calendar arithmetic, not `+ 24h`: a fall-back day is 25 hours long, so that would land at
 * 23:00 the same day and a caller sleeping until it would re-arm in a tight loop.
 */
export function startOfNextLocalDay(ts: number): number {
  const day = new Date(ts);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() + 1);
  return day.getTime();
}

/**
 * Human label for the calendar day starting at `dayStart`, read from the day starting at
 * `todayStart`: "Today", "Yesterday", or the date.
 *
 * Within the current year the date carries its weekday; further back the year replaces it.
 * "Today" and "Yesterday" are prose, untouched by the format preference. There is no
 * "Tomorrow": a future-dated event is clock skew or a hostile `origin_server_ts`, so its
 * literal date is shown.
 */
export function dayLabel(
  dayStart: number,
  todayStart: number,
  prefs: DateTimePrefs,
): string {
  if (dayStart === todayStart) {
    return 'Today';
  }
  // One millisecond before today's midnight is always inside yesterday; subtracting a fixed
  // 24h lands on the wrong day across a DST transition.
  if (dayStart === startOfLocalDay(todayStart - 1)) {
    return 'Yesterday';
  }
  const earlierYear =
    new Date(dayStart).getFullYear() !== new Date(todayStart).getFullYear();
  return formatDaySeparator(dayStart, prefs, earlierYear);
}

/**
 * Epoch ms of local midnight for a `YYYY-MM-DD` string, as `<input type="date">` produces.
 *
 * Built from the numeric fields, not `new Date(iso)`: ECMAScript parses a bare date-only
 * string as UTC, which is the previous day for anyone west of Greenwich.
 *
 * Returns null for anything that is not a real calendar date, including ones that roll over
 * (2026-02-30).
 */
export function localDayStartFromIso(iso: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) {
    return null;
  }
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  // Reject a rolled-over date: `new Date(2026, 1, 30)` is 2 March, not an error.
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date.getTime();
}

/** `YYYY-MM-DD` for the local day containing `ts`, for seeding a date input. */
export function isoDateOf(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
