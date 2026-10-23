import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SafeStorage } from 'electron';
import {
  atomicWriteFile,
  secureStorageUsable,
  secureStoreDelete,
  secureStoreGet,
  secureStoreRead,
  secureStoreSet,
  type SecureStoreIo,
} from './secure-store';

const FILE = '/virtual/trinity-secure-store.json';

/** What Electron's deprecated sync `encryptString` wrote: the format every existing store holds. */
const LEGACY = 'enc:';
/** What `encryptStringAsync` writes. */
const CURRENT = 'enc2:';

/** Let other queued work run, as a real keychain or keyring call does. */
const yieldTurn = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A fake async `safeStorage` with a reversible round-trip. It decrypts both the current
 * prefix and the legacy one, the way `decryptStringAsync` reads `encryptString` output,
 * and asks for a legacy value to be re-encrypted. It throws on anything else, as a failed
 * decrypt does. It has no sync methods, so a call to one fails the test.
 */
function makeSafeStorage(
  available = true,
  backend = 'gnome_libsecret',
): SafeStorage {
  return {
    isAsyncEncryptionAvailable: async () => {
      await yieldTurn();
      return available;
    },
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (plain: string) => {
      await yieldTurn();
      return Buffer.from(CURRENT + plain, 'utf8');
    },
    decryptStringAsync: async (buf: Buffer) => {
      await yieldTurn();
      const text = buf.toString('utf8');
      if (text.startsWith(CURRENT)) {
        return { result: text.slice(CURRENT.length), shouldReEncrypt: false };
      }
      if (text.startsWith(LEGACY)) {
        return { result: text.slice(LEGACY.length), shouldReEncrypt: true };
      }
      throw new Error('decrypt failed');
    },
  } as unknown as SafeStorage;
}

/** A store entry as the sync API wrote it before Electron 45. */
const legacyEntry = (plain: string): string =>
  Buffer.from(LEGACY + plain, 'utf8').toString('base64');

/** In-memory stand-in for the on-disk store file so tests never touch disk. */
function makeIo(): { io: SecureStoreIo; files: Map<string, string> } {
  const files = new Map<string, string>();
  const io: SecureStoreIo = {
    readFile: (filePath) => {
      if (!files.has(filePath)) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return files.get(filePath)!;
    },
    writeFile: (filePath, data) => {
      files.set(filePath, data);
    },
    renameFile: (from, to) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
  };
  return { io, files };
}

describe('secure store', () => {
  it('round-trips a value through set -> get and stores ciphertext, not plaintext', async () => {
    const safeStorage = makeSafeStorage(true);
    const { io, files } = makeIo();

    expect(await secureStoreSet(safeStorage, FILE, 'token', 'sekret', io)).toBe(
      true,
    );
    expect(await secureStoreGet(safeStorage, FILE, 'token', io)).toBe('sekret');
    // The persisted file holds the encoded ciphertext, never the raw secret.
    expect(files.get(FILE)).not.toContain('sekret');
  });

  it('when encryption is unavailable: set returns false, get returns null, nothing is written', async () => {
    const safeStorage = makeSafeStorage(false);
    const { io, files } = makeIo();

    expect(await secureStoreSet(safeStorage, FILE, 'token', 'sekret', io)).toBe(
      false,
    );
    expect(await secureStoreGet(safeStorage, FILE, 'token', io)).toBeNull();
    expect(files.has(FILE)).toBe(false);
  });

  it('returns null (no throw) for a missing store file', async () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();

    expect(await secureStoreGet(safeStorage, FILE, 'token', io)).toBeNull();
  });

  it('returns null (no throw) for a corrupt, non-JSON store file', async () => {
    const safeStorage = makeSafeStorage(true);
    const { io, files } = makeIo();
    files.set(FILE, 'this is not json {{{');

    expect(await secureStoreGet(safeStorage, FILE, 'token', io)).toBeNull();
  });

  it('returns null when the stored entry cannot be decrypted', async () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();
    // A well-formed JSON map whose value is not valid ciphertext.
    io.writeFile(
      FILE,
      JSON.stringify({
        token: Buffer.from('garbage', 'utf8').toString('base64'),
      }),
    );

    expect(await secureStoreGet(safeStorage, FILE, 'token', io)).toBeNull();
  });

  it('delete removes only the target key and persists the rest', async () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();

    await secureStoreSet(safeStorage, FILE, 'a', 'AAA', io);
    await secureStoreSet(safeStorage, FILE, 'b', 'BBB', io);

    await secureStoreDelete(FILE, 'a', io);

    expect(await secureStoreGet(safeStorage, FILE, 'a', io)).toBeNull();
    expect(await secureStoreGet(safeStorage, FILE, 'b', io)).toBe('BBB');
  });

  it('delete is a no-op for an absent key', async () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();
    await secureStoreSet(safeStorage, FILE, 'a', 'AAA', io);

    await expect(secureStoreDelete(FILE, 'missing', io)).resolves.toBe(true);
    expect(await secureStoreGet(safeStorage, FILE, 'a', io)).toBe('AAA');
  });
});

describe('secure store writes over an unreadable file', () => {
  /** An io whose next reads fail with `code`, as a file locked by another process does. */
  function failingReads(code: string) {
    const { io, files } = makeIo();
    let failing = false;
    let writes = 0;
    const flaky: SecureStoreIo = {
      readFile: (filePath) => {
        if (failing) {
          const err = new Error(code) as NodeJS.ErrnoException;
          err.code = code;
          throw err;
        }
        return io.readFile(filePath);
      },
      writeFile: (filePath, data) => {
        writes++;
        io.writeFile(filePath, data);
      },
      renameFile: io.renameFile,
    };
    return {
      io: flaky,
      files,
      fail: () => {
        failing = true;
        writes = 0;
      },
      writes: () => writes,
    };
  }

  it.each(['EBUSY', 'EPERM', 'EIO'])(
    'set refuses to write after a %s read and keeps every entry',
    async (code) => {
      const safeStorage = makeSafeStorage(true);
      const store = failingReads(code);
      await secureStoreSet(
        safeStorage,
        FILE,
        'matrix.cryptoStoreKey:a',
        'K1',
        store.io,
      );
      const before = store.files.get(FILE);
      store.fail();

      expect(
        await secureStoreSet(
          safeStorage,
          FILE,
          'matrix.accessToken:@a:hs',
          'T',
          store.io,
        ),
      ).toBe(false);
      expect(store.writes()).toBe(0);
      expect(store.files.get(FILE)).toBe(before);
    },
  );

  it.each(['', '  \n'])(
    'reads an empty file (%j) as an empty store, and set works',
    async (text) => {
      const safeStorage = makeSafeStorage(true);
      const { io, files } = makeIo();
      files.set(FILE, text);

      expect(await secureStoreRead(safeStorage, FILE, 'a', io)).toEqual({
        kind: 'absent',
      });
      expect(await secureStoreSet(safeStorage, FILE, 'b', 'BBB', io)).toBe(
        true,
      );
      expect(await secureStoreGet(safeStorage, FILE, 'b', io)).toBe('BBB');
      expect([...files.keys()]).toEqual([FILE]);
    },
  );

  it.each([
    ['a truncated file', '{"matrix.cryptoStoreKey:a":"ZW5jOk'],
    ['garbage', 'this is not json {{{'],
    ['a JSON array', '["a"]'],
  ])(
    'set moves %s aside, then starts from an empty store',
    async (_case, text) => {
      const safeStorage = makeSafeStorage(true);
      const { io, files } = makeIo();
      files.set(FILE, text);
      const warn = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => undefined);

      expect(await secureStoreSet(safeStorage, FILE, 'b', 'BBB', io)).toBe(
        true,
      );

      const aside = [...files.keys()].filter((name) => name !== FILE);
      expect(aside).toHaveLength(1);
      expect(aside[0]).toMatch(
        /^\/virtual\/trinity-secure-store\.json\.corrupt-\d+$/,
      );
      expect(files.get(aside[0])).toBe(text);
      expect(JSON.parse(files.get(FILE)!)).toEqual({
        b: expect.any(String),
      });
      expect(warn).toHaveBeenCalledOnce();
      warn.mockRestore();
    },
  );

  it('set refuses to write when an unparseable file cannot be moved aside', async () => {
    const safeStorage = makeSafeStorage(true);
    const { io, files } = makeIo();
    files.set(FILE, 'garbage');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const stuck: SecureStoreIo = {
      ...io,
      renameFile: () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
      },
    };

    expect(await secureStoreSet(safeStorage, FILE, 'b', 'BBB', stuck)).toBe(
      false,
    );
    expect(files.get(FILE)).toBe('garbage');
    vi.mocked(console.warn).mockRestore();
  });

  it('delete refuses to write after a failed read and keeps every entry', async () => {
    const safeStorage = makeSafeStorage(true);
    const store = failingReads('EBUSY');
    await secureStoreSet(safeStorage, FILE, 'a', 'AAA', store.io);
    await secureStoreSet(safeStorage, FILE, 'b', 'BBB', store.io);
    const before = store.files.get(FILE);
    store.fail();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await secureStoreDelete(FILE, 'a', store.io)).toBe(false);
    expect(store.writes()).toBe(0);
    expect(store.files.get(FILE)).toBe(before);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('delete leaves an unparseable file where it is', async () => {
    const { io, files } = makeIo();
    files.set(FILE, 'garbage');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await secureStoreDelete(FILE, 'a', io)).toBe(false);
    expect([...files.entries()]).toEqual([[FILE, 'garbage']]);
    vi.mocked(console.warn).mockRestore();
  });

  it('delete reports a removed or absent key as done', async () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();
    await secureStoreSet(safeStorage, FILE, 'a', 'AAA', io);

    expect(await secureStoreDelete(FILE, 'a', io)).toBe(true);
    expect(await secureStoreDelete(FILE, 'missing', io)).toBe(true);
  });
});

describe('atomicWriteFile', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trinity-secure-store-'));
    dirs.push(dir);
    return dir;
  }

  it('replaces the file with owner-only permissions', () => {
    const file = path.join(tempDir(), 'store.json');
    fs.writeFileSync(file, '{"old":"1"}', { mode: 0o600 });

    atomicWriteFile(file, '{"new":"2"}');

    expect(fs.readFileSync(file, 'utf8')).toBe('{"new":"2"}');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it('leaves the old file intact and no temp file when the write fails before the rename', () => {
    const dir = tempDir();
    const file = path.join(dir, 'store.json');
    fs.writeFileSync(file, '{"old":"1"}', { mode: 0o600 });
    const failingFs = {
      ...fs,
      writeSync: () => {
        throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      },
    } as typeof fs;

    expect(() => atomicWriteFile(file, '{"new":"2"}', failingFs)).toThrow(
      'ENOSPC',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe('{"old":"1"}');
    expect(fs.readdirSync(dir)).toEqual(['store.json']);
  });
});

/**
 * On Linux with no OS password manager, Electron selects the `basic_text` backend,
 * which "encrypts" with a hardcoded key — obfuscation, not encryption — while
 * isEncryptionAvailable() still returns true. Storing a Matrix access token (and the
 * cross-signing keys) under that is a false promise, so refuse it and let the caller
 * fall back to unprotected storage, which it asks consent for and warns about.
 */
describe('secureStoreRead', () => {
  /** A store holding one encrypted `token` entry. */
  async function storeWithToken(): Promise<SecureStoreIo> {
    const { io } = makeIo();
    await secureStoreSet(makeSafeStorage(true), FILE, 'token', 'sekret', io);
    return io;
  }

  it('reads a present entry', async () => {
    expect(
      await secureStoreRead(
        makeSafeStorage(true),
        FILE,
        'token',
        await storeWithToken(),
      ),
    ).toEqual({ kind: 'present', value: 'sekret' });
  });

  it('says absent only when there is no entry, keyring or not', async () => {
    const { io } = makeIo();

    expect(
      await secureStoreRead(makeSafeStorage(true), FILE, 'token', io),
    ).toEqual({
      kind: 'absent',
    });
    expect(
      await secureStoreRead(makeSafeStorage(false), FILE, 'token', io),
    ).toEqual({
      kind: 'absent',
    });
  });

  it('says unavailable, not absent, for an entry while OS encryption is unavailable', async () => {
    // A Linux keyring that is not unlocked yet: the entry is there and will read later.
    expect(
      await secureStoreRead(
        makeSafeStorage(false),
        FILE,
        'token',
        await storeWithToken(),
      ),
    ).toEqual({ kind: 'unavailable' });
  });

  it.each([
    [
      'cannot be read (EACCES)',
      (): string => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
    ],
    ['is not JSON', (): string => 'not json {{{'],
    ['is JSON but not a map', (): string => '"text"'],
  ])(
    'says unavailable, not absent, when the store file %s',
    async (_case, readFile) => {
      const io: SecureStoreIo = {
        readFile,
        writeFile: () => undefined,
        renameFile: () => undefined,
      };

      expect(
        await secureStoreRead(makeSafeStorage(true), FILE, 'token', io),
      ).toEqual({ kind: 'unavailable' });
    },
  );

  it('says unavailable for an entry that cannot be decrypted right now', async () => {
    const { io } = makeIo();
    io.writeFile(
      FILE,
      JSON.stringify({
        token: Buffer.from('garbage', 'utf8').toString('base64'),
      }),
    );

    expect(
      await secureStoreRead(makeSafeStorage(true), FILE, 'token', io),
    ).toEqual({
      kind: 'unavailable',
    });
  });
});

describe('secureStorageUsable (Linux backend gate)', () => {
  const realPlatform = process.platform;
  const setPlatform = (platform: NodeJS.Platform): void => {
    Object.defineProperty(process, 'platform', {
      value: platform,
      configurable: true,
    });
  };
  afterEach(() => setPlatform(realPlatform));

  it('refuses the obfuscation-only basic_text backend on Linux', async () => {
    setPlatform('linux');
    expect(await secureStorageUsable(makeSafeStorage(true, 'basic_text'))).toBe(
      false,
    );
  });

  it('refuses an unknown Linux backend', async () => {
    setPlatform('linux');
    expect(await secureStorageUsable(makeSafeStorage(true, 'unknown'))).toBe(
      false,
    );
  });

  it('accepts a real Linux keyring', async () => {
    setPlatform('linux');
    expect(
      await secureStorageUsable(makeSafeStorage(true, 'gnome_libsecret')),
    ).toBe(true);
  });

  it('does not consult the backend off Linux, where the keychain is real', async () => {
    setPlatform('darwin');
    expect(await secureStorageUsable(makeSafeStorage(true, 'basic_text'))).toBe(
      true,
    );
  });

  it('still refuses when encryption is unavailable at all', async () => {
    setPlatform('linux');
    expect(await secureStorageUsable(makeSafeStorage(false))).toBe(false);
  });
});

describe('secure store on the async safeStorage api', () => {
  it('reads a value the sync api wrote and re-encrypts it in place', async () => {
    const safeStorage = makeSafeStorage(true);
    const { io, files } = makeIo();
    files.set(
      FILE,
      JSON.stringify({ token: legacyEntry('sekret'), other: legacyEntry('O') }),
    );

    expect(await secureStoreRead(safeStorage, FILE, 'token', io)).toEqual({
      kind: 'present',
      value: 'sekret',
    });
    const stored = JSON.parse(files.get(FILE)!) as Record<string, string>;
    expect(Buffer.from(stored['token'], 'base64').toString()).toBe(
      `${CURRENT}sekret`,
    );
    expect(stored['other']).toBe(legacyEntry('O'));
    expect(await secureStoreGet(safeStorage, FILE, 'other', io)).toBe('O');
    expect(
      Buffer.from(
        (JSON.parse(files.get(FILE)!) as Record<string, string>)['other'],
        'base64',
      ).toString(),
    ).toBe(`${CURRENT}O`);
  });

  it('still answers a legacy value when re-encrypting it fails, and keeps it', async () => {
    const safeStorage = {
      ...makeSafeStorage(true),
      encryptStringAsync: () => Promise.reject(new Error('keychain busy')),
    } as unknown as SafeStorage;
    const { io, files } = makeIo();
    const before = JSON.stringify({ token: legacyEntry('sekret') });
    files.set(FILE, before);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await secureStoreGet(safeStorage, FILE, 'token', io)).toBe('sekret');
    expect(files.get(FILE)).toBe(before);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('sekret');
    warn.mockRestore();
  });

  it('keeps both of two concurrent sets', async () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();

    await Promise.all([
      secureStoreSet(safeStorage, FILE, 'a', 'AAA', io),
      secureStoreSet(safeStorage, FILE, 'b', 'BBB', io),
    ]);

    expect(await secureStoreGet(safeStorage, FILE, 'a', io)).toBe('AAA');
    expect(await secureStoreGet(safeStorage, FILE, 'b', io)).toBe('BBB');
  });

  it('answers a read asked after a set with the value that set wrote', async () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();
    await secureStoreSet(safeStorage, FILE, 'token', 'old', io);

    const setting = secureStoreSet(safeStorage, FILE, 'token', 'new', io);
    const reading = secureStoreRead(safeStorage, FILE, 'token', io);
    const getting = secureStoreGet(safeStorage, FILE, 'token', io);

    expect(await setting).toBe(true);
    expect(await reading).toEqual({ kind: 'present', value: 'new' });
    expect(await getting).toBe('new');
  });

  it('never brings back a key deleted while a set of another key was encrypting', async () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();
    await secureStoreSet(safeStorage, FILE, 'gone', 'G', io);

    const setting = secureStoreSet(safeStorage, FILE, 'kept', 'K', io);
    const deleting = secureStoreDelete(FILE, 'gone', io);

    expect(await setting).toBe(true);
    expect(await deleting).toBe(true);
    expect(await secureStoreRead(safeStorage, FILE, 'gone', io)).toEqual({
      kind: 'absent',
    });
    expect(await secureStoreGet(safeStorage, FILE, 'kept', io)).toBe('K');
  });

  it('rejects a set whose encryption fails, writes nothing, and serves the next call', async () => {
    const working = makeSafeStorage(true);
    const failing = {
      ...working,
      encryptStringAsync: () => Promise.reject(new Error('keychain denied')),
    } as unknown as SafeStorage;
    const { io, files } = makeIo();
    await secureStoreSet(working, FILE, 'a', 'AAA', io);
    const before = files.get(FILE);

    await expect(secureStoreSet(failing, FILE, 'b', 'BBB', io)).rejects.toThrow(
      'keychain denied',
    );
    expect(files.get(FILE)).toBe(before);
    expect(await secureStoreGet(working, FILE, 'a', io)).toBe('AAA');
  });

  it('reads an availability check that fails as unavailable', async () => {
    const safeStorage = {
      ...makeSafeStorage(true),
      isAsyncEncryptionAvailable: () => Promise.reject(new Error('no ready')),
    } as unknown as SafeStorage;
    const { io, files } = makeIo();
    files.set(FILE, JSON.stringify({ token: legacyEntry('sekret') }));

    expect(await secureStorageUsable(safeStorage)).toBe(false);
    expect(await secureStoreSet(safeStorage, FILE, 'b', 'B', io)).toBe(false);
    expect(await secureStoreRead(safeStorage, FILE, 'token', io)).toEqual({
      kind: 'unavailable',
    });
    expect(await secureStoreGet(safeStorage, FILE, 'token', io)).toBeNull();
  });
});
