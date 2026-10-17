/**
 * The main-only PIN store: {@link PinVerifier} with its encrypted record file, clock and
 * status. The pure rules it applies live in `./app-lock-pin`. Only an `import type` of
 * `electron`, so it runs in plain Node tests.
 * Nothing here logs, and no error or outcome carries the PIN, its hash or its salt.
 */
import * as fs from 'node:fs';
import { uptime } from 'node:os';
import * as path from 'node:path';
import type { SafeStorage } from 'electron';
import {
  attemptAllowed,
  checkPin,
  createPinRecord,
  decodePinRecord,
  encodePinRecord,
  isValidPin,
  nextAttemptAt,
  type PinCheck,
  type PinClock,
  type PinRecord,
  type ScryptParams,
} from './app-lock-pin';
import { atomicWriteFile, secureStorageUsable } from './secure-store';

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
 * new PIN over it would skip the full reset, so `set` refuses it. Only {@link clear} removes
 * it: the full reset, turning the lock off, and Settings, which the renderer allows only
 * while App lock is readably off or after a fresh system-prompt check (`AppLockService`
 * `clearUnreadablePin` and `changePin`). Without usable
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

  /** Remove the record, readable or not; the way past a damaged file (see the class doc). */
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
