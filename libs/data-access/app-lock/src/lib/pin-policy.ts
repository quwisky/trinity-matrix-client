/**
 * The renderer's copy of the PIN rules, for form validation and wait messages. The hosts'
 * verifiers are the authority (electron/src/app-lock-pin.ts, TrinityAppLockCore, the Kotlin
 * PinPolicy); all four run native/app-lock/pin-policy-cases.json.
 */
/** Whole string, 4–16 ASCII digits: `[0-9]`, never `\d` or `\p{Nd}`, and no `m` flag. */
export const PIN_PATTERN = /^[0-9]{4,16}$/;
export const PIN_MAX_LENGTH = 16;
/** Setup suggests at least this many digits (decision 18 allows 4). */
export const PIN_SUGGESTED_LENGTH = 6;

/** Checks the PIN exactly as typed: no trimming and no Unicode normalisation. */
export function isValidPin(pin: string): boolean {
  return PIN_PATTERN.test(pin);
}

const WAITS_FROM_FIFTH = [30, 60, 300, 900] as const;

/** Seconds to wait after `failures` consecutive failed PINs: none before the fifth. */
export function waitSecondsAfter(failures: number): number {
  if (failures < 5) return 0;
  return WAITS_FROM_FIFTH[failures - 5] ?? 3600;
}

/** A remaining wait in plain words, rounded up: "30 seconds", "2 minutes", "1 hour". */
export function formatRetryWait(ms: number): string {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return seconds === 1 ? '1 second' : `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return minutes === 1 ? '1 minute' : `${minutes} minutes`;
  return '1 hour';
}
