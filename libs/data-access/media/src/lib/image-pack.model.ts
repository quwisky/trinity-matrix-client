export const IMAGE_PACK_EVENT_TYPE = 'm.room.image_pack';
export const LEGACY_IMAGE_PACK_EVENT_TYPE = 'im.ponies.room_emotes';
export const IMAGE_PACK_ROOMS_EVENT_TYPE = 'm.image_pack.rooms';
export const LEGACY_IMAGE_PACK_ROOMS_EVENT_TYPE = 'im.ponies.emote_rooms';
export const TRINITY_IMAGE_PACK_ENABLED_USAGE =
  'dev.trinityproject.trinity.enabled_usage';
/** Retired key; read while a reference has only it, dropped when the reference is rewritten. */
export const LEGACY_TRINITY_IMAGE_PACK_ENABLED_USAGE =
  'eu.qwky.trinity.enabled_usage';
export const PERSONAL_IMAGE_PACK_EVENT_TYPE = 'm.image_pack';
export const LEGACY_PERSONAL_IMAGE_PACK_EVENT_TYPE = 'im.ponies.user_emotes';
/** The reader's `ImagePack.id` for the personal pack, "Your emoji". */
export const PERSONAL_IMAGE_PACK_ID = 'personal';
/** The personal pack's name, which the editor writes and the reader shows. */
export const PERSONAL_IMAGE_PACK_NAME = 'Your emoji';
/** How many images the personal pack may hold. */
export const MAX_PERSONAL_IMAGES = 500;

const SERVER_NAME_PATTERN =
  /^(?:(?:\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})|(?:\[[\dA-Fa-f:.]{2,45}])|(?:[A-Za-z\d\-.]{1,255}))(?::\d{1,5})?$/;
const MEDIA_ID_PATTERN = /^[\w-]+$/;

export type ImagePackUsage = 'emoticon' | 'sticker';

export function isImagePackUsage(value: unknown): value is ImagePackUsage {
  return value === 'emoticon' || value === 'sticker';
}

export function parseUsage(value: unknown): readonly ImagePackUsage[] {
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    return ['emoticon', 'sticker'];
  }
  if (!Array.isArray(value)) return [];
  const usage: ImagePackUsage[] = [];
  if (value.includes('emoticon')) usage.push('emoticon');
  if (value.includes('sticker')) usage.push('sticker');
  return usage;
}

/** Matches matrix-js-sdk's server-name and media-ID validation. */
export function isValidMxcUri(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('mxc://')) return false;
  const [serverName, mediaId, ...rest] = value.slice(6).split('/');
  return (
    rest.length === 0 &&
    SERVER_NAME_PATTERN.test(serverName) &&
    MEDIA_ID_PATTERN.test(mediaId)
  );
}
