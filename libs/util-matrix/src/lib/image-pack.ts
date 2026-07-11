/**
 * MSC2545 image packs — the interoperable "custom emoji / stickers" format Element
 * and others read/write. A pack lives either in account data (`im.ponies.user_emotes`,
 * the user's personal pack) or in a room's state (`im.ponies.room_emotes`, one per
 * state key). Each pack maps shortcodes to `mxc://` images, and every image (or the
 * pack as a whole) declares a `usage` — `emoticon`, `sticker`, or both. This module is
 * pure (no SDK/DI): it parses the raw content into the {@link StickerPack} view model
 * the picker consumes, keeping only images usable as stickers.
 */

/** Account-data event type carrying the user's personal image pack. */
export const USER_EMOTES_EVENT = 'im.ponies.user_emotes';
/** Room state event type carrying a room's image pack(s), keyed by state key. */
export const ROOM_EMOTES_EVENT = 'im.ponies.room_emotes';

/** A single pack image, resolved for sending as a sticker. */
export interface PackImage {
  /** The pack's shortcode key (e.g. `party_blob`). */
  shortcode: string;
  /** `mxc://` URL of the image. */
  url: string;
  /** Human label (`body`), falling back to the shortcode. */
  body: string;
  /** `info.w` in pixels, if the pack declared it. */
  width?: number;
  /** `info.h` in pixels, if the pack declared it. */
  height?: number;
  /** `info.mimetype`, if the pack declared it. */
  mimeType?: string;
  /** `info.size` in bytes, if the pack declared it. */
  size?: number;
}

/** A parsed image pack with its sticker-usable images. */
export interface StickerPack {
  /** Stable id for this pack (its source, e.g. `user` or `!room:hs|state-key`). */
  id: string;
  /** Display name (`pack.display_name`), falling back to a caller-supplied default. */
  displayName: string;
  /** The pack's sticker-eligible images, in declaration order. */
  images: PackImage[];
}

/** A `usage` array narrowed to the string tokens MSC2545 defines. */
type Usage = readonly string[];

function usageOf(value: unknown): Usage {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Whether an image is usable as a sticker. An image's own `usage` overrides the
 * pack's; when the effective usage is empty the image is usable everywhere (so it
 * counts as a sticker), otherwise it must explicitly list `sticker`.
 */
function isSticker(imageUsage: Usage, packUsage: Usage): boolean {
  const usage = imageUsage.length ? imageUsage : packUsage;
  return usage.length === 0 || usage.includes('sticker');
}

function parseImage(
  shortcode: string,
  raw: unknown,
  packUsage: Usage,
): PackImage | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const image = raw as Record<string, unknown>;
  const url = image['url'];
  if (typeof url !== 'string' || !url.startsWith('mxc://')) {
    return null;
  }
  if (!isSticker(usageOf(image['usage']), packUsage)) {
    return null;
  }
  const info = (
    image['info'] && typeof image['info'] === 'object' ? image['info'] : {}
  ) as Record<string, unknown>;
  const body = typeof image['body'] === 'string' ? image['body'] : shortcode;
  return {
    shortcode,
    url,
    body: body || shortcode,
    width: typeof info['w'] === 'number' ? info['w'] : undefined,
    height: typeof info['h'] === 'number' ? info['h'] : undefined,
    mimeType:
      typeof info['mimetype'] === 'string' ? info['mimetype'] : undefined,
    size: typeof info['size'] === 'number' ? info['size'] : undefined,
  };
}

/**
 * Parse an image-pack event's content into a {@link StickerPack}, keeping only
 * sticker-usable images. Returns null when the content is malformed or has no
 * sticker images, so callers can drop empty packs.
 */
export function parseStickerPack(
  content: unknown,
  id: string,
  fallbackName: string,
): StickerPack | null {
  if (!content || typeof content !== 'object') {
    return null;
  }
  const record = content as Record<string, unknown>;
  const images = record['images'];
  if (!images || typeof images !== 'object') {
    return null;
  }
  const packMeta = (
    record['pack'] && typeof record['pack'] === 'object' ? record['pack'] : {}
  ) as Record<string, unknown>;
  const packUsage = usageOf(packMeta['usage']);
  const displayName =
    typeof packMeta['display_name'] === 'string' && packMeta['display_name']
      ? (packMeta['display_name'] as string)
      : fallbackName;

  const parsed: PackImage[] = [];
  for (const [shortcode, raw] of Object.entries(
    images as Record<string, unknown>,
  )) {
    const image = parseImage(shortcode, raw, packUsage);
    if (image) {
      parsed.push(image);
    }
  }
  return parsed.length ? { id, displayName, images: parsed } : null;
}
