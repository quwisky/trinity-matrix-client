export interface EncryptedAttachmentForTest {
  data: ArrayBuffer;
  info: {
    url: string;
    v: 'v2';
    key: JsonWebKey;
    iv: string;
    hashes: { sha256: string };
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=+$/, '');
}

/** Encrypt bytes the way a Matrix client does for an attachment in an encrypted room. */
export async function encryptAttachmentForTest(
  plaintext: ArrayBuffer,
): Promise<EncryptedAttachmentForTest> {
  const iv = new Uint8Array(16);
  globalThis.crypto.getRandomValues(iv.subarray(0, 8));
  const key = await globalThis.crypto.subtle.generateKey(
    { name: 'AES-CTR', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', key);
  const data = await globalThis.crypto.subtle.encrypt(
    { name: 'AES-CTR', counter: iv, length: 64 },
    key,
    plaintext,
  );
  const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
  return {
    data,
    info: {
      url: '',
      v: 'v2',
      key: jwk,
      iv: encodeBase64(iv),
      hashes: { sha256: encodeBase64(new Uint8Array(digest)) },
    },
  };
}
