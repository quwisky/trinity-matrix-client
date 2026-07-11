/**
 * Passphrase-encrypted room-key export file, in the interoperable **Matrix megolm
 * export** format (the same `.txt` Element reads and writes), implemented on platform
 * WebCrypto (`crypto.subtle`) — DI-free so it stays in `util-matrix`.
 *
 * Format (all binary, then base64 between the armor lines):
 *   version(1) ‖ salt(16) ‖ iv(16) ‖ iterations(4, big-endian) ‖ ciphertext ‖ hmac(32)
 * Keys are PBKDF2-SHA512(passphrase, salt, iterations) → 64 bytes, split into a 32-byte
 * AES-CTR key and a 32-byte HMAC-SHA256 key. The HMAC covers everything before it, so a
 * wrong passphrase (or a tampered file) fails verification instead of decrypting garbage.
 *
 * Buffers are typed `Uint8Array<ArrayBuffer>` and sliced (never sub-arrayed) before hitting
 * `crypto.subtle`: the Angular build's TS lib rejects the `ArrayBufferLike` a `subarray()`
 * view carries where a `BufferSource` (ArrayBuffer-backed) is required.
 */

const HEADER = '-----BEGIN MEGOLM SESSION DATA-----';
const TRAILER = '-----END MEGOLM SESSION DATA-----';

/** PBKDF2 rounds for a fresh export — matches the interoperable default. */
export const DEFAULT_KEY_FILE_ITERATIONS = 500_000;

/**
 * Upper bound on the iteration count we'll honor from an *imported* file. The count is
 * an attacker-controlled uint32 read before HMAC verification, so an uncapped value
 * (up to ~4.3 billion) would pin the main thread running PBKDF2 for minutes — a DoS.
 * 10× the default is far above any legitimate exporter yet stays sub-second.
 */
const MAX_KEY_FILE_ITERATIONS = 5_000_000;

const VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 16;
const HEADER_LEN = 1 + SALT_LEN + IV_LEN + 4; // version + salt + iv + iterations
const MAC_LEN = 32;

/** Encrypt `plaintext` into an armored megolm key-file string. */
export async function encryptMegolmKeyFile(
  plaintext: string,
  passphrase: string,
  iterations: number = DEFAULT_KEY_FILE_ITERATIONS,
): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  // Clear bit 63 of the counter so a long export can't overflow the 64-bit CTR counter.
  iv[8] &= 0x7f;

  const { aesKey, hmacKey } = await deriveKeys(passphrase, salt, iterations);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-CTR', counter: iv, length: 64 },
      aesKey,
      encodeUtf8(plaintext),
    ),
  );

  const body = new Uint8Array(HEADER_LEN + ciphertext.length + MAC_LEN);
  body[0] = VERSION;
  body.set(salt, 1);
  body.set(iv, 1 + SALT_LEN);
  new DataView(body.buffer).setUint32(1 + SALT_LEN + IV_LEN, iterations, false);
  body.set(ciphertext, HEADER_LEN);

  const macOffset = HEADER_LEN + ciphertext.length;
  const mac = new Uint8Array(
    await crypto.subtle.sign('HMAC', hmacKey, body.slice(0, macOffset)),
  );
  body.set(mac, macOffset);

  return `${HEADER}\n${toBase64(body)}\n${TRAILER}`;
}

/** Decrypt an armored megolm key-file string; throws on a wrong passphrase. */
export async function decryptMegolmKeyFile(
  armored: string,
  passphrase: string,
): Promise<string> {
  const body = fromBase64(stripArmor(armored));
  if (body.length < HEADER_LEN + MAC_LEN || body[0] !== VERSION) {
    throw new Error('This file isn’t a valid encrypted key export.');
  }
  const salt = body.slice(1, 1 + SALT_LEN);
  const iv = body.slice(1 + SALT_LEN, 1 + SALT_LEN + IV_LEN);
  const iterations = new DataView(body.buffer).getUint32(
    1 + SALT_LEN + IV_LEN,
    false,
  );
  // The count is untrusted (read before verification): reject an absurd value rather
  // than run PBKDF2 for it, which would freeze the app.
  if (iterations < 1 || iterations > MAX_KEY_FILE_ITERATIONS) {
    throw new Error('This file isn’t a valid encrypted key export.');
  }
  const macOffset = body.length - MAC_LEN;
  const ciphertext = body.slice(HEADER_LEN, macOffset);
  const mac = body.slice(macOffset);

  const { aesKey, hmacKey } = await deriveKeys(passphrase, salt, iterations);
  const valid = await crypto.subtle.verify(
    'HMAC',
    hmacKey,
    mac,
    body.slice(0, macOffset),
  );
  if (!valid) {
    throw new Error('Incorrect passphrase, or the key file is corrupted.');
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-CTR', counter: iv, length: 64 },
    aesKey,
    ciphertext,
  );
  return new TextDecoder().decode(plaintext);
}

/** PBKDF2-SHA512 → a 32-byte AES-CTR key + a 32-byte HMAC-SHA256 key. */
async function deriveKeys(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number,
): Promise<{ aesKey: CryptoKey; hmacKey: CryptoKey }> {
  const material = await crypto.subtle.importKey(
    'raw',
    encodeUtf8(passphrase),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations, hash: 'SHA-512' },
      material,
      512,
    ),
  );
  const aesKey = await crypto.subtle.importKey(
    'raw',
    bits.slice(0, 32),
    { name: 'AES-CTR' },
    false,
    ['encrypt', 'decrypt'],
  );
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    bits.slice(32, 64),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  return { aesKey, hmacKey };
}

/** UTF-8 encode into an ArrayBuffer-backed view (satisfies `BufferSource`). */
function encodeUtf8(text: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(text).slice();
}

/** Strip the armor lines and all whitespace, leaving the base64 body. */
function stripArmor(armored: string): string {
  return armored.replace(HEADER, '').replace(TRAILER, '').replace(/\s+/g, '');
}

/** Standard (padded) base64 encode, chunked so a large export doesn't blow the stack. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Decode standard base64 (padded or not) into ArrayBuffer-backed bytes. */
function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + '==='.slice(0, (4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
