import { webcrypto } from 'node:crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { decryptMegolmKeyFile, encryptMegolmKeyFile } from './key-file-crypto';

// jsdom has no `crypto.subtle`; use Node's WebCrypto, the same API the WebView
// provides at runtime (mirrors attachment-crypto.spec).
beforeAll(() => vi.stubGlobal('crypto', webcrypto));

// A small iteration count keeps PBKDF2 fast in tests; the round-trip is
// iteration-agnostic (decrypt reads the count from the file).
const ITER = 1000;
const SAMPLE = JSON.stringify([
  { room_id: '!r:hs', session_id: 'abc', session_key: 'deadbeef' },
]);

/**
 * A fixed golden vector (salt/iv = 0x11/0x22, 1000 rounds) generated with an
 * independent implementation of the documented format. Decrypting it locks the wire
 * layout AND the crypto pipeline (PBKDF2-SHA512 → AES-CTR + HMAC-SHA256, key-half
 * split): a format-affecting regression that a self-symmetric round-trip would hide
 * (both sides change together) breaks this vector, since it was produced elsewhere.
 */
const GOLDEN_VECTOR = [
  '-----BEGIN MEGOLM SESSION DATA-----',
  'AREREREREREREREREREREREiIiIiIiIiIiIiIiIiIiIiAAAD6Cy1F399rrZtkQ438vUlM5WPDl1cAiSgN6UPsalpvHdn16XWPqZD/lV2zUfhiUZuyb54t2oYWw==',
  '-----END MEGOLM SESSION DATA-----',
].join('\n');
const GOLDEN_PASSPHRASE = 'test-passphrase';
const GOLDEN_PLAINTEXT = '[{"session":"golden"}]';

/** Decode the base64 body between the armor lines to inspect the wire format. */
function decodeArmor(armored: string): Uint8Array {
  const b64 = armored
    .replace('-----BEGIN MEGOLM SESSION DATA-----', '')
    .replace('-----END MEGOLM SESSION DATA-----', '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

describe('megolm key-file crypto', () => {
  it('decrypts a fixed golden vector (locks the interoperable format)', async () => {
    expect(await decryptMegolmKeyFile(GOLDEN_VECTOR, GOLDEN_PASSPHRASE)).toBe(
      GOLDEN_PLAINTEXT,
    );
  });

  it('lays out the wire format: version, salt, iv, big-endian iterations, then a 32-byte MAC', async () => {
    const body = decodeArmor(await encryptMegolmKeyFile('hello', 'pw', ITER));

    expect(body[0]).toBe(1); // version byte
    // iterations are a big-endian uint32 at offset 1 + 16(salt) + 16(iv) = 33.
    expect(new DataView(body.buffer).getUint32(33, false)).toBe(ITER);
    // total = 37-byte header + ciphertext('hello' → 5) + 32-byte HMAC.
    expect(body.length).toBe(37 + 5 + 32);
  });

  it('wraps the ciphertext in the interoperable megolm armor', async () => {
    const armored = await encryptMegolmKeyFile(SAMPLE, 'hunter2', ITER);
    expect(armored).toContain('-----BEGIN MEGOLM SESSION DATA-----');
    expect(armored).toContain('-----END MEGOLM SESSION DATA-----');
    // The armored body must not leak the plaintext.
    expect(armored).not.toContain('deadbeef');
  });

  it('round-trips plaintext through encrypt → decrypt', async () => {
    const armored = await encryptMegolmKeyFile(SAMPLE, 'correct horse', ITER);
    expect(await decryptMegolmKeyFile(armored, 'correct horse')).toBe(SAMPLE);
  });

  it('round-trips an empty export', async () => {
    const armored = await encryptMegolmKeyFile('[]', 'pw', ITER);
    expect(await decryptMegolmKeyFile(armored, 'pw')).toBe('[]');
  });

  it('round-trips unicode content', async () => {
    const text = JSON.stringify({ note: 'clé de récupération 🔑' });
    const armored = await encryptMegolmKeyFile(text, 'pw', ITER);
    expect(await decryptMegolmKeyFile(armored, 'pw')).toBe(text);
  });

  it('rejects a wrong passphrase (HMAC mismatch)', async () => {
    const armored = await encryptMegolmKeyFile(SAMPLE, 'right', ITER);
    await expect(decryptMegolmKeyFile(armored, 'wrong')).rejects.toThrow(
      /incorrect passphrase/i,
    );
  });

  it('rejects a tampered file', async () => {
    const armored = await encryptMegolmKeyFile(SAMPLE, 'pw', ITER);
    // Flip a character in the middle of the base64 body.
    const lines = armored.split('\n');
    const body = lines[1];
    const mid = Math.floor(body.length / 2);
    const flipped = body[mid] === 'A' ? 'B' : 'A';
    lines[1] = body.slice(0, mid) + flipped + body.slice(mid + 1);
    await expect(
      decryptMegolmKeyFile(lines.join('\n'), 'pw'),
    ).rejects.toThrow();
  });

  it('rejects a file that isn’t a key export', async () => {
    await expect(decryptMegolmKeyFile('just some text', 'pw')).rejects.toThrow(
      /valid encrypted key export/i,
    );
  });
});
