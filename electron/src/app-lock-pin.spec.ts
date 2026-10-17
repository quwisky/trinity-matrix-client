import { scrypt } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir, uptime } from 'node:os';
import { join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  attemptAllowed,
  checkPin,
  createPinRecord,
  decodePinRecord,
  encodePinRecord,
  isValidPin,
  nextAttemptAt,
  waitSecondsAfter,
  type PinClock,
  type PinRecord,
} from './app-lock-pin';
import {
  PIN_FILE_NAME,
  PinVerifier,
  type PinFileIo,
} from './app-lock-pin-store';

// A pass-through spy, so tests can prove which attempts reach the key derivation.
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return { ...actual, scrypt: vi.fn(actual.scrypt) };
});
// The default clock's since-boot reading, pinned so a test can see where it comes from.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, uptime: vi.fn(actual.uptime) };
});

interface Cases {
  readonly formats: readonly { name: string; pin: string; valid: boolean }[];
  readonly delays: readonly { failures: number; waitSeconds: number }[];
  readonly attempts: readonly {
    name: string;
    failures: number;
    wallElapsedSeconds: number;
    uptimeElapsedSeconds: number;
    rebooted: boolean;
    allowed: boolean;
  }[];
}

const cases = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../native/app-lock/pin-policy-cases.json'),
    'utf8',
  ),
) as Cases;

const FAILURE_AT = 1_700_000_000_000;
const FAILURE_UPTIME = 5_000;
// Fast parameters for tests only; production uses PRODUCTION_SCRYPT.
const FAST = { N: 1024, r: 8, p: 1 } as const;
const clock = (nowMs = FAILURE_AT, uptimeS = FAILURE_UPTIME): PinClock => ({
  nowMs,
  uptimeS,
});

// Records hold a salt and a hash: compare them as booleans so a failure prints neither.
const sameRecord = (actual: PinRecord | null, expected: PinRecord): boolean =>
  isDeepStrictEqual(actual, expected);
const outcomeOf = (pending: Promise<PinRecord>): Promise<string> =>
  pending.then(
    () => 'stored',
    (error: unknown) => (error instanceof Error ? error.message : 'unknown'),
  );

describe('PIN policy (shared fixture)', () => {
  it.each(cases.formats)('format: $name', ({ pin, valid }) => {
    expect(isValidPin(pin)).toBe(valid);
  });

  it.each(cases.delays)(
    'waits $waitSeconds s after $failures failures',
    ({ failures, waitSeconds }) => {
      expect(waitSecondsAfter(failures)).toBe(waitSeconds);
    },
  );

  it.each(cases.attempts)(
    'attempt: $name',
    ({
      failures,
      wallElapsedSeconds,
      uptimeElapsedSeconds,
      rebooted,
      allowed,
    }) => {
      expect(
        attemptAllowed(
          {
            failures,
            failureAtMs: failures > 0 ? FAILURE_AT : null,
            failureUptimeS: failures > 0 ? FAILURE_UPTIME : null,
          },
          clock(
            FAILURE_AT + wallElapsedSeconds * 1000,
            rebooted ? 3 : FAILURE_UPTIME + uptimeElapsedSeconds,
          ),
        ),
      ).toBe(allowed);
    },
  );
});

describe('PIN records', () => {
  afterEach(() => vi.restoreAllMocks());

  it('stores a salted hash, never the PIN', async () => {
    const first = await createPinRecord('482913', FAST);
    const second = await createPinRecord('482913', FAST);
    const text = encodePinRecord(first);
    expect(text.includes('482913')).toBe(false);
    expect(first.salt === second.salt).toBe(false);
    expect(first.hash === second.hash).toBe(false);
    expect(sameRecord(decodePinRecord(text), first)).toBe(true);
  });

  it('verifies the right PIN and resets the count', async () => {
    let record: PinRecord = {
      ...(await createPinRecord('482913', FAST)),
      failures: 3,
      failureAtMs: FAILURE_AT,
      failureUptimeS: FAILURE_UPTIME,
    };
    const result = await checkPin(record, '482913', clock());
    record = result.record;
    expect(result.check).toEqual({ kind: 'verified' });
    expect(record.failures).toBe(0);
    expect(record.failureAtMs).toBeNull();
  });

  it('counts failures and starts a wait after the fifth', async () => {
    let record = await createPinRecord('482913', FAST);
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const result = await checkPin(record, '000000', clock());
      record = result.record;
      expect(result.check).toEqual({ kind: 'failed', nextAttemptAt: null });
    }
    const fifth = await checkPin(record, '000000', clock());
    expect(fifth.check).toEqual({
      kind: 'failed',
      nextAttemptAt: FAILURE_AT + 30_000,
    });
    const during = await checkPin(
      fifth.record,
      '482913',
      clock(FAILURE_AT + 5_000, FAILURE_UPTIME + 5),
    );
    expect(during.check).toEqual({
      kind: 'delayed',
      nextAttemptAt: FAILURE_AT + 30_000,
    });
    expect(sameRecord(during.record, fifth.record)).toBe(true);
    expect(nextAttemptAt(fifth.record)).toBe(FAILURE_AT + 30_000);
  });

  it('refuses a malformed PIN without counting it or hashing it', async () => {
    const record = await createPinRecord('482913', FAST);
    for (const pin of ['12', '١٢٣٤', 4829, null]) {
      const result = await checkPin(record, pin, clock());
      expect(result.check).toEqual({ kind: 'invalid' });
      expect(result.record === record).toBe(true);
    }
  });

  it.each(cases.formats.filter(({ valid }) => !valid))(
    'refuses the $name format before the key derivation',
    async ({ pin }) => {
      const record = await createPinRecord('482913', FAST);
      vi.mocked(scrypt).mockClear();
      const result = await checkPin(record, pin, clock());
      expect(result.check).toEqual({ kind: 'invalid' });
      expect(result.record === record).toBe(true);
      expect(scrypt).not.toHaveBeenCalled();
    },
  );

  it('hashes a well-formed attempt, but not one made during a wait', async () => {
    const record = await createPinRecord('482913', FAST);
    vi.mocked(scrypt).mockClear();
    await checkPin(record, '000000', clock());
    expect(scrypt).toHaveBeenCalledTimes(1);

    const waiting: PinRecord = {
      ...record,
      failures: 5,
      failureAtMs: FAILURE_AT,
      failureUptimeS: FAILURE_UPTIME,
    };
    vi.mocked(scrypt).mockClear();
    const result = await checkPin(
      waiting,
      '482913',
      clock(FAILURE_AT - 3_600_000, FAILURE_UPTIME + 60),
    );
    expect(result.check).toEqual({
      kind: 'delayed',
      nextAttemptAt: FAILURE_AT + 30_000,
    });
    expect(result.record === waiting).toBe(true);
    expect(scrypt).not.toHaveBeenCalled();
  });

  it.each(cases.formats.filter(({ valid }) => !valid))(
    'will not store the $name format',
    async ({ pin }) => {
      vi.mocked(scrypt).mockClear();
      expect(await outcomeOf(createPinRecord(pin, FAST))).toBe('pin-invalid');
      expect(scrypt).not.toHaveBeenCalled();
    },
  );

  it('reports a key-derivation failure without detail', async () => {
    expect(
      await outcomeOf(createPinRecord('482913', { N: 3, r: 8, p: 1 })),
    ).toBe('pin-kdf-failed');
  });

  it.each([
    ['r of zero', { params: { N: 1024, r: 0, p: 1 } }],
    ['p of zero', { params: { N: 1024, r: 8, p: 0 } }],
    ['N above 32 bits', { params: { N: 2 ** 32 + 1024, r: 8, p: 1 } }],
    ['N beyond the memory cap', { params: { N: 2 ** 21, r: 8, p: 1 } }],
    ['a short hash', { hash: Buffer.alloc(16).toString('base64') }],
    ['a short salt', { salt: Buffer.alloc(8).toString('base64') }],
    [
      'failures without their instants',
      { failures: 5, failureAtMs: null, failureUptimeS: null },
    ],
    [
      'failures without the uptime',
      { failures: 5, failureAtMs: FAILURE_AT, failureUptimeS: null },
    ],
    [
      'instants without failures',
      { failures: 0, failureAtMs: FAILURE_AT, failureUptimeS: 1 },
    ],
    [
      'a fractional count',
      { failures: 1.5, failureAtMs: FAILURE_AT, failureUptimeS: 1 },
    ],
  ])('rejects a record with %s', async (_name, change) => {
    const record = await createPinRecord('482913', FAST);
    expect(
      decodePinRecord(JSON.stringify({ ...record, ...change })) === null,
    ).toBe(true);
  });

  it('keeps a record with a running wait', async () => {
    const record: PinRecord = {
      ...(await createPinRecord('482913', FAST)),
      failures: 6,
      failureAtMs: FAILURE_AT,
      failureUptimeS: FAILURE_UPTIME,
    };
    expect(sameRecord(decodePinRecord(encodePinRecord(record)), record)).toBe(
      true,
    );
  });

  it('rejects a damaged record', () => {
    expect(decodePinRecord('{')).toBeNull();
    expect(decodePinRecord(JSON.stringify({ v: 2 }))).toBeNull();
    expect(
      decodePinRecord(
        JSON.stringify({
          v: 1,
          kdf: 'scrypt',
          params: { N: 3, r: 8, p: 1 },
          salt: 'x',
          hash: 'y',
          failures: 0,
          failureAtMs: null,
          failureUptimeS: null,
        }),
      ),
    ).toBeNull();
  });

  it('never logs the PIN', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const record = await createPinRecord('482913', FAST);
    await checkPin(record, '000000', clock());
    await checkPin(record, '482913', clock());
    const logged = spies
      .flatMap((spy) => spy.mock.calls.flat())
      .map(String)
      .join('\n');
    expect(logged.includes('482913')).toBe(false);
    expect(logged.includes(record.hash)).toBe(false);
  });
});

function fakeSafeStorage(backend = 'gnome_libsecret') {
  return {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => backend,
    encryptString: (plain: string) =>
      Buffer.from(`enc:${Buffer.from(plain).toString('base64')}`),
    decryptString: (cipher: Buffer) =>
      Buffer.from(cipher.toString().slice(4), 'base64').toString(),
  };
}

function memoryIo(): PinFileIo & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: (path) => files.get(path) ?? null,
    write: (path, data) => void files.set(path, data),
    remove: (path) => void files.delete(path),
  };
}

/** The record a fake-encrypted file holds, read back the way the verifier would. */
function storedRecord(stored: string | undefined): PinRecord | null {
  if (stored === undefined) return null;
  return decodePinRecord(
    fakeSafeStorage().decryptString(Buffer.from(stored, 'base64')),
  );
}

describe('PinVerifier', () => {
  const file = `/profile/${PIN_FILE_NAME}`;
  let now = FAILURE_AT;
  let up = FAILURE_UPTIME;
  const verifier = (io: PinFileIo, safeStorage = fakeSafeStorage()) =>
    new PinVerifier({
      safeStorage: safeStorage as never,
      file,
      io,
      clock: () => ({ nowMs: now, uptimeS: up }),
      params: FAST,
    });
  const realPlatform = process.platform;
  const setPlatform = (platform: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
  };

  afterEach(() => {
    setPlatform(realPlatform);
    vi.restoreAllMocks();
    // restoreAllMocks leaves vi.mock functions alone; mockReset restores the real uptime.
    vi.mocked(uptime).mockReset();
    now = FAILURE_AT;
    up = FAILURE_UPTIME;
  });

  it('sets, verifies and clears a PIN without storing it in the clear', async () => {
    const io = memoryIo();
    const pins = verifier(io);
    expect(pins.status()).toEqual({
      kind: 'ready',
      set: false,
      nextAttemptAt: null,
    });
    await expect(pins.set('482913')).resolves.toBe('completed');
    const stored = io.files.get(file) ?? '';
    expect(stored.includes('482913')).toBe(false);
    expect(Buffer.from(stored, 'base64').toString().includes('482913')).toBe(
      false,
    );
    expect(pins.status()).toEqual({
      kind: 'ready',
      set: true,
      nextAttemptAt: null,
    });
    await expect(pins.verify('482913')).resolves.toEqual({ kind: 'verified' });
    expect(pins.clear()).toBe('completed');
    expect(io.files.has(file)).toBe(false);
  });

  it('keeps the failure count across a restart', async () => {
    const io = memoryIo();
    await verifier(io).set('482913');
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await verifier(io).verify('000000');
    }
    const restarted = verifier(io);
    expect(restarted.status()).toEqual({
      kind: 'ready',
      set: true,
      nextAttemptAt: FAILURE_AT + 30_000,
    });
    await expect(restarted.verify('482913')).resolves.toEqual({
      kind: 'delayed',
      nextAttemptAt: FAILURE_AT + 30_000,
    });
    now += 30_000;
    up += 30;
    await expect(restarted.verify('482913')).resolves.toEqual({
      kind: 'verified',
    });
  });

  it('refuses a malformed PIN and stores nothing', async () => {
    const io = memoryIo();
    await expect(verifier(io).set('12ab')).resolves.toBe('invalid');
    expect(io.files.size).toBe(0);
  });

  it.each([
    ['four digits', '1234', 'completed'],
    ['sixteen digits', '1234567890123456', 'completed'],
    ['three digits', '123', 'invalid'],
    ['seventeen digits', '12345678901234567', 'invalid'],
    ['Arabic-Indic digits', '٤٨٢٩', 'invalid'],
    ['a number', 482913, 'invalid'],
    ['nothing', undefined, 'invalid'],
  ] as const)(
    'sets only 4 to 16 ASCII digits: %s',
    async (_name, pin, outcome) => {
      const io = memoryIo();
      await expect(verifier(io).set(pin)).resolves.toBe(outcome);
      expect(io.files.size).toBe(outcome === 'completed' ? 1 : 0);
    },
  );

  it('answers a malformed attempt as invalid without counting it', async () => {
    const io = memoryIo();
    const pins = verifier(io);
    await pins.set('482913');
    const before = io.files.get(file);
    for (const pin of ['123', '12345678901234567', '4829 13', 482913]) {
      await expect(pins.verify(pin)).resolves.toEqual({ kind: 'invalid' });
    }
    expect(io.files.get(file)).toBe(before);
  });

  it('has no PIN store without real encryption, and refuses to set one', async () => {
    setPlatform('linux');
    const io = memoryIo();
    const pins = verifier(io, fakeSafeStorage('basic_text'));
    expect(pins.status()).toEqual({ kind: 'not-supported' });
    await expect(pins.set('482913')).resolves.toBe('unavailable');
    await expect(pins.verify('482913')).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(io.files.size).toBe(0);
  });

  it('has no PIN store when safeStorage cannot encrypt at all', async () => {
    const io = memoryIo();
    const pins = verifier(io, {
      ...fakeSafeStorage(),
      isEncryptionAvailable: () => false,
    });
    expect(pins.status()).toEqual({ kind: 'not-supported' });
    await expect(pins.set('482913')).resolves.toBe('unavailable');
    expect(io.files.size).toBe(0);
  });

  describe('fails closed on a stored record without usable encryption', () => {
    const unusable: readonly (readonly [
      string,
      ReturnType<typeof fakeSafeStorage>,
    ])[] = [
      ['Linux basic_text', fakeSafeStorage('basic_text')],
      [
        'no encryption at all',
        { ...fakeSafeStorage(), isEncryptionAvailable: () => false },
      ],
    ];

    it.each(unusable)(
      '%s with a PIN file is unavailable',
      async (_name, safeStorage) => {
        setPlatform('linux');
        const io = memoryIo();
        const stored = fakeSafeStorage()
          .encryptString(encodePinRecord(await createPinRecord('482913', FAST)))
          .toString('base64');
        io.files.set(file, stored);
        const pins = verifier(io, safeStorage);
        expect(pins.status()).toEqual({ kind: 'unavailable' });
        await expect(pins.set('135790')).resolves.toBe('unavailable');
        await expect(pins.verify('482913')).resolves.toEqual({
          kind: 'unavailable',
        });
        expect(io.files.get(file)).toBe(stored);
      },
    );

    it.each(unusable)(
      '%s with a file it cannot check is unavailable',
      (_name, safeStorage) => {
        setPlatform('linux');
        const io: PinFileIo = {
          ...memoryIo(),
          read: () => {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          },
        };
        expect(verifier(io, safeStorage).status()).toEqual({
          kind: 'unavailable',
        });
      },
    );
  });

  it('answers verify with no PIN set as unavailable, never verified', async () => {
    await expect(verifier(memoryIo()).verify('482913')).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  it('treats a damaged file as unreadable, never as no PIN', async () => {
    const io = memoryIo();
    io.files.set(file, 'not base64 ciphertext');
    const pins = verifier(io);
    expect(pins.status()).toEqual({ kind: 'unavailable' });
    await expect(pins.verify('482913')).resolves.toEqual({
      kind: 'unavailable',
    });
  });

  describe('fails closed on a stored record it cannot read', () => {
    const damaged: readonly (readonly [
      string,
      (io: ReturnType<typeof memoryIo>) => PinFileIo,
      ReturnType<typeof fakeSafeStorage>,
    ])[] = [
      [
        'decryption throws',
        (io) => io,
        {
          ...fakeSafeStorage(),
          decryptString: () => {
            throw new Error('keychain says no');
          },
        },
      ],
      ['the record does not decode', (io) => io, fakeSafeStorage()],
      [
        'the file cannot be read',
        (io) => ({
          ...io,
          read: () => {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          },
        }),
        fakeSafeStorage(),
      ],
    ];

    it.each(damaged)('%s', async (_name, wrap, safeStorage) => {
      const io = memoryIo();
      const original = encodePinRecord(await createPinRecord('482913', FAST));
      // The undecodable case stores well-encrypted text that is not a record.
      const plain =
        _name === 'the record does not decode' ? '{"v":1}' : original;
      const stored = fakeSafeStorage().encryptString(plain).toString('base64');
      io.files.set(file, stored);
      const pins = verifier(wrap(io), safeStorage);

      expect(pins.status()).toEqual({ kind: 'unavailable' });
      await expect(pins.verify('482913')).resolves.toEqual({
        kind: 'unavailable',
      });
      await expect(pins.set('111111')).resolves.toBe('unavailable');
      expect(io.files.get(file)).toBe(stored);
    });

    it('lets the full reset remove it, after which a new PIN can be set', async () => {
      const io = memoryIo();
      io.files.set(file, 'not base64 ciphertext');
      const pins = verifier(io);
      expect(pins.clear()).toBe('completed');
      expect(pins.status()).toEqual({
        kind: 'ready',
        set: false,
        nextAttemptAt: null,
      });
      await expect(pins.set('482913')).resolves.toBe('completed');
    });
  });

  it('serialises attempts so two quick submits cannot both pass a wait', async () => {
    const io = memoryIo();
    const pins = verifier(io);
    await pins.set('482913');
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await pins.verify('000000');
    }
    const [fifth, sixth] = await Promise.all([
      pins.verify('111111'),
      pins.verify('482913'),
    ]);
    expect(fifth).toEqual({
      kind: 'failed',
      nextAttemptAt: FAILURE_AT + 30_000,
    });
    expect(sixth).toEqual({
      kind: 'delayed',
      nextAttemptAt: FAILURE_AT + 30_000,
    });
  });

  it('counts every one of several concurrent failures', async () => {
    const io = memoryIo();
    const pins = verifier(io);
    await pins.set('482913');
    await Promise.all(
      ['000000', '111111', '222222', '333333'].map((pin) => pins.verify(pin)),
    );
    expect(storedRecord(io.files.get(file))?.failures).toBe(4);
  });

  it('saves the attempt before it answers', async () => {
    const io = memoryIo();
    const events: string[] = [];
    const pins = verifier({
      ...io,
      write: (path, data) => {
        events.push(`write:${storedRecord(data)?.failures}`);
        io.write(path, data);
      },
    });
    await pins.set('482913');
    events.length = 0;
    await pins.verify('000000').then(() => events.push('reply'));
    await pins.verify('482913').then(() => events.push('reply'));
    expect(events).toEqual(['write:1', 'reply', 'write:0', 'reply']);
  });

  it('answers unavailable, never failed or verified, when the attempt cannot be saved', async () => {
    const io = memoryIo();
    const pins = verifier(io);
    await pins.set('482913');
    const failing = verifier({
      ...io,
      write: () => {
        throw new Error('ENOSPC');
      },
    });
    await expect(failing.verify('000000')).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(failing.verify('482913')).resolves.toEqual({
      kind: 'unavailable',
    });
    await expect(failing.set('111111')).resolves.toBe('unavailable');
    expect(storedRecord(io.files.get(file))?.failures).toBe(0);
  });

  it('answers unavailable when the key derivation fails', async () => {
    const io = memoryIo();
    const pins = verifier(io);
    await pins.set('482913');
    vi.mocked(scrypt).mockImplementationOnce(((...args: unknown[]) => {
      const callback = args.at(-1) as (error: Error | null) => void;
      callback(new Error('derivation detail'));
    }) as typeof scrypt);
    await expect(pins.verify('000000')).resolves.toEqual({
      kind: 'unavailable',
    });
    vi.mocked(scrypt).mockImplementationOnce(() => {
      throw new Error('derivation detail');
    });
    await expect(pins.set('111111')).resolves.toBe('unavailable');
    await expect(pins.verify('482913')).resolves.toEqual({ kind: 'verified' });
  });

  it('never brings back a PIN cleared while an attempt was hashing', async () => {
    const io = memoryIo();
    const pins = verifier(io);
    await pins.set('482913');
    const real = vi.mocked(scrypt).getMockImplementation()!;
    vi.mocked(scrypt).mockImplementationOnce(((...args: unknown[]) => {
      pins.clear();
      return (real as (...a: unknown[]) => void)(...args);
    }) as typeof scrypt);
    await expect(pins.verify('000000')).resolves.toEqual({
      kind: 'unavailable',
    });
    expect(io.files.has(file)).toBe(false);
  });

  it('never stores a PIN set requested before a reset, even if it starts after', async () => {
    const io = memoryIo();
    const pins = verifier(io);
    await pins.set('482913');
    // The set queues behind the check; the reset lands before either has started.
    const checking = pins.verify('000000');
    const setting = pins.set('111111');
    expect(pins.clear()).toBe('completed');
    await expect(checking).resolves.toEqual({ kind: 'unavailable' });
    await expect(setting).resolves.toBe('unavailable');
    expect(io.files.has(file)).toBe(false);
  });

  it('never stores a PIN set while the reset cleared it', async () => {
    const io = memoryIo();
    const pins = verifier(io);
    const real = vi.mocked(scrypt).getMockImplementation()!;
    vi.mocked(scrypt).mockImplementationOnce(((...args: unknown[]) => {
      pins.clear();
      return (real as (...a: unknown[]) => void)(...args);
    }) as typeof scrypt);
    await expect(pins.set('482913')).resolves.toBe('unavailable');
    expect(io.files.has(file)).toBe(false);
  });

  it('reports a file it cannot remove', () => {
    const pins = verifier({
      ...memoryIo(),
      remove: () => {
        throw new Error('EPERM');
      },
    });
    expect(pins.clear()).toBe('unavailable');
  });

  it('takes the default clock from the since-boot uptime', async () => {
    vi.mocked(uptime).mockReturnValue(123_456);
    const io = memoryIo();
    const pins = new PinVerifier({
      safeStorage: fakeSafeStorage() as never,
      file,
      io,
      params: FAST,
    });
    await pins.set('482913');
    await pins.verify('000000');
    expect(storedRecord(io.files.get(file))?.failureUptimeS).toBe(123_456);
  });

  it('leaves the real since-boot uptime to later tests', () => {
    // Runs after the test above: its pinned uptime must not have leaked.
    expect(uptime()).not.toBe(123_456);
  });

  it('never puts the PIN, salt or hash in a log or an answer', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(
      (method) => vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const io = memoryIo();
    const pins = verifier(io);
    const answers: unknown[] = [pins.status(), await pins.set('482913')];
    const record = storedRecord(io.files.get(file));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      answers.push(await pins.verify('271828'));
    }
    answers.push(pins.status(), await pins.verify('482913'), pins.clear());
    const output = [
      JSON.stringify(answers),
      ...spies.flatMap((spy) => spy.mock.calls.flat()).map(String),
    ].join('\n');
    expect(record === null).toBe(false);
    for (const secret of ['482913', '271828', record?.salt, record?.hash]) {
      expect(output.includes(secret ?? '482913')).toBe(false);
    }
  });

  describe('on disk', () => {
    let dir: string;

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('writes a 0600 file in place and reads a missing one as no PIN', async () => {
      dir = mkdtempSync(join(tmpdir(), 'trinity-pin-'));
      const pins = new PinVerifier({
        safeStorage: fakeSafeStorage() as never,
        file: join(dir, PIN_FILE_NAME),
        params: FAST,
      });
      expect(pins.status()).toEqual({
        kind: 'ready',
        set: false,
        nextAttemptAt: null,
      });
      await expect(pins.set('482913')).resolves.toBe('completed');
      expect(statSync(join(dir, PIN_FILE_NAME)).mode & 0o777).toBe(0o600);
      expect(
        readFileSync(join(dir, PIN_FILE_NAME), 'utf8').includes('482913'),
      ).toBe(false);
      await expect(pins.verify('482913')).resolves.toEqual({
        kind: 'verified',
      });
      expect(pins.clear()).toBe('completed');
      expect(pins.clear()).toBe('completed');
    });

    it('removes temp files an interrupted write left, and nothing else', async () => {
      dir = mkdtempSync(join(tmpdir(), 'trinity-pin-'));
      const record = join(dir, PIN_FILE_NAME);
      const pins = new PinVerifier({
        safeStorage: fakeSafeStorage() as never,
        file: record,
        params: FAST,
      });
      await pins.set('482913');
      const leftovers = [
        `${PIN_FILE_NAME}.4242.1700000000000.tmp`,
        `${PIN_FILE_NAME}.7.8.tmp`,
      ];
      const kept = [
        `${PIN_FILE_NAME}.bak`,
        `${PIN_FILE_NAME}.x.y.tmp`,
        'trinity-secure-store.json.1.2.tmp',
        'other.tmp',
      ];
      for (const name of [...leftovers, ...kept]) {
        writeFileSync(join(dir, name), 'x');
      }
      expect(pins.clear()).toBe('completed');
      expect(existsSync(record)).toBe(false);
      expect(leftovers.filter((name) => existsSync(join(dir, name)))).toEqual(
        [],
      );
      expect(kept.filter((name) => existsSync(join(dir, name)))).toEqual(kept);
    });

    it('clears when the profile folder does not exist', () => {
      dir = mkdtempSync(join(tmpdir(), 'trinity-pin-'));
      const pins = new PinVerifier({
        safeStorage: fakeSafeStorage() as never,
        file: join(dir, 'missing', PIN_FILE_NAME),
        params: FAST,
      });
      expect(pins.clear()).toBe('completed');
    });

    it('reads a file it cannot open as unreadable, not as no PIN', () => {
      dir = mkdtempSync(join(tmpdir(), 'trinity-pin-'));
      // A directory where the file should be: readFileSync fails with EISDIR.
      mkdirSync(join(dir, PIN_FILE_NAME));
      writeFileSync(join(dir, PIN_FILE_NAME, 'x'), 'x');
      const pins = new PinVerifier({
        safeStorage: fakeSafeStorage() as never,
        file: join(dir, PIN_FILE_NAME),
        params: FAST,
      });
      expect(pins.status()).toEqual({ kind: 'unavailable' });
    });
  });
});
