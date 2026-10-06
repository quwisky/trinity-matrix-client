/**
 * "Only the newest async result may land." Take a token before async work, apply the
 * result only while that token is still current, and invalidate on reset/release so nothing
 * in flight can land afterwards. Prefer `switchMap` when the work is already an Observable;
 * this is for Promise chains, callbacks and render hooks. See state-and-reactivity.md.
 */
export interface LatestToken {
  readonly __latest: unique symbol;
}

export interface LatestGuard {
  /** Start new work: every earlier token stops being current. */
  next(): LatestToken;
  /** Whether this token's work is still the newest and has not been invalidated. */
  isCurrent(token: LatestToken): boolean;
  /** Reset/release: every outstanding token stops being current. */
  invalidate(): void;
}

export function latestGuard(): LatestGuard {
  let current = 0;
  return {
    next: () => {
      current += 1;
      return current as unknown as LatestToken;
    },
    isCurrent: (token) => (token as unknown as number) === current,
    invalidate: () => {
      current += 1;
    },
  };
}
