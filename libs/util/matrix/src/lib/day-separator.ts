/**
 * Local calendar-day helpers for the timeline's day separators.
 *
 * Pure and DI-free: "now" and the format preference are always parameters, so the caller (a
 * signal-driven computed) decides when labels re-derive, and a test can pin the clock without
 * fake timers. Days are *local* calendar days — that is what a reader means by "today", and
 * what every other client separates on.
 */
import { formatDaySeparator, type DateTimePrefs } from './date-format';

/**
 * Smallest timestamp treated as a real event time. Message Presentation's unsupported
 * fallback reports `timestamp: 0` when `origin_server_ts` can't be read, and a hostile event
 * can report anything at all; without a floor, one malformed event mints a "1 January 1970"
 * separator and strands the message after it against 1970.
 *
 * Set well before Matrix's own launch on purpose. Bridges backfill imported history at its
 * *original* time (the appservice `?ts=` parameter), so a room carrying an IRC or
 * mailing-list archive holds genuinely decades-old events; a floor at 2014 would classify
 * every one of them as "no clock" and silently drop the separators in exactly the rooms
 * where they help most.
 */
const MIN_PLAUSIBLE_TS = 631_152_000_000; // 1990-01-01T00:00:00Z

/**
 * Largest timestamp treated as a real event time.
 *
 * `origin_server_ts` is a raw federated number that nothing in the SDK clamps, and a bridge
 * reporting microseconds or nanoseconds is a routine bug rather than an attack. Both land
 * far past this bound — and anything past the ECMA-262 time range (±8.64e15) makes
 * `startOfLocalDay` return NaN, which compares equal to nothing, falls through every branch
 * of {@link dayLabel}, and reaches `Intl.format(NaN)`. That throws, inside the timeline's
 * `rows` computed, blanking the whole room rather than mislabelling one message. Rejecting
 * these here makes them behave like the missing-clock case instead: no separator, and the
 * surrounding day carries on.
 */
const MAX_PLAUSIBLE_TS = 7_258_118_400_000; // 2200-01-01T00:00:00Z

/**
 * Whether a timestamp is usable for day bucketing — finite and within
 * {@link MIN_PLAUSIBLE_TS}…{@link MAX_PLAUSIBLE_TS}. Everything this accepts is guaranteed
 * to survive {@link startOfLocalDay} and {@link dayLabel} without throwing.
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
 * Calendar arithmetic, not `+ 24h`: a fall-back day is 25 hours long, so adding a nominal
 * day lands at 23:00 the *same* day, and normalising that back to a midnight returns the one
 * we started from. A caller sleeping until "the next midnight" would then get a target in
 * the past and re-arm itself in a tight loop. Rolling the date field over handles month and
 * year ends too.
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
 * `prefs` is a parameter rather than something read from a service, so this stays DI-free;
 * the timeline's `rows()` computed reads the signal and passes it in, which is also what makes
 * a format change re-derive every label. Formatting itself — and the `Intl` cache — lives in
 * `date-format.ts`, shared with every other timestamp in the app.
 *
 * Within the current year the date carries its weekday (it is how people locate a recent day);
 * further back the year replaces it, since "23 July" is ambiguous once a room has a year of
 * scrollback and repeating the current year on every separator is noise. Under an explicitly
 * chosen date order the reader gets that order, year and all.
 *
 * "Today" and "Yesterday" are prose rather than timestamps, so no format preference touches
 * them; translating them belongs to the i18n work, not to formatting.
 *
 * There is deliberately no "Tomorrow": a future-dated event is clock skew or a hostile
 * `origin_server_ts`, and showing its literal date is more honest than dressing it up.
 */
export function dayLabel(
  dayStart: number,
  todayStart: number,
  prefs: DateTimePrefs,
): string {
  if (dayStart === todayStart) {
    return 'Today';
  }
  // One millisecond before today's midnight is always somewhere inside yesterday, whatever
  // that day's length was. Subtracting a fixed 24h lands on the wrong calendar day across a
  // DST transition — and on the right one the other 363 days a year, which is exactly what
  // lets that bug survive review.
  if (dayStart === startOfLocalDay(todayStart - 1)) {
    return 'Yesterday';
  }
  const earlierYear =
    new Date(dayStart).getFullYear() !== new Date(todayStart).getFullYear();
  return formatDaySeparator(dayStart, prefs, earlierYear);
}

/**
 * Epoch ms of local midnight for a `YYYY-MM-DD` string — what `<input type="date">` puts in
 * its value.
 *
 * Built from the numeric fields rather than `new Date(iso)`, because ECMAScript parses a
 * bare date-only string as **UTC**: `new Date('2026-08-03').getTime()` is 2026-08-03T00:00Z,
 * which is the 2nd for anyone west of Greenwich and the right day at the wrong hour for
 * everyone east of it. A date jump built on that lands on the previous day for roughly half
 * the world — and never for whoever wrote it, if they are on UTC.
 *
 * Returns null for anything that is not a real calendar date, including the ones that parse
 * but roll over (2026-02-30 would otherwise silently become 2 March).
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

/** `YYYY-MM-DD` for the local day containing `ts` — the inverse, for seeding a date input. */
export function isoDateOf(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
