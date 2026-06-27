import type { EncryptedFileInfo } from './media.model';

/**
 * Matrix encrypted-attachment crypto (AES-CTR-256 + SHA-256 integrity), over the
 * platform WebCrypto (`crypto.subtle`).
 *
 * This is a faithful port of the Matrix.org reference `matrix-encrypt-attachment`
 * (Apache-2.0). We inline it rather than depend on the package: it has had no
 * release since 2022 and the scheme is frozen by the spec, so there is nothing to
 * track — and we keep a security-sensitive primitive in-tree, auditable, with no
 * Node-`crypto` shim leaking into the browser bundle. Targets browsers + Capacitor
 * WebViews, which always expose `crypto.subtle`.
 *
 * Spec: https://spec.matrix.org/latest/client-server-api/#sending-encrypted-attachments
 */

/** Ciphertext bytes plus the `content.file` descriptor to attach to the event. */
export interface EncryptedAttachment {
  /** AES-CTR ciphertext to upload to the media repo. */
  data: ArrayBuffer;
  /**
   * The `EncryptedFile` block for the event content. `url` is left empty — the
   * caller fills it with the `mxc://` returned by the upload.
   */
  info: EncryptedFileInfo;
}

/**
 * Decrypt a Matrix encrypted attachment. Verifies the SHA-256 hash of the
 * ciphertext **before** decrypting and rejects on mismatch, so tampered bytes
 * never yield plaintext.
 *
 * @throws if `info` is missing key material, advertises an unsupported version,
 * or the ciphertext hash does not match `info.hashes.sha256`.
 */
export async function decryptAttachment(
  ciphertext: ArrayBuffer,
  info: EncryptedFileInfo,
): Promise<ArrayBuffer> {
  if (!info?.key || !info.iv || !info.hashes?.['sha256']) {
    throw new Error('Invalid encrypted file: missing key, iv, or sha256 hash');
  }
  if (info.v && !/^v[12]$/.test(info.v)) {
    throw new Error(`Unsupported attachment encryption version: ${info.v}`);
  }

  // Integrity first: hash the ciphertext and bail before importing the key or
  // decrypting if it has been altered in transit.
  const digest = await crypto.subtle.digest('SHA-256', ciphertext);
  if (encodeUnpaddedBase64(new Uint8Array(digest)) !== info.hashes['sha256']) {
    throw new Error('Mismatched SHA-256 digest');
  }

  const key = await crypto.subtle.importKey(
    'jwk',
    info.key,
    { name: 'AES-CTR' },
    false,
    ['decrypt'],
  );
  // v1/v2 use a 64-bit counter; the legacy unversioned scheme used the full 128.
  const length = info.v === 'v1' || info.v === 'v2' ? 64 : 128;
  return crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: decodeUnpaddedBase64(info.iv), length },
    key,
    ciphertext,
  );
}

/**
 * Encrypt bytes for upload as a Matrix encrypted attachment: generates a fresh
 * AES-CTR-256 key + IV, and returns the ciphertext plus the `content.file`
 * descriptor (JWK key, iv, sha256 of the ciphertext). The caller uploads `data`
 * and sets `info.url` to the resulting `mxc://`.
 */
export async function encryptAttachment(
  plaintext: ArrayBuffer,
): Promise<EncryptedAttachment> {
  // 16-byte AES-CTR counter block: randomise only the high 8 bytes so the low
  // 64-bit counter starts at 0 and cannot overflow into the nonce for any
  // realistic file size.
  const iv = new Uint8Array(16);
  crypto.getRandomValues(iv.subarray(0, 8));

  const key = await crypto.subtle.generateKey(
    { name: 'AES-CTR', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const jwk = await crypto.subtle.exportKey('jwk', key);
  const data = await crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: iv, length: 64 },
    key,
    plaintext,
  );
  const digest = await crypto.subtle.digest('SHA-256', data);

  return {
    data,
    info: {
      url: '',
      v: 'v2',
      key: jwk,
      iv: encodeUnpaddedBase64(iv),
      hashes: { sha256: encodeUnpaddedBase64(new Uint8Array(digest)) },
    },
  };
}

/**
 * Encode bytes as unpadded *standard* (not url-safe) base64 — the encoding the
 * Matrix attachment scheme uses for `iv` and `hashes.sha256`. Only ever called on
 * small fixed-size buffers (16-byte IV, 32-byte digest).
 */
function encodeUnpaddedBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/=+$/, '');
}

/** Decode standard base64 (padded or unpadded) into bytes. */
function decodeUnpaddedBase64(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + '==='.slice(0, (4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
