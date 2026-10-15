import type { LockAfter } from './app-lock.preferences';

/** Mobile counts time in the background; the desktop also counts time without focus. */
export type AppLockSurface = 'mobile' | 'desktop';

/** "Immediately" on desktop: 10 s after blur or minimise (decision 17). */
export const DESKTOP_IMMEDIATE_GRACE_MS = 10_000;

const MINUTES: Readonly<Record<Exclude<LockAfter, 'immediately'>, number>> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '60m': 60,
};

export function lockDelayMs(
  lockAfter: LockAfter,
  surface: AppLockSurface,
): number {
  if (lockAfter === 'immediately') {
    return surface === 'desktop' ? DESKTOP_IMMEDIATE_GRACE_MS : 0;
  }
  return MINUTES[lockAfter] * 60_000;
}

export type AwayVerdict =
  | { readonly kind: 'lock' }
  | { readonly kind: 'wait'; readonly remainingMs: number };

/**
 * Whether time away has used up the delay. Fails closed: a clock that went backwards, or a
 * time that is not finite (NaN, ±Infinity), locks.
 */
export function awayVerdict(input: {
  readonly awaySince: number;
  readonly now: number;
  readonly lockAfter: LockAfter;
  readonly surface: AppLockSurface;
}): AwayVerdict {
  if (!Number.isFinite(input.now) || !Number.isFinite(input.awaySince)) {
    return { kind: 'lock' };
  }
  const elapsed = input.now - input.awaySince;
  if (elapsed < 0) return { kind: 'lock' };
  const remaining = lockDelayMs(input.lockAfter, input.surface) - elapsed;
  // Only a positive remainder waits; anything else, NaN included, locks.
  return remaining > 0
    ? { kind: 'wait', remainingMs: remaining }
    : { kind: 'lock' };
}
