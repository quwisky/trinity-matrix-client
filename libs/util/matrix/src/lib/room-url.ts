/**
 * The open room, as a URL path segment.
 *
 * ## Why this is not just the room id
 *
 * A raw room id (`!opaque:server.example`) or alias (`#name:server.example`) is hostile in a
 * path segment:
 *
 * - the server part carries a DOT, which makes the last segment look like a file. Angular's
 *   service worker excludes `!/**‍/*.*` from the navigations it answers with `index.html`, and
 *   the Electron scheme handler serves `index.html` only when `path.extname(rel) === ''`, so
 *   a raw id would 404 on reload in the packaged app and on a bookmarked room in the PWA.
 * - `#` starts the fragment, so an alias would be truncated before any router saw it.
 * - `:` in the FIRST segment of a relative URL parses as a scheme.
 *
 * Base64url (`A-Z a-z 0-9 - _`) contains none of these, so both SPA fallbacks work untouched.
 * The cost is an opaque URL, confined to these two functions and the route that calls them.
 */

/** The exact character set {@link encodeRoomSegment} can emit. Nothing here needs escaping. */
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The sigils a Matrix room reference can start with: an id, or an alias.
 *
 * Checked on the way OUT of {@link decodeRoomSegment}: a path segment is user input, and
 * base64url decodes plenty of arbitrary strings into plausible text. Rejecting it here makes
 * the shell treat the URL as naming no room, rather than sending a bad id to the SDK.
 */
const ROOM_SIGILS = ['!', '#'];

/**
 * `!abc:matrix.org` -> `IWFiYzptYXRyaXgub3Jn`.
 *
 * Encodes the UTF-8 bytes, not the UTF-16 code units: `btoa` throws on any character above
 * U+00FF, and an alias localpart may legitimately hold one. A lone surrogate does not
 * survive (`TextEncoder` substitutes U+FFFD); it cannot occur in a real id or alias.
 */
export function encodeRoomSegment(roomIdOrAlias: string): string {
  const bytes = new TextEncoder().encode(roomIdOrAlias);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * `IWFiYzptYXRyaXgub3Jn` -> `!abc:matrix.org`, or `null` when the segment is not one of ours.
 *
 * Returns `null` rather than throwing: the input comes from the URL, and an exception out of
 * a route resolver takes the shell down.
 *
 * It cannot detect truncation: base64 has no checksum, so a clipped segment decodes to a
 * well-formed id no server knows, and fails at lookup instead.
 */
export function decodeRoomSegment(segment: string): string | null {
  if (!SEGMENT_PATTERN.test(segment)) {
    return null;
  }
  // Padding is stripped from the URL but `atob` needs it back: a base64 string is 0, 2 or 3
  // characters short of a multiple of four, never 1.
  const base64 = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);

  let decoded: string;
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Not valid base64, or not UTF-8: it did not come from `encodeRoomSegment`.
    return null;
  }

  return ROOM_SIGILS.some((sigil) => decoded.startsWith(sigil))
    ? decoded
    : null;
}
