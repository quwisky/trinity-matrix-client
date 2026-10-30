/** Megolm group-encryption algorithm enabled on every room we create (E2EE-first). */
const MEGOLM_ALGORITHM = 'm.megolm.v1.aes-sha2';

/** The `m.room.encryption` content Trinity uses, at creation or when turned on later. */
export function roomEncryptionContent(): {
  algorithm: typeof MEGOLM_ALGORITHM;
} {
  return { algorithm: MEGOLM_ALGORITHM };
}

/**
 * Whether a string has the shape of a Matrix user id (`@localpart:server`), a cheap guard
 * before invite/DM calls. Per spec the localpart may not contain a colon; the server name may
 * (e.g. `:port`).
 */
export function isValidUserId(userId: string): boolean {
  return /^@[^\s:]+:[^\s]+$/.test(userId.trim());
}
