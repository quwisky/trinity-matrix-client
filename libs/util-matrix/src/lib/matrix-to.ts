/**
 * A parsed `matrix.to` permalink target the app can route to internally.
 * - `user` — a person (`@user:hs`).
 * - `room` — a room by id (`!id:hs`) or alias (`#alias:hs`), optionally deep-linking to
 *   an event within it (`eventId`).
 */
export type MatrixLinkTarget =
  | { kind: 'user'; userId: string }
  | { kind: 'room'; roomIdOrAlias: string; eventId?: string };

/** matrix.to permalinks live entirely in the fragment: `https://matrix.to/#/<...>`. */
const MATRIX_TO_PREFIX = /^https?:\/\/matrix\.to\/#\//i;

/**
 * Build a `matrix.to` permalink to a specific message (`https://matrix.to/#/<room>/<event>`).
 * The sigil-prefixed ids are percent-encoded, matching what {@link parseMatrixToLink} decodes.
 *
 * A room-*ID* link is not resolvable on its own — a recipient not already in the room
 * needs a `?via=<server>` routing hint. `via` supplies those candidate servers; when
 * omitted, the room's own origin server (the domain of `!id:server`) is used as a
 * sensible default. Alias links (`#alias:server`) resolve without a hint.
 */
export function messagePermalink(
  roomIdOrAlias: string,
  eventId: string,
  via?: string[],
): string {
  const base = `https://matrix.to/#/${encodeURIComponent(roomIdOrAlias)}/${encodeURIComponent(eventId)}`;
  const servers = (via ?? defaultVia(roomIdOrAlias)).filter(Boolean);
  if (servers.length === 0) {
    return base;
  }
  const query = servers.map((s) => `via=${encodeURIComponent(s)}`).join('&');
  return `${base}?${query}`;
}

/** The origin server of a room ID (`!id:server` → `server`); empty for aliases. */
function defaultVia(roomIdOrAlias: string): string[] {
  if (!roomIdOrAlias.startsWith('!')) {
    return [];
  }
  const colon = roomIdOrAlias.indexOf(':');
  return colon !== -1 && colon < roomIdOrAlias.length - 1
    ? [roomIdOrAlias.slice(colon + 1)]
    : [];
}

/** Strip a `?via=…` (or any) query string from a single permalink segment. */
function stripQuery(segment: string): string {
  const q = segment.indexOf('?');
  return q === -1 ? segment : segment.slice(0, q);
}

/**
 * Parse a `matrix.to` permalink into a routable {@link MatrixLinkTarget}, or `null` when
 * the href isn't a matrix.to link or its target is unrecognised. Segments are
 * percent-decoded (matrix.to encodes the sigil-prefixed ids), and a trailing event id
 * (`!room:hs/$event`) is captured for deep links.
 */
export function parseMatrixToLink(href: string): MatrixLinkTarget | null {
  if (!MATRIX_TO_PREFIX.test(href)) {
    return null;
  }
  const fragment = href.replace(MATRIX_TO_PREFIX, '');
  const segments = fragment.split('/').filter(Boolean);
  if (segments.length === 0) {
    return null;
  }

  let primary: string;
  let event: string | undefined;
  try {
    primary = decodeURIComponent(stripQuery(segments[0]));
    event = segments[1]
      ? decodeURIComponent(stripQuery(segments[1]))
      : undefined;
  } catch {
    return null; // malformed percent-encoding
  }

  const sigil = primary[0];
  if (sigil === '@') {
    return { kind: 'user', userId: primary };
  }
  if (sigil === '!' || sigil === '#') {
    return event?.startsWith('$')
      ? { kind: 'room', roomIdOrAlias: primary, eventId: event }
      : { kind: 'room', roomIdOrAlias: primary };
  }
  return null;
}
