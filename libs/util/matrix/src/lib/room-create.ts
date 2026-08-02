import {
  EventType,
  Preset,
  Visibility,
  type ICreateRoomStateEvent,
} from 'matrix-js-sdk';

/** Megolm group-encryption algorithm enabled on every room we create (E2EE-first). */
export const MEGOLM_ALGORITHM = 'm.megolm.v1.aes-sha2';

/**
 * The `m.room.encryption` (Megolm) entry to drop into a `createRoom`
 * `initial_state` so a room is encrypted from its very first event — it is never
 * briefly unencrypted. Shared by every room/DM creation path (spaces, standalone
 * rooms, DMs) so the E2EE-first guarantee can't drift between them.
 */
export function roomEncryptionInitialState(): ICreateRoomStateEvent {
  return {
    type: EventType.RoomEncryption,
    state_key: '',
    content: { algorithm: MEGOLM_ALGORITHM },
  };
}

/** Visibility/preset for a create call: public-discoverable vs invite-only (default). */
export function visibilityOptions(isPublic?: boolean): {
  visibility: Visibility;
  preset: Preset;
} {
  return isPublic
    ? { visibility: Visibility.Public, preset: Preset.PublicChat }
    : { visibility: Visibility.Private, preset: Preset.PrivateChat };
}

/**
 * Whether a string has the shape of a Matrix user id (`@localpart:server`). A
 * cheap structural guard used before invite/DM calls so an obvious typo is
 * rejected client-side rather than round-tripping to the homeserver. The
 * localpart may not contain a colon (per spec); the server name may (e.g. a
 * `:port`), so only the localpart's colon is excluded.
 */
export function isValidUserId(userId: string): boolean {
  return /^@[^\s:]+:[^\s]+$/.test(userId.trim());
}
