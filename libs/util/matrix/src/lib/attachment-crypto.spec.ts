import { createCipheriv, createHash, webcrypto } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { decryptAttachment, encryptAttachment } from './attachment-crypto';
import type { EncryptedFileInfo } from './media.model';

// jsdom doesn't expose SubtleCrypto; use Node's WebCrypto, which implements the
// same `crypto.subtle` API the browser/WebView provides at runtime.
beforeAll(() => vi.stubGlobal('crypto', webcrypto));
afterAll(() => vi.unstubAllGlobals());

const bytes = (s: string): ArrayBuffer =>
  new TextEncoder().encode(s).buffer as ArrayBuffer;

// Buffer's backing store is typed `ArrayBuffer | SharedArrayBuffer`; a Node Buffer is
// never shared, and `slice` copies, so the result really is a plain ArrayBuffer.
const toArrayBuffer = (b: Buffer): ArrayBuffer =>
  b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

describe('attachment-crypto', () => {
  it('round-trips: encryptAttachment then decryptAttachment recovers the plaintext', async () => {
    const plaintext = bytes('hello encrypted world 🌍 — with padding bytes');
    const { data, info } = await encryptAttachment(plaintext);

    // Produces a v2 descriptor with a 256-bit AES-CTR JWK and a ciphertext hash.
    expect(info.v).toBe('v2');
    expect(info.key.alg).toBe('A256CTR');
    expect(info.hashes['sha256']).toBeTruthy();
    expect(data.byteLength).toBe(plaintext.byteLength);

    const recovered = await decryptAttachment(data, info);
    expect(new Uint8Array(recovered)).toEqual(new Uint8Array(plaintext));
  });

  it('decrypts a vector built by an independent AES-256-CTR + standard base64 (cross-client interop)', async () => {
    // A known-answer vector produced WITHOUT our own encoder/base64, so it pins the
    // wire format (standard unpadded base64, JWK key, AES-CTR with the iv as counter)
    // against an external reference rather than just round-tripping with ourselves.
    const plaintext = 'cross-client interop check';
    const rawKey = Buffer.alloc(32, 7); // fixed 256-bit key
    // High 8 bytes 0xFF (nonce) → the iv's standard base64 contains '/'; low 8 bytes
    // are the zero counter. (Node's 128-bit CTR matches WebCrypto length:64 for any
    // input that never overflows the low 64 counter bits.)
    const iv = Buffer.from([
      0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);

    const cipher = createCipheriv('aes-256-ctr', rawKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const sha256 = createHash('sha256').update(ciphertext).digest();

    const info = {
      url: '',
      v: 'v2',
      key: {
        kty: 'oct',
        alg: 'A256CTR',
        ext: true,
        key_ops: ['encrypt', 'decrypt'],
        k: rawKey.toString('base64url').replace(/=+$/, ''),
      },
      iv: iv.toString('base64').replace(/=+$/, ''),
      hashes: { sha256: sha256.toString('base64').replace(/=+$/, '') },
    } as unknown as EncryptedFileInfo;

    // The fixture uses the STANDARD base64 alphabet (a '/' here, no url-safe chars).
    expect(info.iv).toContain('/');
    expect(info.iv).not.toMatch(/[-_]/);

    const recovered = await decryptAttachment(toArrayBuffer(ciphertext), info);
    expect(new TextDecoder().decode(recovered)).toBe(plaintext);
  });

  it('rejects tampered ciphertext (SHA-256 mismatch) before decrypting', async () => {
    const { data, info } = await encryptAttachment(bytes('top secret'));
    const tampered = new Uint8Array(data.slice(0));
    tampered[0] ^= 0xff;

    await expect(decryptAttachment(tampered.buffer, info)).rejects.toThrow(
      /digest/i,
    );
  });

  it('rejects an unsupported protocol version', async () => {
    const { data, info } = await encryptAttachment(bytes('x'));

    await expect(decryptAttachment(data, { ...info, v: 'v9' })).rejects.toThrow(
      /version/i,
    );
  });

  it('rejects missing key material', async () => {
    const broken = {
      url: '',
      iv: 'AAAA',
      hashes: {},
      v: 'v2',
    } as unknown as EncryptedFileInfo;

    await expect(decryptAttachment(new ArrayBuffer(8), broken)).rejects.toThrow(
      /missing/i,
    );
  });
});
