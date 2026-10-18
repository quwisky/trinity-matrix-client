/** Per-store key in secure storage: `${STORE_KEY_PREFIX}${cryptoPrefix}`. */
export const STORE_KEY_PREFIX = 'matrix.cryptoStoreKey:';
export const IV_BYTES = 12;

/** A store key the web fallback saved wrapped: base64 of the IV and the AES-GCM output. */
export async function unwrap(
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

export function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
}

export function fromBase64(base64: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}
