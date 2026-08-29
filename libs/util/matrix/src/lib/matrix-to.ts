/**
 * A parsed Matrix link target the app can route to internally.
 * - `user` — a person (`@user:hs`).
 * - `room` — a room by id (`!id:hs`) or alias (`#alias:hs`), optionally deep-linking to
 *   an event within it (`eventId`).
 *
 * `via` contains at most the three valid, distinct routing servers Matrix clients are
 * allowed to pass to a join request. It is omitted when the link supplied no usable hints.
 */
export type MatrixLinkTarget =
  | { kind: 'user'; userId: string }
  | {
      kind: 'room';
      roomIdOrAlias: string;
      eventId?: string;
      via?: readonly string[];
    };

/** matrix.to permalinks live entirely in the fragment: `https://matrix.to/#/<...>`. */
const MATRIX_TO_PREFIX = /^https?:\/\/matrix\.to\/#\//i;
const MATRIX_URI_PREFIX = /^matrix:/i;
const MAX_VIA_SERVERS = 3;

/** Whether a link claims to be a Matrix link, including a malformed one. */
export function isMatrixLinkHref(href: string): boolean {
  return MATRIX_TO_PREFIX.test(href) || MATRIX_URI_PREFIX.test(href);
}

/**
 * Build a `matrix.to` permalink to a specific message (`https://matrix.to/#/<room>/<event>`).
 * The sigil-prefixed ids are percent-encoded, matching what {@link parseMatrixLink} decodes.
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
  return matrixToPermalink({
    kind: 'room',
    roomIdOrAlias,
    eventId,
    via: via ?? defaultVia(roomIdOrAlias),
  });
}

/** Convert a parsed target to the HTTPS form browsers and Angular safely preserve. */
export function matrixToPermalink(target: MatrixLinkTarget): string {
  if (target.kind === 'user') {
    return `https://matrix.to/#/${encodeURIComponent(target.userId)}`;
  }
  const event = target.eventId ? `/${encodeURIComponent(target.eventId)}` : '';
  const base = `https://matrix.to/#/${encodeURIComponent(target.roomIdOrAlias)}${event}`;
  const via = target.via ?? [];
  if (via.length === 0) {
    return base;
  }
  const query = via
    .map((server) => `via=${encodeURIComponent(server)}`)
    .join('&');
  return `${base}?${query}`;
}

/** The origin server of a room ID (`!id:server` -> `server`); empty for aliases. */
function defaultVia(roomIdOrAlias: string): string[] {
  if (!roomIdOrAlias.startsWith('!')) {
    return [];
  }
  const colon = roomIdOrAlias.indexOf(':');
  return colon !== -1 && colon < roomIdOrAlias.length - 1
    ? [roomIdOrAlias.slice(colon + 1)]
    : [];
}

/** RFC-style Matrix server name: DNS name / IP literal, with an optional valid port. */
function isValidViaServer(value: string): boolean {
  if (!value || value.length > 255 || value.trim() !== value) {
    return false;
  }
  try {
    const parsed = new URL(`matrix://${value}`);
    if (
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.pathname ||
      parsed.search ||
      parsed.hash
    ) {
      return false;
    }
    const hostname = parsed.hostname;
    if (hostname.startsWith('[')) {
      return /^\[[0-9a-f:.]+\]$/i.test(hostname) && hostname.includes(':');
    }
    return hostname
      .split('.')
      .every(
        (label) =>
          label.length > 0 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
      );
  } catch {
    return false;
  }
}

/** Keep the SDK's maximum of three distinct, valid routing servers. */
export function normalizeViaServers(
  values: Iterable<string>,
): readonly string[] {
  const via: string[] = [];
  for (const server of values) {
    if (isValidViaServer(server) && !via.includes(server)) {
      via.push(server);
      if (via.length === MAX_VIA_SERVERS) break;
    }
  }
  return via;
}

function parseVia(query: string): readonly string[] | undefined {
  const via = normalizeViaServers(new URLSearchParams(query).getAll('via'));
  return via.length > 0 ? via : undefined;
}

function roomTarget(
  roomIdOrAlias: string,
  eventId: string | undefined,
  query: string,
): MatrixLinkTarget {
  const via = parseVia(query);
  return {
    kind: 'room',
    roomIdOrAlias,
    ...(eventId ? { eventId } : {}),
    ...(via ? { via } : {}),
  };
}

function decodeSegments(path: string): string[] | null {
  try {
    return path.split('/').map((segment) => decodeURIComponent(segment));
  } catch {
    return null;
  }
}

function parseMatrixTo(href: string): MatrixLinkTarget | null {
  const fragment = href.replace(MATRIX_TO_PREFIX, '');
  const queryIndex = fragment.indexOf('?');
  const path = queryIndex === -1 ? fragment : fragment.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : fragment.slice(queryIndex + 1);
  const segments = decodeSegments(path);
  if (!segments || segments.some((segment) => !segment)) {
    return null;
  }
  const [primary, event, ...extra] = segments;
  if (extra.length > 0) return null;
  if (primary.startsWith('@')) {
    return event ? null : { kind: 'user', userId: primary };
  }
  if (!primary.startsWith('!') && !primary.startsWith('#')) {
    return null;
  }
  if (event && !event.startsWith('$')) {
    return null;
  }
  return roomTarget(primary, event, query);
}

function parseMatrixUri(href: string): MatrixLinkTarget | null {
  const withoutScheme = href.replace(MATRIX_URI_PREFIX, '');
  const fragmentIndex = withoutScheme.indexOf('#');
  const withoutFragment =
    fragmentIndex === -1
      ? withoutScheme
      : withoutScheme.slice(0, fragmentIndex);
  const queryIndex = withoutFragment.indexOf('?');
  let path =
    queryIndex === -1 ? withoutFragment : withoutFragment.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : withoutFragment.slice(queryIndex + 1);

  // The authority is reserved by the Matrix spec. Accept and ignore a syntactically valid
  // one, then parse the resource path which follows it.
  if (path.startsWith('//')) {
    const slash = path.indexOf('/', 2);
    if (slash === -1 || !isValidViaServer(path.slice(2, slash))) return null;
    path = path.slice(slash + 1);
  }

  const segments = decodeSegments(path);
  if (!segments || ![2, 4].includes(segments.length)) return null;
  const [type, id, nestedType, nestedId] = segments;
  if (!id) return null;

  if (type === 'u' || type === 'user') {
    return segments.length === 2 ? { kind: 'user', userId: `@${id}` } : null;
  }

  const sigil =
    type === 'r' || type === 'room' ? '#' : type === 'roomid' ? '!' : null;
  if (!sigil) return null;
  if (segments.length === 2) {
    return roomTarget(`${sigil}${id}`, undefined, query);
  }
  if ((nestedType !== 'e' && nestedType !== 'event') || !nestedId) return null;
  return roomTarget(`${sigil}${id}`, `$${nestedId}`, query);
}

/**
 * Parse a supported `matrix.to` permalink or `matrix:` URI into a routable target.
 * Returns `null` for non-Matrix links and malformed/unknown Matrix resources.
 */
export function parseMatrixLink(href: string): MatrixLinkTarget | null {
  if (MATRIX_TO_PREFIX.test(href)) return parseMatrixTo(href);
  if (MATRIX_URI_PREFIX.test(href)) return parseMatrixUri(href);
  return null;
}

/** Backwards-compatible name retained for existing consumers. */
export function parseMatrixToLink(href: string): MatrixLinkTarget | null {
  return MATRIX_TO_PREFIX.test(href) ? parseMatrixTo(href) : null;
}
