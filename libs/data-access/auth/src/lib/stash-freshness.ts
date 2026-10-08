/** SSO and OIDC round-trips are short; reject a stash older than this to limit replay. */
const TTL_MS = 10 * 60 * 1000; // 10 minutes
/**
 * How far the stash may appear to have been written in the FUTURE before it is rejected.
 * The lower bound exists so a clock nudged forward cannot mint a stash that never expires
 * — but a zero-tolerance version fails an ordinary login, because the same event class
 * (a clock stepped backwards: NITZ/NTP after airplane mode, a laptop resuming from sleep,
 * w32time) can land mid-round-trip while the user is typing at the provider. A minute
 * survives normal clock discipline and still bins a stash written hours ahead.
 */
const CLOCK_SKEW_MS = 60 * 1000;

/**
 * Whether a stash written at `startedAt` (epoch ms, as stored) may still be served.
 * Two-sided: `age <= TTL_MS` alone treats a FUTURE timestamp as fresh, so a stash written
 * while the clock was ahead would never expire. A negative age beyond the skew allowance is
 * not a young stash, it is an untrustworthy one.
 */
export function isFresh(startedAt: string | null | undefined): boolean {
  const started = Number(startedAt);
  const age = Date.now() - started;
  return Number.isFinite(started) && age >= -CLOCK_SKEW_MS && age <= TTL_MS;
}
