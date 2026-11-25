import {
  EventType,
  Preset,
  Visibility,
  type ICreateRoomOpts,
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

/**
 * Lets every member publish MatrixRTC call membership (state_default is 50), as Element Web
 * does. Synapse replaces its whole default `events` map with an override's, so this restates
 * those defaults (synapse/handlers/room.py) for the room version and preset the server will
 * use. Rooms created before this keep their power levels.
 */
export function callPowerLevelOverride(o: {
  roomVersion: string;
  isPublic?: boolean;
}): Pick<ICreateRoomOpts, 'power_level_content_override'> {
  return {
    power_level_content_override: {
      events: {
        'm.room.name': 50,
        'm.room.power_levels': 100,
        'm.room.history_visibility': 100,
        'm.room.canonical_alias': 50,
        'm.room.avatar': 50,
        // MSC4289 room versions keep upgrades to the creators, who sit above 100.
        'm.room.tombstone': hasCreatorPower(o.roomVersion) ? 150 : 100,
        'm.room.server_acl': 100,
        'm.room.encryption': 100,
        ...(o.isPublic ? { 'm.call.invite': 50 } : {}),
        'org.matrix.msc3401.call.member': 0,
      },
    },
  };
}

function hasCreatorPower(roomVersion: string): boolean {
  return roomVersion === 'org.matrix.hydra.11' || Number(roomVersion) >= 12;
}

/**
 * The room version a homeserver creates rooms with, from its capabilities; the spec's "1"
 * when it does not say.
 */
export function defaultRoomVersion(capabilities: {
  'm.room_versions'?: { default?: string };
}): string {
  return capabilities['m.room_versions']?.default ?? '1';
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
