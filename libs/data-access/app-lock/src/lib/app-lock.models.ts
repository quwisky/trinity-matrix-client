import type {
  HostPinOutcome,
  HostPresenceOutcome,
  HostSystemPresenceUnavailableReason,
  HostUserPresenceSupport,
} from '@trinity/runtime/host';

/** How long startup waits for the host to report support before failing closed. */
export const SUPPORT_TIMEOUT_MS = 3_000;
/** One verification covers further App lock changes for this long (decision 7). */
export const GUARD_WINDOW_MS = 60_000;
/**
 * What the system prompt says; the OS shows it, so it is user-facing copy. The unlock reason
 * names the running app ("Unlock Trinity Next" in the desktop prerelease).
 */
export const PRESENCE_REASONS = {
  unlock: (appName: string): string => `Unlock ${appName}`,
  enable: 'Turn on app lock',
  change: 'Change app lock settings',
} as const;

export type AppLockStatus = 'unknown' | 'off' | 'locked' | 'unlocked';

/**
 * What the lock screen's PIN form can do: check a stored PIN, nothing because none is stored
 * (a reset that stopped half way), or nothing because the host cannot read its PIN record now
 * (a locked keyring, a damaged record, or no answer yet).
 */
export type AppLockPinState = 'ready' | 'not-set' | 'unavailable';

/**
 * An unlock attempt. A returned `until` is never earlier than the clock: a wait the host
 * reports as already over (after a clock jump) comes back as `failed` with `until: null`, or
 * `delayed` with `until` = now. Either means "retry allowed now"; nothing retries by itself.
 */
export type UnlockOutcome =
  | { readonly kind: 'unlocked' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly until: number | null }
  | { readonly kind: 'delayed'; readonly until: number }
  | {
      readonly kind: 'use-pin';
      readonly reason: HostSystemPresenceUnavailableReason;
    }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'unavailable' };

export type GuardOutcome = 'verified' | 'cancelled' | 'use-pin';

export type AppLockCommandOutcome =
  | { readonly kind: 'completed' }
  | {
      readonly kind: 'failed';
      readonly reason:
        | 'not-offered'
        | 'not-verified'
        | 'pin-invalid'
        | 'pin-not-saved'
        | 'setting-not-saved';
    };

/** A guarded change's reading of the system prompt: only `verified` lets the change through. */
export function guardOutcome(outcome: HostPresenceOutcome): GuardOutcome {
  switch (outcome.kind) {
    case 'verified':
      return 'verified';
    case 'cancelled':
    case 'failed':
      return 'cancelled';
    case 'locked-out':
    case 'unavailable':
    case 'rejected':
      return 'use-pin';
    default: {
      const unhandled: never = outcome;
      void unhandled;
      return 'use-pin';
    }
  }
}

/**
 * The lock screen's reading of the system prompt. `waitUntil` is the delay the failures so far
 * have started (the outcome is already counted); every fallback leads to the PIN.
 */
export function systemUnlockOutcome(
  outcome: HostPresenceOutcome,
  waitUntil: number | null,
): UnlockOutcome {
  switch (outcome.kind) {
    case 'verified':
      return { kind: 'unlocked' };
    case 'cancelled':
      return { kind: 'cancelled' };
    case 'failed':
      return { kind: 'failed', until: waitUntil };
    case 'locked-out':
      return { kind: 'use-pin', reason: 'locked-out' };
    case 'unavailable':
      return { kind: 'use-pin', reason: outcome.reason };
    case 'rejected':
      return { kind: 'use-pin', reason: 'not-supported' };
    default: {
      const unhandled: never = outcome;
      void unhandled;
      return { kind: 'use-pin', reason: 'not-supported' };
    }
  }
}

/** A deadline still ahead of `now`, else null: a wait already over never counts below zero. */
export function futureOrNull(at: number | null, now: number): number | null {
  return at !== null && at > now ? at : null;
}

/** The host's support with a PIN wait that is already over read as no wait. */
export function withoutPastWait(
  support: HostUserPresenceSupport,
  now: number,
): HostUserPresenceSupport {
  const pin = support.pin;
  if (pin.kind !== 'available' || pin.nextAttemptAt === null) return support;
  const nextAttemptAt = futureOrNull(pin.nextAttemptAt, now);
  return nextAttemptAt === pin.nextAttemptAt
    ? support
    : { ...support, pin: { ...pin, nextAttemptAt } };
}

/**
 * The lock screen's reading of a PIN attempt. A wait already over (a clock jump) reads as
 * "retry allowed now": `failed` with no wait, or `delayed` until `now`.
 */
export function pinUnlockOutcome(
  outcome: HostPinOutcome,
  now: number,
): UnlockOutcome {
  switch (outcome.kind) {
    case 'verified':
      return { kind: 'unlocked' };
    case 'failed':
      return {
        kind: 'failed',
        until: futureOrNull(outcome.nextAttemptAt, now),
      };
    case 'delayed':
      return {
        kind: 'delayed',
        until: futureOrNull(outcome.nextAttemptAt, now) ?? now,
      };
    case 'invalid':
      return { kind: 'invalid' };
    case 'unavailable':
    case 'rejected':
      return { kind: 'unavailable' };
    default: {
      const unhandled: never = outcome;
      void unhandled;
      return { kind: 'unavailable' };
    }
  }
}
