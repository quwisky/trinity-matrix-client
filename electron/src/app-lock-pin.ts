/**
 * The Trinity PIN verifier: its pure core (format, delay schedule, clock rules and the
 * scrypt record) and the main-only store, {@link PinVerifier}. Only an `import type` of
 * `electron`, so it runs in plain Node tests. The shared fixture
 * native/app-lock/pin-policy-cases.json pins the rules for every host; change them together.
 * Nothing here logs, and no error or outcome carries the PIN, its hash or its salt.
 */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import * as fs from 'node:fs';
import { uptime } from 'node:os';
import * as path from 'node:path';
import type { SafeStorage } from 'electron';
import { atomicWriteFile, secureStorageUsable } from './secure-store';

/** 4–16 ASCII digits (spec decision 18). Unicode digits are refused, never normalised. */
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

/** The verifier record's file in `userData`; main-only, never in the secure-store map. */
export const PIN_FILE_NAME = 'app-lock.bin';

/**
 * File access, injectable so tests never touch disk. `read` returns null only for ENOENT;
 * `remove` also takes any temp file an interrupted write left beside the record.
 */
export interface PinFileIo {
  read(path: string): string | null;
  write(path: string, data: string): void;
  remove(path: string): void;
}

/** `atomicWriteFile`'s temp names for `file`: `<file>.<pid>.<ms>.tmp`. */
function isTempOf(file: string, name: string): boolean {
  const base = path.basename(file);
  return (
    name.startsWith(base) && /^\.\d+\.\d+\.tmp$/.test(name.slice(base.length))
  );
}

function removeRecord(file: string): void {
  fs.rmSync(file, { force: true });
  const dir = path.dirname(file);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const name of names) {
    if (isTempOf(file, name)) fs.rmSync(path.join(dir, name), { force: true });
  }
}

const defaultIo: PinFileIo = {
  read(file) {
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  },
  // Temp file, fsync and rename, mode 0600: a crash leaves the old record or the new one.
  write: (file, data) => atomicWriteFile(file, data),
  // A crash between the temp write and the rename leaves ciphertext the reset must take.
  remove: (file) => removeRecord(file),
};

/**
 * Wall-clock time and seconds since boot. `os.uptime()` is libuv's `uv_uptime`, which
 * counts from boot and keeps counting through sleep on every desktop: on macOS it is now
 * minus `kern.boottime` (XNU moves boottime with any wall-clock change, so setting the
 * clock does not move it), on Linux `/proc/uptime` (CLOCK_BOOTTIME, suspend included) and
 * on Windows `GetTickCount64` (sleep and hibernation included). `process.uptime()` counts
 * from this process's start and `performance.now()` stops during sleep on macOS, so
 * neither can carry a wait across a restart or a night's sleep.
 */
const systemClock = (): PinClock => ({ nowMs: Date.now(), uptimeS: uptime() });

export type PinStatus =
  | {
      readonly kind: 'ready';
      readonly set: boolean;
      readonly nextAttemptAt: number | null;
    }
  | { readonly kind: 'unavailable' }
  /** No usable encryption and no PIN file: this host cannot keep a PIN, and none was kept. */
  | { readonly kind: 'not-supported' };

export interface PinVerifierDeps {
  readonly safeStorage: SafeStorage;
  readonly file: string;
  readonly io?: PinFileIo;
  readonly clock?: () => PinClock;
  readonly params?: ScryptParams;
}

const UNAVAILABLE = { kind: 'unavailable' } as const;
const NO_STORE = { kind: 'not-supported' } as const;

/**
 * The desktop Trinity PIN: one record, encrypted with safeStorage, read and written by
 * the main process only. A record that exists but cannot be read is `unavailable`, never
 * "no PIN": treating it as absent would let a damaged file open the lock, and setting a
 * new PIN over it would skip the full reset. Only {@link clear} removes it. Without usable
 * encryption (none at all, or Linux `basic_text`) and with no file, there is no PIN store
 * (`not-supported`), so a lock that cannot be read does not ask for a PIN never set.
 *
 * `set` and `verify` run one at a time, and each saves its record before it answers, so
 * two quick submits cannot both pass a wait and a crash cannot forget a failure.
 */
export class PinVerifier {
  private readonly io: PinFileIo;
  private readonly clock: () => PinClock;
  /** Bumped by {@link clear}: work requested before a reset never writes after it. */
  private generation = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: PinVerifierDeps) {
    this.io = deps.io ?? defaultIo;
    this.clock = deps.clock ?? systemClock;
  }

  status(): PinStatus {
    if (!this.usable()) return this.exists() === false ? NO_STORE : UNAVAILABLE;
    const record = this.read();
    if (record === 'unreadable') return UNAVAILABLE;
    if (record === null)
      return { kind: 'ready', set: false, nextAttemptAt: null };
    try {
      return {
        kind: 'ready',
        set: true,
        nextAttemptAt: attemptAllowed(record, this.clock())
          ? null
          : nextAttemptAt(record),
      };
    } catch {
      return UNAVAILABLE;
    }
  }

  set(pin: unknown): Promise<'completed' | 'invalid' | 'unavailable'> {
    // Taken at request time: a set asked for before a reset never lands after it, even
    // when it waited in the queue until the reset had run.
    const generation = this.generation;
    return this.serial(async () => {
      if (!isValidPin(pin)) return 'invalid';
      if (!this.usable() || generation !== this.generation)
        return 'unavailable';
      if (this.read() === 'unreadable') return 'unavailable';
      let record: PinRecord;
      try {
        record = await createPinRecord(pin, this.deps.params);
      } catch {
        return 'unavailable';
      }
      return generation === this.generation && this.write(record)
        ? 'completed'
        : 'unavailable';
    });
  }

  verify(pin: unknown): Promise<PinCheck | { readonly kind: 'unavailable' }> {
    const generation = this.generation;
    return this.serial(async () => {
      if (!this.usable() || generation !== this.generation) return UNAVAILABLE;
      const record = this.read();
      if (record === null || record === 'unreadable') return UNAVAILABLE;
      let result: Awaited<ReturnType<typeof checkPin>>;
      try {
        result = await checkPin(record, pin, this.clock());
      } catch {
        return UNAVAILABLE;
      }
      if (generation !== this.generation) return UNAVAILABLE;
      // An attempt the record cannot keep is not answered: a failure must be counted.
      if (result.record !== record && !this.write(result.record)) {
        return UNAVAILABLE;
      }
      return result.check;
    });
  }

  /** Remove the record, readable or not; the full reset's way past a damaged file. */
  clear(): 'completed' | 'unavailable' {
    this.generation += 1;
    try {
      this.io.remove(this.deps.file);
      return 'completed';
    } catch {
      return 'unavailable';
    }
  }

  private usable(): boolean {
    try {
      return secureStorageUsable(this.deps.safeStorage);
    } catch {
      return false;
    }
  }

  /** Whether a record file is on disk, without decrypting it; null when that is unknown. */
  private exists(): boolean | null {
    try {
      return this.io.read(this.deps.file) !== null;
    } catch {
      return null;
    }
  }

  private read(): PinRecord | null | 'unreadable' {
    let stored: string | null;
    try {
      stored = this.io.read(this.deps.file);
    } catch {
      return 'unreadable';
    }
    if (stored === null) return null;
    try {
      const plain = this.deps.safeStorage.decryptString(
        Buffer.from(stored, 'base64'),
      );
      return decodePinRecord(plain) ?? 'unreadable';
    } catch {
      return 'unreadable';
    }
  }

  private write(record: PinRecord): boolean {
    try {
      const cipher = this.deps.safeStorage.encryptString(
        encodePinRecord(record),
      );
      this.io.write(this.deps.file, cipher.toString('base64'));
      return true;
    } catch {
      return false;
    }
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }
}
