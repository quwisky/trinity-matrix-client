import { describe, expect, it } from 'vitest';
import type { SafeStorage } from 'electron';
import {
  secureStoreDelete,
  secureStoreGet,
  secureStoreSet,
  type SecureStoreIo,
} from './secure-store';

const FILE = '/virtual/trinity-secure-store.json';

/**
 * A fake `safeStorage` whose encrypt/decrypt is a reversible round-trip:
 * `encryptString` prefixes the plaintext, `decryptString` strips it (and throws
 * on anything that wasn't produced by `encryptString`, mirroring a decrypt failure).
 */
function makeSafeStorage(available = true): SafeStorage {
  const PREFIX = 'enc:';
  return {
    isEncryptionAvailable: () => available,
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

    expect(secureStoreSet(safeStorage, FILE, 'token', 'sekret', io)).toBe(false);
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
      JSON.stringify({ token: Buffer.from('garbage', 'utf8').toString('base64') }),
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
