// @trinity/data-access/app-lock — App lock's settings, rules and state (spec 2026-10-12).
// Imported by role:application projects only; capabilities take ports instead.
export * from './lib/app-lock.preferences';
export * from './lib/away-policy';
export * from './lib/pin-policy';
export * from './lib/app-lock.service';
export {
  GUARD_WINDOW_MS,
  PRESENCE_REASONS,
  SUPPORT_TIMEOUT_MS,
  type AppLockCommandOutcome,
  type AppLockPinState,
  type AppLockStatus,
  type GuardOutcome,
  type UnlockOutcome,
} from './lib/app-lock.models';
export * from './lib/app-lock.tokens';
