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
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createPinRecord,
  decodePinRecord,
  encodePinRecord,
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

const FAILURE_AT = 1_700_000_000_000;
const FAILURE_UPTIME = 5_000;
// Fast parameters for tests only; production uses PRODUCTION_SCRYPT.
const FAST = { N: 1024, r: 8, p: 1 } as const;

/** Let other queued work run, as a real keychain or keyring call does. */
const yieldTurn = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/** Electron's deprecated sync `encryptString` wrote this prefix; `encryptStringAsync` the other. */
const LEGACY = 'enc:';
const CURRENT = 'enc2:';

/** A file's content as the given format writes `plain`. */
function sealed(plain: string, prefix = CURRENT): string {
  return Buffer.from(
    `${prefix}${Buffer.from(plain).toString('base64')}`,
  ).toString('base64');
}

/** The plaintext of a fake ciphertext, in either format. */
function unseal(cipher: Buffer): { result: string; shouldReEncrypt: boolean } {
  const text = cipher.toString();
  const legacy = text.startsWith(LEGACY);
  if (!legacy && !text.startsWith(CURRENT)) throw new Error('decrypt failed');
  const body = text.slice(legacy ? LEGACY.length : CURRENT.length);
  return {
    result: Buffer.from(body, 'base64').toString(),
    shouldReEncrypt: legacy,
  };
}

/** Async-only, so a call to a deprecated sync method fails the test. */
function fakeSafeStorage(backend = 'gnome_libsecret') {
  return {
    isAsyncEncryptionAvailable: async () => {
      await yieldTurn();
      return true;
    },
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (plain: string) => {
      await yieldTurn();
      return Buffer.from(`${CURRENT}${Buffer.from(plain).toString('base64')}`);
    },
    decryptStringAsync: async (cipher: Buffer) => {
      await yieldTurn();
      return unseal(cipher);
    },
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
  return decodePinRecord(unseal(Buffer.from(stored, 'base64')).result);
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
    expect(await pins.status()).toEqual({
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
    expect(await pins.status()).toEqual({
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
    expect(await restarted.status()).toEqual({
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
    expect(await pins.status()).toEqual({ kind: 'not-supported' });
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
      isAsyncEncryptionAvailable: async () => false,
    });
    expect(await pins.status()).toEqual({ kind: 'not-supported' });
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
        { ...fakeSafeStorage(), isAsyncEncryptionAvailable: async () => false },
      ],
    ];

    it.each(unusable)(
      '%s with a PIN file is unavailable',
      async (_name, safeStorage) => {
        setPlatform('linux');
        const io = memoryIo();
        const stored = sealed(
          encodePinRecord(await createPinRecord('482913', FAST)),
        );
        io.files.set(file, stored);
        const pins = verifier(io, safeStorage);
        expect(await pins.status()).toEqual({ kind: 'unavailable' });
        await expect(pins.set('135790')).resolves.toBe('unavailable');
        await expect(pins.verify('482913')).resolves.toEqual({
          kind: 'unavailable',
        });
        expect(io.files.get(file)).toBe(stored);
      },
    );

    it.each(unusable)(
      '%s with a file it cannot check is unavailable',
      async (_name, safeStorage) => {
        setPlatform('linux');
        const io: PinFileIo = {
          ...memoryIo(),
          read: () => {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          },
        };
        expect(await verifier(io, safeStorage).status()).toEqual({
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
    expect(await pins.status()).toEqual({ kind: 'unavailable' });
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
          decryptStringAsync: () =>
            Promise.reject(new Error('keychain says no')),
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
      const stored = sealed(plain);
      io.files.set(file, stored);
      const pins = verifier(wrap(io), safeStorage);

      expect(await pins.status()).toEqual({ kind: 'unavailable' });
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
      expect(await pins.status()).toEqual({
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
    const answers: unknown[] = [await pins.status(), await pins.set('482913')];
    const record = storedRecord(io.files.get(file));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      answers.push(await pins.verify('271828'));
    }
    answers.push(
      await pins.status(),
      await pins.verify('482913'),
      pins.clear(),
    );
    const output = [
      JSON.stringify(answers),
      ...spies.flatMap((spy) => spy.mock.calls.flat()).map(String),
    ].join('\n');
    expect(record === null).toBe(false);
    for (const secret of ['482913', '271828', record?.salt, record?.hash]) {
      expect(output.includes(secret ?? '482913')).toBe(false);
    }
  });

  describe('on the async safeStorage api', () => {
    it('reads a record the sync api wrote, and re-encrypts it on the next attempt', async () => {
      const io = memoryIo();
      const legacy = sealed(
        encodePinRecord(await createPinRecord('482913', FAST)),
        LEGACY,
      );
      io.files.set(file, legacy);
      const pins = verifier(io);

      expect(await pins.status()).toEqual({
        kind: 'ready',
        set: true,
        nextAttemptAt: null,
      });
      expect(io.files.get(file)).toBe(legacy);
      await expect(pins.verify('12')).resolves.toEqual({ kind: 'invalid' });
      const stored = io.files.get(file) ?? '';
      expect(Buffer.from(stored, 'base64').toString().startsWith(CURRENT)).toBe(
        true,
      );
      expect(storedRecord(stored)?.failures).toBe(0);
      await expect(pins.verify('482913')).resolves.toEqual({
        kind: 'verified',
      });
    });

    it('still answers an attempt on a legacy record whose re-encryption fails', async () => {
      const io = memoryIo();
      const legacy = sealed(
        encodePinRecord(await createPinRecord('482913', FAST)),
        LEGACY,
      );
      io.files.set(file, legacy);
      const pins = verifier({
        ...io,
        write: () => {
          throw new Error('ENOSPC');
        },
      });

      await expect(pins.verify('12')).resolves.toEqual({ kind: 'invalid' });
      expect(io.files.get(file)).toBe(legacy);
    });

    it('never stores a PIN cleared while its record was being encrypted', async () => {
      const io = memoryIo();
      const safeStorage = fakeSafeStorage();
      const pins = verifier(io, {
        ...safeStorage,
        encryptStringAsync: async (plain: string) => {
          pins.clear();
          return safeStorage.encryptStringAsync(plain);
        },
      });

      await expect(pins.set('482913')).resolves.toBe('unavailable');
      expect(io.files.has(file)).toBe(false);
    });

    it('reports no PIN when a reset lands while the status is decrypting', async () => {
      const io = memoryIo();
      const safeStorage = fakeSafeStorage();
      await verifier(io, safeStorage).set('482913');
      let cleared = false;
      const pins = verifier(io, {
        ...safeStorage,
        decryptStringAsync: async (cipher: Buffer) => {
          if (!cleared) {
            cleared = true;
            pins.clear();
          }
          return safeStorage.decryptStringAsync(cipher);
        },
      });

      expect(await pins.status()).toEqual({
        kind: 'ready',
        set: false,
        nextAttemptAt: null,
      });
    });

    it('reads an availability check that fails as no PIN store', async () => {
      const io = memoryIo();
      const pins = verifier(io, {
        ...fakeSafeStorage(),
        isAsyncEncryptionAvailable: () =>
          Promise.reject(new Error('not ready')),
      });

      expect(await pins.status()).toEqual({ kind: 'not-supported' });
      await expect(pins.set('482913')).resolves.toBe('unavailable');
      expect(io.files.size).toBe(0);
    });
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
      expect(await pins.status()).toEqual({
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

    it('reads a file it cannot open as unreadable, not as no PIN', async () => {
      dir = mkdtempSync(join(tmpdir(), 'trinity-pin-'));
      // A directory where the file should be: readFileSync fails with EISDIR.
      mkdirSync(join(dir, PIN_FILE_NAME));
      writeFileSync(join(dir, PIN_FILE_NAME, 'x'), 'x');
      const pins = new PinVerifier({
        safeStorage: fakeSafeStorage() as never,
        file: join(dir, PIN_FILE_NAME),
        params: FAST,
      });
      expect(await pins.status()).toEqual({ kind: 'unavailable' });
    });
  });
});
