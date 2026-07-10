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

describe('megolm key-file crypto', () => {
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
