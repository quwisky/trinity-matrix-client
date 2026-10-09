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

/**
 * A fake `safeStorage` whose encrypt/decrypt is a reversible round-trip:
 * `encryptString` prefixes the plaintext, `decryptString` strips it (and throws
 * on anything that wasn't produced by `encryptString`, mirroring a decrypt failure).
 */
function makeSafeStorage(
  available = true,
  backend = 'gnome_libsecret',
): SafeStorage {
  const PREFIX = 'enc:';
  return {
    isEncryptionAvailable: () => available,
    getSelectedStorageBackend: () => backend,
    encryptString: (plain: string) => Buffer.from(PREFIX + plain, 'utf8'),
    decryptString: (buf: Buffer) => {
      const text = buf.toString('utf8');
      if (!text.startsWith(PREFIX)) {
        throw new Error('decrypt failed');
      }
      return text.slice(PREFIX.length);
    },
  } as unknown as SafeStorage;
}

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
  it('round-trips a value through set -> get and stores ciphertext, not plaintext', () => {
    const safeStorage = makeSafeStorage(true);
    const { io, files } = makeIo();

    expect(secureStoreSet(safeStorage, FILE, 'token', 'sekret', io)).toBe(true);
    expect(secureStoreGet(safeStorage, FILE, 'token', io)).toBe('sekret');
    // The persisted file holds the encoded ciphertext, never the raw secret.
    expect(files.get(FILE)).not.toContain('sekret');
  });

  it('when encryption is unavailable: set returns false, get returns null, nothing is written', () => {
    const safeStorage = makeSafeStorage(false);
    const { io, files } = makeIo();

    expect(secureStoreSet(safeStorage, FILE, 'token', 'sekret', io)).toBe(
      false,
    );
    expect(secureStoreGet(safeStorage, FILE, 'token', io)).toBeNull();
    expect(files.has(FILE)).toBe(false);
  });

  it('returns null (no throw) for a missing store file', () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();

    expect(() => secureStoreGet(safeStorage, FILE, 'token', io)).not.toThrow();
    expect(secureStoreGet(safeStorage, FILE, 'token', io)).toBeNull();
  });

  it('returns null (no throw) for a corrupt, non-JSON store file', () => {
    const safeStorage = makeSafeStorage(true);
    const { io, files } = makeIo();
    files.set(FILE, 'this is not json {{{');

    expect(() => secureStoreGet(safeStorage, FILE, 'token', io)).not.toThrow();
    expect(secureStoreGet(safeStorage, FILE, 'token', io)).toBeNull();
  });

  it('returns null when the stored entry cannot be decrypted', () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();
    // A well-formed JSON map whose value is not valid ciphertext.
    io.writeFile(
      FILE,
      JSON.stringify({
        token: Buffer.from('garbage', 'utf8').toString('base64'),
      }),
    );

    expect(secureStoreGet(safeStorage, FILE, 'token', io)).toBeNull();
  });

  it('delete removes only the target key and persists the rest', () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();

    secureStoreSet(safeStorage, FILE, 'a', 'AAA', io);
    secureStoreSet(safeStorage, FILE, 'b', 'BBB', io);

    secureStoreDelete(FILE, 'a', io);

    expect(secureStoreGet(safeStorage, FILE, 'a', io)).toBeNull();
    expect(secureStoreGet(safeStorage, FILE, 'b', io)).toBe('BBB');
  });

  it('delete is a no-op for an absent key', () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();
    secureStoreSet(safeStorage, FILE, 'a', 'AAA', io);

    expect(() => secureStoreDelete(FILE, 'missing', io)).not.toThrow();
    expect(secureStoreGet(safeStorage, FILE, 'a', io)).toBe('AAA');
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
    (code) => {
      const safeStorage = makeSafeStorage(true);
      const store = failingReads(code);
      secureStoreSet(
        safeStorage,
        FILE,
        'matrix.cryptoStoreKey:a',
        'K1',
        store.io,
      );
      const before = store.files.get(FILE);
      store.fail();

      expect(
        secureStoreSet(
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
    (text) => {
      const safeStorage = makeSafeStorage(true);
      const { io, files } = makeIo();
      files.set(FILE, text);

      expect(secureStoreRead(safeStorage, FILE, 'a', io)).toEqual({
        kind: 'absent',
      });
      expect(secureStoreSet(safeStorage, FILE, 'b', 'BBB', io)).toBe(true);
      expect(secureStoreGet(safeStorage, FILE, 'b', io)).toBe('BBB');
      expect([...files.keys()]).toEqual([FILE]);
    },
  );

  it.each([
    ['a truncated file', '{"matrix.cryptoStoreKey:a":"ZW5jOk'],
    ['garbage', 'this is not json {{{'],
    ['a JSON array', '["a"]'],
  ])('set moves %s aside, then starts from an empty store', (_case, text) => {
    const safeStorage = makeSafeStorage(true);
    const { io, files } = makeIo();
    files.set(FILE, text);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(secureStoreSet(safeStorage, FILE, 'b', 'BBB', io)).toBe(true);

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
  });

  it('set refuses to write when an unparseable file cannot be moved aside', () => {
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

    expect(secureStoreSet(safeStorage, FILE, 'b', 'BBB', stuck)).toBe(false);
    expect(files.get(FILE)).toBe('garbage');
    vi.mocked(console.warn).mockRestore();
  });

  it('delete refuses to write after a failed read and keeps every entry', () => {
    const safeStorage = makeSafeStorage(true);
    const store = failingReads('EBUSY');
    secureStoreSet(safeStorage, FILE, 'a', 'AAA', store.io);
    secureStoreSet(safeStorage, FILE, 'b', 'BBB', store.io);
    const before = store.files.get(FILE);
    store.fail();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(secureStoreDelete(FILE, 'a', store.io)).toBe(false);
    expect(store.writes()).toBe(0);
    expect(store.files.get(FILE)).toBe(before);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('delete leaves an unparseable file where it is', () => {
    const { io, files } = makeIo();
    files.set(FILE, 'garbage');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(secureStoreDelete(FILE, 'a', io)).toBe(false);
    expect([...files.entries()]).toEqual([[FILE, 'garbage']]);
    vi.mocked(console.warn).mockRestore();
  });

  it('delete reports a removed or absent key as done', () => {
    const safeStorage = makeSafeStorage(true);
    const { io } = makeIo();
    secureStoreSet(safeStorage, FILE, 'a', 'AAA', io);

    expect(secureStoreDelete(FILE, 'a', io)).toBe(true);
    expect(secureStoreDelete(FILE, 'missing', io)).toBe(true);
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
 * take its documented plaintext fallback, which at least surfaces the anomaly.
 */
describe('secureStoreRead', () => {
  /** A store holding one encrypted `token` entry. */
  function storeWithToken(): SecureStoreIo {
    const { io } = makeIo();
    secureStoreSet(makeSafeStorage(true), FILE, 'token', 'sekret', io);
    return io;
  }

  it('reads a present entry', () => {
    expect(
      secureStoreRead(makeSafeStorage(true), FILE, 'token', storeWithToken()),
    ).toEqual({ kind: 'present', value: 'sekret' });
  });

  it('says absent only when there is no entry, keyring or not', () => {
    const { io } = makeIo();

    expect(secureStoreRead(makeSafeStorage(true), FILE, 'token', io)).toEqual({
      kind: 'absent',
    });
    expect(secureStoreRead(makeSafeStorage(false), FILE, 'token', io)).toEqual({
      kind: 'absent',
    });
  });

  it('says unavailable, not absent, for an entry while OS encryption is unavailable', () => {
    // A Linux keyring that is not unlocked yet: the entry is there and will read later.
    expect(
      secureStoreRead(makeSafeStorage(false), FILE, 'token', storeWithToken()),
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
    (_case, readFile) => {
      const io: SecureStoreIo = {
        readFile,
        writeFile: () => undefined,
        renameFile: () => undefined,
      };

      expect(secureStoreRead(makeSafeStorage(true), FILE, 'token', io)).toEqual(
        { kind: 'unavailable' },
      );
    },
  );

  it('says unavailable for an entry that cannot be decrypted right now', () => {
    const { io } = makeIo();
    io.writeFile(
      FILE,
      JSON.stringify({
        token: Buffer.from('garbage', 'utf8').toString('base64'),
      }),
    );

    expect(secureStoreRead(makeSafeStorage(true), FILE, 'token', io)).toEqual({
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

  it('refuses the obfuscation-only basic_text backend on Linux', () => {
    setPlatform('linux');
    expect(secureStorageUsable(makeSafeStorage(true, 'basic_text'))).toBe(
      false,
    );
  });

  it('refuses an unknown Linux backend', () => {
    setPlatform('linux');
    expect(secureStorageUsable(makeSafeStorage(true, 'unknown'))).toBe(false);
  });

  it('accepts a real Linux keyring', () => {
    setPlatform('linux');
    expect(secureStorageUsable(makeSafeStorage(true, 'gnome_libsecret'))).toBe(
      true,
    );
  });

  it('does not consult the backend off Linux, where the keychain is real', () => {
    setPlatform('darwin');
    expect(secureStorageUsable(makeSafeStorage(true, 'basic_text'))).toBe(true);
  });

  it('still refuses when encryption is unavailable at all', () => {
    setPlatform('linux');
    expect(secureStorageUsable(makeSafeStorage(false))).toBe(false);
  });
});
