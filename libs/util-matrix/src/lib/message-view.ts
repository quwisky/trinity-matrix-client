import {
  EventStatus,
  EventType,
  MsgType,
  RelationType,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import DOMPurify from 'dompurify';
import type { EncryptedFileInfo, MediaKind, MediaPayload } from './media.model';
import { buildPollView, isPollStart, type PollView } from './poll';
import { MSC1767_AUDIO, MSC3245_VOICE } from './voice';

/**
 * Shared, framework-free projection of a `matrix-js-sdk` {@link MatrixEvent} into a
 * plain {@link MessageView}. Extracted from `TimelineService` so the main timeline
 * AND the threads view render identical view models with identical decryption
 * ("unable to decrypt") and sanitization handling — no SDK types leak past here.
 */

export type MessageKind =
  | 'text'
  | 'emote'
  | 'notice'
  | 'redacted'
  | 'unsupported'
  | 'poll'
  | 'location'
  /** A room state / membership change rendered as a compact system line (see `summary`). */
  | 'event'
  | MediaKind;

/** A shared location (`m.location`), parsed from its `geo:` URI for the map card. */
export interface LocationView {
  lat: number;
  lng: number;
  /** The description text (e.g. the sender's label), falling back to a default. */
  label: string;
}

/** Parse a `geo:lat,lng` URI (ignoring any `;u=` uncertainty / altitude) into coords. */
export function parseGeoUri(
  geoUri: unknown,
): { lat: number; lng: number } | null {
  if (typeof geoUri !== 'string') {
    return null;
  }
  const match = /^geo:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(geoUri.trim());
  if (!match) {
    return null;
  }
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Number.isFinite(lat) && Number.isFinite(lng) ? { lat, lng } : null;
}

/** Whether a coordinate pair is a finite point inside WGS84 bounds. */
function inGeoRange(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

/** Parse a bare `lat,lng` (map-query style, e.g. a `?q=` value), else null. */
function parseCoordPair(
  value: string | null,
): { lat: number; lng: number } | null {
  if (!value) {
    return null;
  }
  const match = /^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/.exec(value);
  if (!match) {
    return null;
  }
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return inGeoRange(lat, lng) ? { lat, lng } : null;
}

/** Pull the first recognised coordinate pair out of a map-service URL, else null. */
function coordsFromMapUrl(text: string): { lat: number; lng: number } | null {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }

  // OpenStreetMap marker params (`?mlat=&mlon=`).
  const mlat = url.searchParams.get('mlat');
  const mlon = url.searchParams.get('mlon');
  if (mlat !== null && mlon !== null) {
    const lat = Number(mlat);
    const lng = Number(mlon);
    if (inGeoRange(lat, lng)) {
      return { lat, lng };
    }
  }

  // Google / Apple Maps query params carrying a `lat,lng` (`?q=`, `?query=`, `?ll=`).
  for (const key of ['q', 'query', 'll']) {
    const pair = parseCoordPair(url.searchParams.get(key));
    if (pair) {
      return pair;
    }
  }

  // Google's `@lat,lng,zoom` path segment.
  const at = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(url.pathname);
  if (at) {
    const lat = Number(at[1]);
    const lng = Number(at[2]);
    if (inGeoRange(lat, lng)) {
      return { lat, lng };
    }
  }

  // OpenStreetMap `#map=zoom/lat/lng` fragment.
  const map = /map=\d+(?:\.\d+)?\/(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)/.exec(
    url.hash,
  );
  if (map) {
    const lat = Number(map[1]);
    const lng = Number(map[2]);
    if (inGeoRange(lat, lng)) {
      return { lat, lng };
    }
  }

  return null;
}

/**
 * Parse a human-entered location into coordinates, trying in order:
 *  - a `geo:lat,lng` URI,
 *  - a plain `lat, lng` (comma- or space-separated),
 *  - an OpenStreetMap link (`?mlat=&mlon=` or the `#map=zoom/lat/lng` fragment),
 *  - a Google / Apple Maps link (`?q=`/`?query=`/`?ll=` or an `@lat,lng` segment).
 * Returns null when no in-range coordinate can be extracted. Backs the desktop
 * manual-location dialog, where Chromium can't resolve a real device position.
 */
export function parseLocationInput(
  input: unknown,
): { lat: number; lng: number } | null {
  if (typeof input !== 'string') {
    return null;
  }
  const text = input.trim();
  if (text === '') {
    return null;
  }

  const geo = parseGeoUri(text);
  if (geo) {
    return inGeoRange(geo.lat, geo.lng) ? geo : null;
  }

  const plain = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(text);
  if (plain) {
    const lat = Number(plain[1]);
    const lng = Number(plain[2]);
    return inGeoRange(lat, lng) ? { lat, lng } : null;
  }

  return coordsFromMapUrl(text);
}

/** An aggregated reaction (`m.annotation`) on a message. */
export interface ReactionView {
  /** The reaction key (usually an emoji). */
  key: string;
  /** How many users reacted with this key. */
  count: number;
  /** Whether the current user is among them (their reaction can be toggled off). */
  reacted: boolean;
}

/** A compact preview of the message a reply points at. */
export interface ReplyPreview {
  id: string;
  senderName: string;
  senderInitial: string;
  senderAvatarMxc: string | null;
  body: string;
}

/** A single rendered timeline message (plain view model — no SDK types leak out). */
export interface MessageView {
  id: string;
  senderId: string;
  senderName: string;
  senderInitial: string;
  senderAvatarMxc: string | null;
  /** Plain-text fallback. */
  body: string;
  /** Sanitized-on-render HTML from `formatted_body` (markdown), or null for plain. */
  html: string | null;
  timestamp: number;
  isOwn: boolean;
  decryptionFailed: boolean;
  /** True once the message has been edited (m.replace). */
  edited: boolean;
  /** Aggregated reactions, ordered by the SDK (count then first-seen). */
  reactions: ReactionView[];
  /** The message this one replies to (`m.in_reply_to`), if loaded. */
  replyTo: ReplyPreview | null;
  /** Local-echo send state: 'sending' / 'failed', or null once confirmed. */
  status: 'sending' | 'failed' | null;
  kind: MessageKind;
  /** Media attachment for image/file/video/audio messages, else null. */
  media: MediaPayload | null;
  /** MSC2530 caption text on a media message (else null). */
  caption: string | null;
  /** Sanitized HTML for a rich media caption (else null). */
  captionHtml: string | null;
  /** Members whose read receipt sits on this message ("seen by"), excluding you. */
  readReceipts: ReceiptView[];
  /** The projected poll (question + live tallies) when `kind` is `'poll'`, else null. */
  poll: PollView | null;
  /** The shared location when `kind` is `'location'`, else null/absent. */
  location?: LocationView | null;
  /**
   * Authenticity shield for an encrypted message (grey = caution, red = warning), or
   * null/absent when there's nothing to flag / the message isn't encrypted. Resolved
   * asynchronously (the crypto trust API is async), so it's supplied by the caller.
   */
  shield?: MessageShield | null;
  /**
   * The first URL in a plain-text message to show a link preview for, or null/absent.
   * Present regardless of room encryption; consumers combine it with
   * {@link previewEncrypted} and the user's link-preview preferences to decide whether to
   * actually fetch a preview (which discloses the URL to the homeserver's preview proxy).
   */
  previewUrl?: string | null;
  /**
   * Whether this message's room is end-to-end encrypted (fail-closed: true when the
   * encryption state can't be determined). Gates {@link previewUrl}: previewing an
   * encrypted message's link would disclose it to the homeserver, so it happens only when
   * the user has explicitly opted into previews in encrypted rooms.
   */
  previewEncrypted?: boolean;
  /**
   * For a `kind: 'event'` row, the human-readable one-line summary of the state /
   * membership change (e.g. `Alice changed the room name to "General"`). Absent otherwise.
   */
  summary?: string | null;
}

/** An authenticity shield on an encrypted message, with a human-readable reason. */
export interface MessageShield {
  level: 'grey' | 'red';
  reason: string;
}

/** A member who has read up to a message, for the "seen by" receipt avatars. */
export interface ReceiptView {
  userId: string;
  name: string;
  initial: string;
  avatarMxc: string | null;
}

/** How many receipt avatars to show on a message before it gets noisy. */
const MAX_RECEIPTS = 5;

/**
 * Cap on a received voice message's waveform bars. Renders one DOM node each, so an
 * attacker-controlled `org.matrix.msc1767.audio.waveform` is bounded on receive; well
 * above any sender's real bar count (send uses 60).
 */
const MAX_WAVEFORM_BARS = 512;

/** User ids (excluding the local user) whose read receipt sits on this event, capped. */
export function readReceiptUserIds(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): string[] {
  const selfId = client.getUserId();
  return (room.getUsersReadUpTo?.(event) ?? [])
    .filter((id) => id !== selfId)
    .slice(0, MAX_RECEIPTS);
}

/** The "seen by" receipts for this event: members whose read marker sits on it. */
export function readReceiptsFor(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): ReceiptView[] {
  return readReceiptUserIds(client, room, event).map((userId) => {
    const member = room.getMember(userId);
    const name = member?.name || userId;
    return {
      userId,
      name,
      initial: initialOf(name),
      avatarMxc: member?.getMxcAvatarUrl() ?? null,
    };
  });
}

/**
 * Project a single timeline (or thread) event into a {@link MessageView}, resolving
 * the sender from room state, decryption state, reactions, and reply preview.
 */
export function buildMessageView(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  shield: MessageShield | null = null,
): MessageView {
  const senderId = event.getSender() ?? '';
  const member = room.getMember(senderId);
  // `||` (not `??`) so an empty display name still falls back to the mxid.
  const senderName = member?.name || senderId;
  const decryptionFailed = event.isDecryptionFailure();
  // A poll renders as its own kind, driven by the projected PollView rather than the
  // usual message body — so branch before renderBody (which expects m.room.message).
  const poll = isPollStart(event) ? buildPollView(client, room, event) : null;
  const {
    body,
    html,
    kind,
    media,
    caption = null,
    captionHtml = null,
    location = null,
  } = poll
    ? {
        body: poll.question,
        html: null,
        kind: 'poll' as const,
        media: null,
        caption: null,
        captionHtml: null,
        location: null,
      }
    : renderBody(event, decryptionFailed);
  return {
    id: event.getId() ?? '',
    senderId,
    senderName,
    senderInitial: initialOf(senderName),
    senderAvatarMxc: member?.getMxcAvatarUrl() ?? null,
    body,
    html,
    timestamp: event.getTs(),
    isOwn: senderId === client.getUserId(),
    decryptionFailed,
    edited: event.replacingEvent() !== null,
    reactions: reactionsFor(client, room, event),
    replyTo: event.replyEventId ? replyPreview(room, event.replyEventId) : null,
    status: mapStatus(event.status),
    kind,
    media,
    caption,
    captionHtml,
    readReceipts: readReceiptsFor(client, room, event),
    poll,
    location,
    shield,
    // The first URL in a plain-text message, for a link-preview card. Whether it's
    // actually previewed is decided downstream from `previewEncrypted` + the user's
    // preferences — a preview fetch discloses the URL to the homeserver, so in an
    // encrypted room it happens only when the user has opted in.
    previewUrl: kind === 'text' ? firstUrl(body) : null,
    // Fail CLOSED: if the SDK can't report the room's encryption state, treat it as
    // encrypted so a preview requires the explicit encrypted-rooms opt-in.
    previewEncrypted: room.hasEncryptionStateEvent?.() ?? true,
  };
}

/**
 * {@link buildMessageView} guarded against a hostile/malformed event: any projection
 * error degrades that one event to an 'unsupported' row instead of throwing out of the
 * timeline/thread projection loop (which would leave the whole room unrenderable and
 * re-crash on every resync). Callers project untrusted, federated events, so they must
 * use this rather than {@link buildMessageView} directly.
 */
export function safeBuildMessageView(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  shield: MessageShield | null = null,
): MessageView {
  try {
    return buildMessageView(client, room, event, shield);
  } catch {
    return unsupportedView(client, event);
  }
}

/** A minimal, fully-defensive 'unsupported' fallback view for an un-projectable event. */
function unsupportedView(
  client: MatrixClient,
  event: MatrixEvent,
): MessageView {
  const read = <T>(fn: () => T, fallback: T): T => {
    try {
      return fn();
    } catch {
      return fallback;
    }
  };
  const senderId = read(() => event.getSender() ?? '', '');
  const senderName = senderId || 'Unknown';
  return {
    id: read(() => event.getId() ?? '', ''),
    senderId,
    senderName,
    senderInitial: initialOf(senderName),
    senderAvatarMxc: null,
    body: '[unsupported message]',
    html: null,
    timestamp: read(() => event.getTs(), 0),
    isOwn: read(() => senderId === client.getUserId(), false),
    decryptionFailed: false,
    edited: false,
    reactions: [],
    replyTo: null,
    status: null,
    kind: 'unsupported',
    media: null,
    caption: null,
    captionHtml: null,
    readReceipts: [],
    poll: null,
    location: null,
    shield: null,
    previewUrl: null,
    previewEncrypted: true,
  };
}

/** True when an event should render as a message row (a plain message or poll). */
export function isDisplayableMessage(event: MatrixEvent): boolean {
  if (isPollStart(event)) {
    return true;
  }
  return (
    event.getType() === EventType.RoomMessage &&
    !event.isRelation(RelationType.Replace)
  );
}

/**
 * Whether the current user may edit this view: own, confirmed (no pending/failed
 * send), decrypted, and an editable *text* kind. Only `text`/`emote`/`notice` carry
 * an editable body — media, polls, and locations are not free text and a
 * text `m.replace` would corrupt them (a poll/location has no `media` to gate on).
 * Shared by the main timeline and the in-thread composer so the rule stays in one place.
 */
export function isEditableMessage(message: MessageView): boolean {
  return (
    message.isOwn &&
    !message.status &&
    !message.decryptionFailed &&
    (message.kind === 'text' ||
      message.kind === 'emote' ||
      message.kind === 'notice')
  );
}

/** Build a short preview of a replied-to message, or null if it isn't loaded. */
export function replyPreview(room: Room, eventId: string): ReplyPreview | null {
  const target = room.findEventById(eventId);
  if (!target) {
    return null;
  }
  const sender = target.getSender() ?? '';
  const member = room.getMember(sender);
  // `||` (not `??`) so an empty display name still falls back to the mxid.
  const senderName = member?.name || sender;
  const raw = target.isRedacted()
    ? '(message deleted)'
    : stripReplyFallbackText((target.getContent()['body'] as string) ?? '');
  return {
    id: eventId,
    senderName,
    senderInitial: initialOf(senderName),
    senderAvatarMxc: member?.getMxcAvatarUrl() ?? null,
    body: raw.replace(/\s+/g, ' ').trim() || '…',
  };
}

/**
 * Add the user ids whose room membership a rendered message depends on — the
 * sender (shown in the header) and, for a reply, the quoted sender shown in the
 * reply preview — into `into`. A projection uses this to re-map only when a member
 * it actually references loads or changes its name/avatar, rather than on every
 * member update in a large room. The reply target's sender is included only when
 * the target is loaded, which is exactly when a (possibly stale) preview renders.
 */
export function collectMessageSenders(
  room: Room,
  event: MatrixEvent,
  into: Set<string>,
): void {
  const sender = event.getSender();
  if (sender) {
    into.add(sender);
  }
  const replyId = event.replyEventId;
  if (replyId) {
    const targetSender = room.findEventById(replyId)?.getSender();
    if (targetSender) {
      into.add(targetSender);
    }
  }
}

/** Read aggregated reactions for an event from the room's relations. */
export function reactionsFor(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): ReactionView[] {
  const id = event.getId();
  if (!id) {
    return [];
  }
  const annotations = room.relations
    .getChildEventsForEvent(id, RelationType.Annotation, EventType.Reaction)
    ?.getSortedAnnotationsByKey();
  if (!annotations) {
    return [];
  }
  const myId = client.getUserId();
  const views: ReactionView[] = [];
  for (const [key, set] of annotations) {
    const events = [...set].filter((e) => !e.isRedacted());
    if (events.length === 0) {
      continue;
    }
    views.push({
      key,
      count: events.length,
      reacted: events.some((e) => e.getSender() === myId),
    });
  }
  return views;
}

export function mapStatus(
  status: EventStatus | null,
): 'sending' | 'failed' | null {
  if (status === EventStatus.SENDING || status === EventStatus.QUEUED) {
    return 'sending';
  }
  if (status === EventStatus.NOT_SENT) {
    return 'failed';
  }
  return null;
}

// Tags/attributes permitted in Matrix `org.matrix.custom.html` message bodies
// (the spec allowlist). Anything outside this set is stripped.
const MATRIX_ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'caption',
  'code',
  'del',
  'div',
  'em',
  'font',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'i',
  'img',
  'li',
  'ol',
  'p',
  'pre',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'table',
  'tbody',
  'td',
  'th',
  'thead',
  'tr',
  'u',
  'ul',
  'details',
  'summary',
];
// `target` is intentionally omitted: dropping it avoids reverse-tabnabbing
// without needing a post-sanitize rel hook. (Opening message links in a new tab
// safely is a separate follow-up via a click handler.)
const MATRIX_ALLOWED_ATTR = [
  'href',
  'name',
  'alt',
  'title',
  'width',
  'height',
  'src',
  'start',
  'color',
  'class',
  'data-mx-bg-color',
  'data-mx-color',
  'data-mx-spoiler',
];

// Image sources we consider local (no network fetch on render). Remote schemes
// are stripped below so sender HTML can't smuggle a tracking pixel.
const LOCAL_IMG_SCHEME = /^(?:mxc|blob|data):/i;

// The only `class` tokens Matrix sanctions: `language-*` (syntax highlighting on
// <code>) and the spoiler class. `class` is otherwise allowed globally, so a
// sender could borrow app/Ionic classes to spoof UI chrome — restrict to these.
const ALLOWED_CLASS = /^(?:language-[\w-]+|mx-spoiler)$/;

// A sender's `formatted_body` can embed `<img src="https://attacker/x.gif">`,
// which the browser would fetch on render — leaking the viewer's IP and acting
// as a read receipt. Inline mxc rendering isn't wired yet, so strip the `src`
// of any non-local image: this blocks remote auto-loading outright while
// leaving mxc/blob/data sources intact for when inline rendering lands. The hook
// also filters the `class` attribute to the Matrix-sanctioned allowlist. Hook is
// registered once at module load; it only affects `sanitizeMatrixHtml` (the
// composer path uses Angular's DomSanitizer, not DOMPurify).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName === 'IMG' && node.hasAttribute('src')) {
    const src = node.getAttribute('src') ?? '';
    if (!LOCAL_IMG_SCHEME.test(src)) {
      node.removeAttribute('src');
    }
  }
  if (node.hasAttribute('class')) {
    const kept = (node.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((token) => ALLOWED_CLASS.test(token));
    if (kept.length > 0) {
      node.setAttribute('class', kept.join(' '));
    } else {
      node.removeAttribute('class');
    }
  }
  // Normalise a spoiler for the renderer. `data-mx-spoiler` marks it in Matrix HTML,
  // but Angular's `[innerHTML]` sanitizer (the defence-in-depth re-scrub at the render
  // leaf) drops all `data-*` attributes — so tag it with the sanctioned `mx-spoiler`
  // class instead (class/tabindex/role all survive that pass). Focusable + role=button
  // so keyboard users can reveal it too (pointer users get click-to-reveal).
  if (node.hasAttribute('data-mx-spoiler')) {
    node.classList.add('mx-spoiler');
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
  }
});

// Memoize sanitization by raw input: DOMPurify is a pure function of the html
// string (the config + hook are constant), so the same `formatted_body` always
// yields the same scrubbed output. Caching it means the timeline/thread
// projections can re-derive a view (status flip, edit, decryption) without paying
// for DOMPurify again, and identical bodies across messages are scrubbed once.
// Bounded with FIFO eviction so a long-lived session can't grow it unboundedly.
const SANITIZED_HTML_CACHE_MAX = 1000;
const sanitizedHtmlCache = new Map<string, string>();

/**
 * Sanitize sender-provided HTML (`formatted_body`) against the Matrix allowlist.
 * Federated, end-to-end-encrypted content is untrusted and can't be scanned
 * server-side, so it is scrubbed here *explicitly* rather than relying on
 * Angular's implicit `[innerHTML]` sanitization at the render leaf. Never wrap
 * the result in `bypassSecurityTrust*`. The result is memoized by raw input (see
 * {@link sanitizedHtmlCache}); the scrubbed output is identical regardless.
 */
export function sanitizeMatrixHtml(html: string): string {
  const memoized = sanitizedHtmlCache.get(html);
  if (memoized !== undefined) {
    return memoized;
  }
  const clean = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MATRIX_ALLOWED_TAGS,
    ALLOWED_ATTR: MATRIX_ALLOWED_ATTR,
    // Only safe URL schemes on href/src (DOMPurify also blocks javascript:).
    ALLOWED_URI_REGEXP: /^(?:https?|ftp|mailto|magnet|mxc):/i,
  });
  if (sanitizedHtmlCache.size >= SANITIZED_HTML_CACHE_MAX) {
    const oldest = sanitizedHtmlCache.keys().next().value;
    if (oldest !== undefined) {
      sanitizedHtmlCache.delete(oldest);
    }
  }
  sanitizedHtmlCache.set(html, clean);
  return clean;
}

interface RenderedBody {
  body: string;
  html: string | null;
  kind: MessageKind;
  media: MediaPayload | null;
  caption?: string | null;
  captionHtml?: string | null;
  location?: LocationView | null;
}

function renderBody(
  event: MatrixEvent,
  decryptionFailed: boolean,
): RenderedBody {
  if (decryptionFailed) {
    return {
      body: '⚠️ Unable to decrypt this message',
      html: null,
      kind: 'unsupported',
      media: null,
    };
  }
  if (event.isRedacted()) {
    return {
      body: '(message deleted)',
      html: null,
      kind: 'redacted',
      media: null,
    };
  }
  const content = event.getContent();
  const isReply = !!event.replyEventId;
  const raw = (content['body'] as string) ?? '';
  const text = isReply ? stripReplyFallbackText(raw) : raw;
  // Markdown is delivered as HTML in `formatted_body` (format = custom HTML).
  const rawHtml =
    content['format'] === 'org.matrix.custom.html' &&
    typeof content['formatted_body'] === 'string'
      ? (content['formatted_body'] as string)
      : null;
  const strippedHtml =
    isReply && rawHtml ? stripReplyFallbackHtml(rawHtml) : rawHtml;
  const html = strippedHtml === null ? null : sanitizeMatrixHtml(strippedHtml);

  // Plain text (no formatted_body) still gets bare URLs linkified so they're clickable.
  const textHtml = html ?? linkifyText(text);
  switch (content.msgtype) {
    case MsgType.Text:
      return { body: text, html: textHtml, kind: 'text', media: null };
    case MsgType.Emote:
      return { body: text, html: textHtml, kind: 'emote', media: null };
    case MsgType.Notice:
      return { body: text, html: textHtml, kind: 'notice', media: null };
    case MsgType.Location: {
      const geo = parseGeoUri(content['geo_uri']);
      if (!geo) {
        return {
          body: text || '[location]',
          html: null,
          kind: 'unsupported',
          media: null,
        };
      }
      const label = text || 'Shared location';
      return {
        body: label,
        html: null,
        kind: 'location',
        media: null,
        location: { ...geo, label },
      };
    }
    case MsgType.Image:
    case MsgType.File:
    case MsgType.Audio:
    case MsgType.Video: {
      const media = buildMediaPayload(content, content.msgtype);
      // A malformed media event (no url/file) falls back to a plain label.
      if (!media) {
        return {
          body: text || `[${String(content.msgtype).replace(/^m\./, '')}]`,
          html: null,
          kind: 'unsupported',
          media: null,
        };
      }
      // MSC2530: a `filename` distinct from `body` marks `body` as a caption —
      // render it alongside the media (rich when the sender formatted it).
      const captioned =
        typeof content['filename'] === 'string' &&
        !!text &&
        text !== media.filename;
      return {
        body: media.filename,
        html: null,
        kind: media.kind,
        media,
        caption: captioned ? text : null,
        captionHtml: captioned ? html : null,
      };
    }
    default:
      return {
        body: text || '[unsupported message]',
        html: null,
        kind: 'unsupported',
        media: null,
      };
  }
}

/** MIME types we never render inline (script-bearing), forced to download-only. */
const UNSAFE_INLINE_MIME = /^(?:image\/svg\+xml|text\/html)$/i;

/**
 * Project an `m.image`/`m.file`/`m.video`/`m.audio` content block into a
 * {@link MediaPayload}, or null when it lacks a source (`url`/`file`). The kind is
 * derived from the msgtype, then downgraded to `'file'` (download-only) for unknown
 * or script-bearing MIME types so nothing scriptable is rendered inline.
 */
function buildMediaPayload(
  content: Record<string, unknown>,
  msgtype: string,
): MediaPayload | null {
  const mxc =
    typeof content['url'] === 'string' ? (content['url'] as string) : null;
  const file = asEncryptedFile(content['file']);
  if (!mxc && !file) {
    return null;
  }
  const info = (content['info'] ?? {}) as Record<string, unknown>;
  const mimeType =
    typeof info['mimetype'] === 'string'
      ? (info['mimetype'] as string)
      : 'application/octet-stream';

  let kind: MediaKind =
    msgtype === MsgType.Image
      ? 'image'
      : msgtype === MsgType.Video
        ? 'video'
        : msgtype === MsgType.Audio
          ? 'audio'
          : 'file';
  // Inline rendering requires a MIME that matches its category and isn't scriptable.
  const category = kind === 'file' ? null : kind;
  if (
    UNSAFE_INLINE_MIME.test(mimeType) ||
    (category && !mimeType.toLowerCase().startsWith(`${category}/`))
  ) {
    kind = 'file';
  }

  const filename =
    (typeof content['filename'] === 'string' && content['filename']) ||
    (typeof content['body'] === 'string' && content['body']) ||
    'attachment';

  const thumbInfo = (info['thumbnail_info'] ?? {}) as Record<string, unknown>;
  // MSC3245: an audio message marked as a voice message, with an MSC1767 waveform.
  const isVoice = kind === 'audio' && content[MSC3245_VOICE] !== undefined;
  const audioExt = (
    content[MSC1767_AUDIO] && typeof content[MSC1767_AUDIO] === 'object'
      ? content[MSC1767_AUDIO]
      : {}
  ) as Record<string, unknown>;
  // Cap the received waveform: it's attacker-controlled and rendered one DOM node
  // per entry, so an unbounded array is a memory/CPU-exhaustion vector.
  const waveform = Array.isArray(audioExt['waveform'])
    ? (audioExt['waveform'] as unknown[])
        .slice(0, MAX_WAVEFORM_BARS)
        .filter((n): n is number => typeof n === 'number')
    : [];
  return {
    kind,
    mxc,
    file,
    filename: filename as string,
    mimeType,
    size:
      typeof info['size'] === 'number' ? (info['size'] as number) : undefined,
    width: typeof info['w'] === 'number' ? (info['w'] as number) : undefined,
    height: typeof info['h'] === 'number' ? (info['h'] as number) : undefined,
    durationMs:
      typeof info['duration'] === 'number'
        ? (info['duration'] as number)
        : typeof audioExt['duration'] === 'number'
          ? (audioExt['duration'] as number)
          : undefined,
    thumbnailMxc:
      typeof info['thumbnail_url'] === 'string'
        ? (info['thumbnail_url'] as string)
        : null,
    thumbnailFile: asEncryptedFile(info['thumbnail_file']),
    thumbnailMimeType:
      typeof thumbInfo['mimetype'] === 'string'
        ? (thumbInfo['mimetype'] as string)
        : undefined,
    ...(isVoice ? { isVoice: true, waveform } : {}),
  };
}

/** Narrow an untyped `content.file`/`thumbnail_file` to {@link EncryptedFileInfo}. */
function asEncryptedFile(value: unknown): EncryptedFileInfo | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const f = value as Record<string, unknown>;
  if (typeof f['url'] === 'string' && typeof f['iv'] === 'string' && f['key']) {
    return f as unknown as EncryptedFileInfo;
  }
  return null;
}

/**
 * Strip the rich-reply fallback from a body: the leading `> …` quote lines and
 * the blank line that separates them from the actual reply text.
 */
export function stripReplyFallbackText(body: string): string {
  if (!body.startsWith('>')) {
    return body;
  }
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].startsWith('>')) {
    i++;
  }
  if (i < lines.length && lines[i].trim() === '') {
    i++;
  }
  return lines.slice(i).join('\n');
}

/** Strip the `<mx-reply>…</mx-reply>` fallback block from formatted (HTML) replies. */
function stripReplyFallbackHtml(html: string): string {
  return html.replace(/<mx-reply>[\s\S]*?<\/mx-reply>/i, '');
}

/**
 * Turn a plain-text body into HTML with clickable links: HTML-escape the text, wrap each
 * http(s) URL in an `<a>`, and keep newlines as `<br>`. Returns `null` when the text has
 * no URL, so a plain message keeps its lighter (pre-wrap) text rendering. Trailing
 * sentence punctuation is left outside the link. Used so a bare URL is clickable even
 * when the sender delivered it as plain text (no formatted_body).
 */
export function linkifyText(text: string): string | null {
  // A local regex — its `lastIndex` advances across the loop and resets per call.
  const re = /https?:\/\/[^\s<>"']+/g;
  let hasLink = false;
  let html = '';
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    const whole = match[0];
    const url = whole.replace(/[.,;:!?)\]}>]+$/, '');
    const trailing = whole.slice(url.length);
    const safeUrl = escapeHtml(url);
    html +=
      escapeHtml(text.slice(lastIndex, match.index)) +
      `<a href="${safeUrl}">${safeUrl}</a>` +
      escapeHtml(trailing);
    lastIndex = match.index + whole.length;
    hasLink = true;
  }
  if (!hasLink) {
    return null;
  }
  return (html + escapeHtml(text.slice(lastIndex))).replace(/\n/g, '<br>');
}

/** The first http(s) URL in `text` (trailing sentence punctuation trimmed), or null. */
export function firstUrl(text: string): string | null {
  const match = /https?:\/\/[^\s<>"']+/.exec(text);
  if (!match) {
    return null;
  }
  return match[0].replace(/[.,;:!?)\]}>]+$/, '');
}

/** Escape text for safe interpolation into the `<mx-reply>` HTML fallback. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** First visible character (sans leading sigil), uppercased, for fallback avatars. */
export function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}
