/**
 * The open room, as a URL path segment.
 *
 * ## Why this is not just the room id
 *
 * A Matrix room id is `!opaque:server.example` and an alias is `#name:server.example`. Both
 * are legal inside a path segment after percent-encoding, and both are hostile there anyway:
 *
 * - the server part carries a DOT, which makes the last segment look like a file. Angular's
 *   service worker excludes `!/**‍/*.*` from the navigations it answers with `index.html`, and
 *   the Electron scheme handler serves `index.html` only when `path.extname(rel) === ''`. A
 *   raw id would 404 on a reload in the packaged app and on a bookmarked room in the PWA —
 *   two hosts, two unrelated fixes, and a third the next time this ships somewhere new.
 * - `#` cannot appear unencoded at all: it starts the fragment. An alias would be truncated
 *   by the browser before any router saw it.
 * - `:` in the FIRST segment of a relative URL parses as a scheme.
 *
 * Base64url sidesteps all of it: the alphabet is `A-Z a-z 0-9 - _`, so the segment contains no
 * dot, no `#`, no `:` and no `/`, and needs no percent-encoding to survive a path. Both SPA
 * fallbacks then work untouched rather than each needing its own exception.
 *
 * The cost is honest and worth stating: the URL is opaque. `/rooms/IWFiYzptYXRyaXgub3Jn` does
 * not tell you which room it is, so a link cannot be eyeballed or grepped. That is the trade
 * for a link that works on every host, and it is reversible — the encoding is confined to
 * these two functions and the route that calls them.
 */

/** The exact character set {@link encodeRoomSegment} can emit. Nothing here needs escaping. */
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * The sigils a Matrix room reference can start with: an id, or an alias.
 *
 * Checked on the way OUT of {@link decodeRoomSegment} rather than trusted. A path segment is
 * user input — hand-typed, truncated by a chat client, or stale — and base64url decodes plenty
 * of arbitrary strings into plausible-looking text. Handing that to the SDK as a room id turns
 * a bad URL into a failed request with a confusing message; rejecting it here makes the shell
 * treat the URL as naming no room, so it shows the room list instead. The URL itself is left
 * alone — the route has already matched by the time this runs, and nothing rewrites it.
 */
const ROOM_SIGILS = ['!', '#'];

/**
 * `!abc:matrix.org` -> `IWFiYzptYXRyaXgub3Jn`.
 *
 * Encodes the UTF-8 bytes, not the UTF-16 code units: `btoa` throws on any character above
 * U+00FF, and an alias localpart may legitimately hold one.
 *
 * A LONE SURROGATE does not survive the trip: `TextEncoder` substitutes U+FFFD, so the
 * segment names a different string than it was given. Unreachable for a real room id or
 * alias, and the alternative is validating UTF-16 well-formedness on every encode.
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
 * Returns `null` rather than throwing, and rather than returning a best-effort string: every
 * caller reaches this from the URL, where the input is whatever someone pasted. A `null` is a
 * value the route can branch on; an exception thrown out of a route resolver takes the shell
 * down with it.
 *
 * It does NOT detect truncation, and cannot: base64 carries no checksum, so a clipped segment
 * is still a valid one over fewer bytes and still starts with a sigil. A link cut short by a
 * chat client therefore decodes to a well-formed id no server knows, and fails at lookup
 * rather than here. The alternative is a checksum on every URL to improve one error message.
 */
export function decodeRoomSegment(segment: string): string | null {
  if (!SEGMENT_PATTERN.test(segment)) {
    return null;
  }
  // Padding is stripped on the way out because `=` is ugly in a URL and means nothing here;
  // `atob` still wants it, so it goes back on. `%4` rather than a fixed count: a base64 string
  // is 0, 2 or 3 characters short of a multiple of four, never 1.
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
    // Not valid base64, or valid base64 over bytes that are not UTF-8. Either way it did not
    // come from `encodeRoomSegment`.
    return null;
  }

  return ROOM_SIGILS.some((sigil) => decoded.startsWith(sigil))
    ? decoded
    : null;
}
