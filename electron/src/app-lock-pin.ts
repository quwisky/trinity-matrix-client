/**
 * The Trinity PIN verifier's pure core: format, delay schedule, clock rules and the
 * scrypt record. The main-only store, `PinVerifier`, lives in `./app-lock-pin-store`.
 * The shared fixture native/app-lock/pin-policy-cases.json pins the rules for every host; change them together.
 * Nothing here logs, and no error or outcome carries the PIN, its hash or its salt.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** 4–16 ASCII digits. Unicode digits are refused, never normalised. */
export const PIN_PATTERN = /^[0-9]{4,16}$/;

export function isValidPin(pin: unknown): pin is string {
  return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

/** No wait for failures 1–4; then 30 s, 1 min, 5 min, 15 min, and 1 h from the ninth. */
const WAITS_FROM_FIFTH = [30, 60, 300, 900] as const;
const LONGEST_WAIT = 3600;

export function waitSecondsAfter(failures: number): number {
  if (failures < 5) return 0;
  return WAITS_FROM_FIFTH[failures - 5] ?? LONGEST_WAIT;
}

/** Wall-clock epoch milliseconds and seconds since boot (sleep included). */
export interface PinClock {
  readonly nowMs: number;
  readonly uptimeS: number;
}

export interface PinFailureState {
  readonly failures: number;
  readonly failureAtMs: number | null;
  readonly failureUptimeS: number | null;
}

/**
 * Whether a wait has ended. Both deadlines must pass, so moving the wall clock forward
 * ends nothing early and moving it back keeps the wait. After a reboot (uptime lower than
 * at the failure) only the wall clock counts: a reboot needed the device's own login.
 */
export function attemptAllowed(
  state: PinFailureState,
  clock: PinClock,
): boolean {
  const wait = waitSecondsAfter(state.failures);
  if (
    wait === 0 ||
    state.failureAtMs === null ||
    state.failureUptimeS === null
  ) {
    return true;
  }
  const rebooted = clock.uptimeS < state.failureUptimeS;
  const uptimeOk = rebooted || clock.uptimeS - state.failureUptimeS >= wait;
  const wallOk = clock.nowMs - state.failureAtMs >= wait * 1000;
  return uptimeOk && wallOk;
}

/** When the running wait ends by the wall clock, for display; null when there is none. */
export function nextAttemptAt(state: PinFailureState): number | null {
  const wait = waitSecondsAfter(state.failures);
  return wait === 0 || state.failureAtMs === null
    ? null
    : state.failureAtMs + wait * 1000;
}

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** About 128 MB and a few hundred milliseconds; stored per record so it can rise later. */
export const PRODUCTION_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };
const KEY_LENGTH = 32;
const SALT_LENGTH = 16;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
/** Each unit of p is one more full pass, so a damaged record cannot stall every attempt. */
const MAX_PARALLELISM = 16;

export interface PinRecord extends PinFailureState {
  readonly v: 1;
  readonly kdf: 'scrypt';
  readonly params: ScryptParams;
  /** base64 */
  readonly salt: string;
  /** base64 */
  readonly hash: string;
}

export type PinCheck =
  | { readonly kind: 'verified' }
  | { readonly kind: 'failed'; readonly nextAttemptAt: number | null }
  | { readonly kind: 'delayed'; readonly nextAttemptAt: number }
  | { readonly kind: 'invalid' };

/** Errors carry a fixed code only: never the PIN, the salt or Node's own detail. */
function derive(
  pin: string,
  salt: Buffer,
  params: ScryptParams,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    try {
      scrypt(
        pin,
        salt,
        KEY_LENGTH,
        { N: params.N, r: params.r, p: params.p, maxmem: SCRYPT_MAXMEM },
        (error, key) =>
          error ? reject(new Error('pin-kdf-failed')) : resolve(key),
      );
    } catch {
      reject(new Error('pin-kdf-failed'));
    }
  });
}

export async function createPinRecord(
  pin: string,
  params: ScryptParams = PRODUCTION_SCRYPT,
): Promise<PinRecord> {
  // The same format on every path: a PIN checkPin would refuse is never stored or hashed.
  if (!isValidPin(pin)) throw new Error('pin-invalid');
  const salt = randomBytes(SALT_LENGTH);
  const hash = await derive(pin, salt, params);
  return {
    v: 1,
    kdf: 'scrypt',
    params,
    salt: salt.toString('base64'),
    hash: hash.toString('base64'),
    failures: 0,
    failureAtMs: null,
    failureUptimeS: null,
  };
}

/** Check one attempt; returns the outcome and the record to store (unchanged if refused). */
export async function checkPin(
  record: PinRecord,
  pin: unknown,
  clock: PinClock,
): Promise<{ readonly check: PinCheck; readonly record: PinRecord }> {
  if (!isValidPin(pin)) return { check: { kind: 'invalid' }, record };
  if (!attemptAllowed(record, clock)) {
    return {
      check: {
        kind: 'delayed',
        nextAttemptAt: nextAttemptAt(record) ?? clock.nowMs,
      },
      record,
    };
  }
  const expected = Buffer.from(record.hash, 'base64');
  const actual = await derive(
    pin,
    Buffer.from(record.salt, 'base64'),
    record.params,
  );
  if (expected.length === actual.length && timingSafeEqual(expected, actual)) {
    return {
      check: { kind: 'verified' },
      record: {
        ...record,
        failures: 0,
        failureAtMs: null,
        failureUptimeS: null,
      },
    };
  }
  const failed: PinRecord = {
    ...record,
    failures: record.failures + 1,
    failureAtMs: clock.nowMs,
    failureUptimeS: clock.uptimeS,
  };
  return {
    check: { kind: 'failed', nextAttemptAt: nextAttemptAt(failed) },
    record: failed,
  };
}

export function encodePinRecord(record: PinRecord): string {
  return JSON.stringify(record);
}

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isInstant(value: unknown): value is number | null {
  return (
    value === null || (typeof value === 'number' && Number.isFinite(value))
  );
}

/** The decoded length of canonical base64, or -1. */
function base64Bytes(value: unknown): number {
  return typeof value === 'string' && BASE64.test(value)
    ? Buffer.from(value, 'base64').length
    : -1;
}

/** Parameters scrypt accepts within its memory cap (OpenSSL's 128·r·(N + p + 2) bytes). */
function isScryptParams(value: unknown): value is ScryptParams {
  if (!value || typeof value !== 'object') return false;
  const { N, r, p } = value as Record<string, unknown>;
  return (
    isCount(N) &&
    N >= 1024 &&
    Number.isInteger(Math.log2(N)) &&
    isCount(r) &&
    r >= 1 &&
    isCount(p) &&
    p >= 1 &&
    p <= MAX_PARALLELISM &&
    128 * r * (N + p + 2) <= SCRYPT_MAXMEM
  );
}

/**
 * The stored record, or null for anything damaged; never throws. A failure count and its
 * two instants exist together or not at all, so a damaged record cannot end a wait early.
 */
export function decodePinRecord(text: string): PinRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const { params, salt, hash, failures, failureAtMs, failureUptimeS } = r;
  if (
    r['v'] !== 1 ||
    r['kdf'] !== 'scrypt' ||
    !isScryptParams(params) ||
    typeof salt !== 'string' ||
    base64Bytes(salt) < SALT_LENGTH ||
    typeof hash !== 'string' ||
    base64Bytes(hash) !== KEY_LENGTH ||
    !isCount(failures) ||
    !isInstant(failureAtMs) ||
    !isInstant(failureUptimeS) ||
    (failures === 0) !== (failureAtMs === null) ||
    (failures === 0) !== (failureUptimeS === null)
  ) {
    return null;
  }
  return {
    v: 1,
    kdf: 'scrypt',
    params: { N: params.N, r: params.r, p: params.p },
    salt,
    hash,
    failures,
    failureAtMs,
    failureUptimeS,
  };
}
