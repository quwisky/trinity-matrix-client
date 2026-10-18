import { Injectable, inject } from '@angular/core';
import {
  deleteWrappingKey,
  loadWrappingKey,
  saveWrappingKey,
} from './crypto-store-wrapping-keys';
import { SecureStorageService } from './secure-storage.service';

/** What reading a store key found; see {@link CryptoStoreKeyService.read}. */
export type StoreKeyRead =
  | { readonly kind: 'missing' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'present'; readonly key: Uint8Array };

const MISSING: StoreKeyRead = { kind: 'missing' };
const UNAVAILABLE: StoreKeyRead = { kind: 'unavailable' };

/** Per-store key in secure storage: `${STORE_KEY_PREFIX}${cryptoPrefix}`. */
const STORE_KEY_PREFIX = 'matrix.cryptoStoreKey:';
/** matrix-js-sdk takes exactly 32 bytes as `initRustCrypto({ storageKey })`. */
const STORE_KEY_BYTES = 32;
const IV_BYTES = 12;

/**
 * The key that encrypts an account's Rust crypto store at rest (its device identity, room
 * keys, cross-signing keys and backup key). One random key per store, named by the store's
 * `cryptoPrefix`, created when the account binds that store and deleted with it.
 *
 * Electron, Android and iOS keep it in the OS keychain or keystore through
 * {@link SecureStorageService}. The web has no such store, so there the key is wrapped
 * with a non-extractable AES-GCM key held in IndexedDB and only the wrapped form goes to
 * secure storage. That keeps the raw key out of script-readable storage, and deleting the
 * wrapping key makes the store unreadable. It does not help against someone who can read
 * the whole browser profile from disk, where the wrapping key also sits, nor against script
 * running in the app's origin, which can ask WebCrypto to unwrap it.
 */
@Injectable({ providedIn: 'root' })
export class CryptoStoreKeyService {
  private readonly secure = inject(SecureStorageService);

  /**
   * Create and persist a fresh key for the store `cryptoPrefix`. Refuses a store that has
   * a key, or may have one: replacing it would lock its account out of its own store.
   */
  async create(cryptoPrefix: string): Promise<Uint8Array> {
    if (
      (await this.secure.read(STORE_KEY_PREFIX + cryptoPrefix)).kind !==
      'absent'
    ) {
      throw new Error(`The crypto store ${cryptoPrefix} already has a key.`);
    }
    const key = crypto.getRandomValues(new Uint8Array(STORE_KEY_BYTES));
    let savedWrappingKey = false;
    try {
      let stored: string;
      if (await this.secure.isSecure()) {
        stored = toBase64(key);
      } else {
        const wrappingKey = await crypto.subtle.generateKey(
          { name: 'AES-GCM', length: 256 },
          false,
          ['encrypt', 'decrypt'],
        );
        await saveWrappingKey(cryptoPrefix, wrappingKey);
        savedWrappingKey = true;
        stored = await seal(wrappingKey, key);
      }
      await this.secure.set(STORE_KEY_PREFIX + cryptoPrefix, stored);
    } catch (error) {
      // A wrapping key left behind would make every retry of this store refuse. Only
      // this call's own: a refused save means the one there belongs to someone else.
      if (savedWrappingKey) {
        await deleteWrappingKey(cryptoPrefix).catch(() => undefined);
      }
      throw error;
    }
    return key;
  }

  /**
   * The store's key: `present`; `missing` when there is no usable key (no entry, or a web
   * key whose wrapping key is gone or does not fit), meaning the key is lost; or
   * `unavailable` when it may exist but cannot be reached now (a locked or denied
   * keychain, an IndexedDB error). Only `missing` may lead to replacing the store;
   * `unavailable` must be retried.
   */
  async read(cryptoPrefix: string): Promise<StoreKeyRead> {
    const stored = await this.secure.read(STORE_KEY_PREFIX + cryptoPrefix);
    if (stored.kind !== 'present') {
      return stored.kind === 'absent' ? MISSING : UNAVAILABLE;
    }
    try {
      if (await this.secure.isSecure()) {
        return { kind: 'present', key: fromBase64(stored.value) };
      }
    } catch {
      return UNAVAILABLE;
    }
    let wrappingKey: CryptoKey | undefined;
    try {
      wrappingKey = await loadWrappingKey(cryptoPrefix);
    } catch {
      return UNAVAILABLE;
    }
    if (!wrappingKey) {
      return MISSING;
    }
    try {
      return { kind: 'present', key: await unwrap(wrappingKey, stored.value) };
    } catch {
      return MISSING;
    }
  }

  /** Delete the store's key (and, on the web, its wrapping key). */
  async remove(cryptoPrefix: string): Promise<void> {
    await this.secure.remove(STORE_KEY_PREFIX + cryptoPrefix);
    if (!(await this.secure.isSecure())) {
      await deleteWrappingKey(cryptoPrefix);
    }
  }
}

async function seal(
  wrappingKey: CryptoKey,
  key: Uint8Array<ArrayBuffer>,
): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    wrappingKey,
    key,
  );
  return toBase64(new Uint8Array([...iv, ...new Uint8Array(sealed)]));
}

async function unwrap(
  wrappingKey: CryptoKey,
  stored: string,
): Promise<Uint8Array> {
  const bytes = fromBase64(stored);
  const key = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: bytes.subarray(0, IV_BYTES) },
    wrappingKey,
    bytes.subarray(IV_BYTES),
  );
  return new Uint8Array(key);
}

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
