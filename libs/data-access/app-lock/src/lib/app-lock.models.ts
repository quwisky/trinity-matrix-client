import type {
  HostPinOutcome,
  HostPresenceOutcome,
  HostSystemPresenceUnavailableReason,
  HostUserPresenceSupport,
} from '@trinity/runtime/host';
import {
  APP_LOCK_LOCK_AFTER_PREFERENCE,
  APP_LOCK_NOTIFICATION_TEXT_PREFERENCE,
  type StoredAppLock,
} from './app-lock.preferences';

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
 * What the lock screen's PIN form can do:
 * - `ready`: a PIN is stored and can be checked;
 * - `not-set`: the PIN store works but holds no PIN (a reset that stopped half way);
 * - `unreadable`: a PIN store exists but cannot be read now (a locked keyring, a damaged
 *   record, or no answer from the host): "Trinity can't read your PIN right now", with Retry;
 * - `not-supported`: this host has no PIN store (the web).
 */
export type AppLockPinState =
  'ready' | 'not-set' | 'unreadable' | 'not-supported';

export function pinStateOf(support: HostUserPresenceSupport): AppLockPinState {
  const pin = support.pin;
  if (pin.kind === 'available') return pin.set ? 'ready' : 'not-set';
  return pin.reason === 'not-supported' ? 'not-supported' : 'unreadable';
}

/**
 * Whether an unreadable enabled setting means the lock is on (spec §1 "Unreadable setting",
 * decision 27). Locked only where the host can verify presence, and then a stored PIN
 * decides; every lock has a PIN (decision 23). `null` is a host that did not answer.
 * - no answer, or a PIN store that cannot be read: locked (fail closed);
 * - a PIN store: locked when it holds a PIN, off when it holds none;
 * - no PIN store: locked only where the system prompt can verify (never on the web).
 */
export function unreadableSettingLocks(
  support: HostUserPresenceSupport | null,
): boolean {
  if (support === null) return true;
  const pin = pinStateOf(support);
  switch (pin) {
    case 'ready':
    case 'unreadable':
      return true;
    case 'not-set':
      return false;
    case 'not-supported':
      return support.system.kind === 'available';
    default: {
      const unhandled: never = pin;
      void unhandled;
      return true;
    }
  }
}

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
        | 'setting-not-saved'
        /** `clearUnreadablePin` is only for a readable "off" over a PIN store it can't read. */
        | 'not-allowed'
        /** The host couldn't clear the PIN record: unavailable, rejected or no answer. */
        | 'pin-not-cleared';
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

// Internal to the library (not exported from its index).

/** How long startup waits for the preference storage before reading the setting unreadable. */
export const SETTINGS_TIMEOUT_MS = 3_000;
export const SETTINGS_UNREADABLE: StoredAppLock = {
  enabled: 'unreadable',
  lockAfter: APP_LOCK_LOCK_AFTER_PREFERENCE.defaultValue,
  notificationText: APP_LOCK_NOTIFICATION_TEXT_PREFERENCE.defaultValue,
};
/**
 * The host did not answer: whether a PIN is stored is unknown, so the PIN reads as unreadable
 * (fail closed, with Retry) and no system prompt is offered until the host answers.
 */
export const NO_ANSWER: HostUserPresenceSupport = {
  system: { kind: 'unavailable', reason: 'not-supported' },
  pin: { kind: 'unavailable', reason: 'secure-storage-unavailable' },
};

export const COMPLETED: AppLockCommandOutcome = { kind: 'completed' };
export const NOT_OFFERED: AppLockCommandOutcome = {
  kind: 'failed',
  reason: 'not-offered',
};
export const NOT_VERIFIED: AppLockCommandOutcome = {
  kind: 'failed',
  reason: 'not-verified',
};
export const PIN_NOT_SAVED: AppLockCommandOutcome = {
  kind: 'failed',
  reason: 'pin-not-saved',
};
export const SETTING_NOT_SAVED: AppLockCommandOutcome = {
  kind: 'failed',
  reason: 'setting-not-saved',
};
export const NOT_ALLOWED: AppLockCommandOutcome = {
  kind: 'failed',
  reason: 'not-allowed',
};
export const PIN_NOT_CLEARED: AppLockCommandOutcome = {
  kind: 'failed',
  reason: 'pin-not-cleared',
};
export const PIN_UNAVAILABLE: UnlockOutcome = { kind: 'unavailable' };
