/**
 * Local calendar-day helpers for the timeline's day separators.
 *
 * Pure and DI-free: "now" is always a parameter, so the caller (a signal-driven computed)
 * decides when labels re-derive, and a test can pin the clock without fake timers. Days are
 * *local* calendar days — that is what a reader means by "today", and what every other
 * client separates on.
 */

/**
 * Smallest timestamp treated as a real event time. `safeBuildMessageView`'s unsupported
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

// Building an Intl.DateTimeFormat is comparatively expensive (~25µs) and the timeline
// re-derives labels on every incoming event, so the two shapes are built once and reused.
//
// The cache is keyed, not unconditional: a DateTimeFormat captures the time zone at
// construction and never re-resolves it, while `startOfLocalDay` goes through `Date`, which
// does. Held forever, the two would disagree after the OS zone moves under a long-lived
// session — a laptop opened in another country — and the separator would render a date a day
// off from the messages beneath it.
//
// The key is the current UTC offset rather than the resolved zone name because it is what
// actually decides the rendered date, and reading it is ~430x cheaper (0.06µs vs 25µs) —
// probing the zone name per call would cost as much as the construction the cache exists to
// avoid. The blind spot is a zone swap that preserves the current offset (London ->
// Abidjan in winter), where the label is identical anyway.
let formatOffset: number | undefined;
let sameYearFormat: Intl.DateTimeFormat | undefined;
let earlierYearFormat: Intl.DateTimeFormat | undefined;

/** The two label formatters, rebuilt whenever the local UTC offset has moved under us. */
function formatters(): {
  sameYear: Intl.DateTimeFormat;
  earlierYear: Intl.DateTimeFormat;
} {
  const offset = new Date().getTimezoneOffset();
  if (offset !== formatOffset || !sameYearFormat || !earlierYearFormat) {
    formatOffset = offset;
    sameYearFormat = new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    earlierYearFormat = new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }
  return { sameYear: sameYearFormat, earlierYear: earlierYearFormat };
}

/**
 * Human label for the calendar day starting at `dayStart`, read from the day starting at
 * `todayStart`: "Today", "Yesterday", or the date.
 *
 * The weekday is included within the current year (it is how people locate a recent day)
 * and dropped for older ones, where the year replaces it — "23 July" is ambiguous once a
 * room has a year of scrollback, and repeating the current year on every separator is noise.
 *
 * There is deliberately no "Tomorrow": a future-dated event is clock skew or a hostile
 * `origin_server_ts`, and showing its literal date is more honest than dressing it up.
 */
export function dayLabel(dayStart: number, todayStart: number): string {
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
  const { sameYear, earlierYear } = formatters();
  return new Date(dayStart).getFullYear() === new Date(todayStart).getFullYear()
    ? sameYear.format(dayStart)
    : earlierYear.format(dayStart);
}
