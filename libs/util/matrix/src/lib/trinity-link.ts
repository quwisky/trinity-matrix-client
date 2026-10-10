import { parseMatrixLink, type MatrixLinkTarget } from './matrix-to';

/** Remainder of an app link is exactly a matrix.to link: `dev.trinityproject.trinity://matrix.to/#/...`. */
const APP_LINK_PREFIX = /^dev\.trinityproject\.trinity:\/\/matrix\.to\/#\//i;
const MAX_LINK_LENGTH = 2048;
const MAX_ID_LENGTH = 255;

const UNSAFE_ID = /[\s\u0000-\u001f\u007f]/;

function isSafeId(id: string): boolean {
  return id.length <= MAX_ID_LENGTH && !UNSAFE_ID.test(id);
}

/**
 * Parse an untrusted `dev.trinityproject.trinity://matrix.to/#/<room id or alias>[/<event id>][?via=...]`
 * link into a room target. Returns `null` for anything else, so callers can ignore it.
 */
export function parseTrinityRoomLink(
  url: string,
): Extract<MatrixLinkTarget, { kind: 'room' }> | null {
  if (url.length > MAX_LINK_LENGTH || !APP_LINK_PREFIX.test(url)) return null;
  const target = parseMatrixLink(
    url.replace(APP_LINK_PREFIX, 'https://matrix.to/#/'),
  );
  if (target?.kind !== 'room') return null;
  if (!isSafeId(target.roomIdOrAlias)) return null;
  if (target.eventId && !isSafeId(target.eventId)) return null;
  return target;
}
