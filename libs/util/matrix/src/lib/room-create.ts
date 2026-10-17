import {
  EventType,
  Preset,
  Visibility,
  type ICreateRoomStateEvent,
} from 'matrix-js-sdk';
import type { RoomEncryptionEventContent } from 'matrix-js-sdk/lib/@types/state_events';

/** Megolm group-encryption algorithm enabled on every room we create (E2EE-first). */
const MEGOLM_ALGORITHM = 'm.megolm.v1.aes-sha2';

/** The `m.room.encryption` content Trinity uses, at creation or when turned on later. */
export function roomEncryptionContent(): RoomEncryptionEventContent {
  return { algorithm: MEGOLM_ALGORITHM };
}

/**
 * The `m.room.encryption` (Megolm) entry for a `createRoom` `initial_state`, so a room is
 * encrypted from its very first event. Shared by every room/DM creation path.
 */
export function roomEncryptionInitialState(): ICreateRoomStateEvent {
  return {
    type: EventType.RoomEncryption,
    state_key: '',
    content: roomEncryptionContent(),
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
 * Whether a string has the shape of a Matrix user id (`@localpart:server`), a cheap guard
 * before invite/DM calls. Per spec the localpart may not contain a colon; the server name may
 * (e.g. `:port`).
 */
export function isValidUserId(userId: string): boolean {
  return /^@[^\s:]+:[^\s]+$/.test(userId.trim());
}
