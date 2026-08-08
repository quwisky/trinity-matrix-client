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
import { parseMatrixToLink } from './matrix-to';

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
  /**
   * The first few reactors by display name, for the pill's "reacted by …" hint —
   * `'You'` first when {@link reacted}. Capped at {@link MAX_NAMED_REACTORS}: the
   * hint only ever shows a handful, and this list is fingerprinted per event on
   * every projection (see `reactionSignature` in `TimelineService`), so it has to
   * stay bounded. The full list is read on demand by {@link reactionDetailsFor}.
   */
  reactors: string[];
}

/** One person who reacted, for the "who reacted" list. Mirrors {@link ReceiptView}. */
export interface ReactionReactor {
  userId: string;
  name: string;
  initial: string;
  avatarMxc: string | null;
}

/** Every reactor for one reaction key, for the "who reacted" dialog. */
export interface ReactionDetail {
  key: string;
  /** Whether the current user is among them. */
  reacted: boolean;
  reactors: ReactionReactor[];
}

/** How many reactors a reaction pill names before "and N others". */
export const MAX_NAMED_REACTORS = 3;

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
  /** What was found, in one line — the shield's own label. */
  reason: string;
  /** What that means for the reader, and what (if anything) resolves it. */
  explanation: string;
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
    : renderBody(event, decryptionFailed, client.getUserId() ?? '');
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

/**
 * A message whose text is worth pulling into the composer as a quote.
 *
 * Not gated on ownership, unlike {@link isEditableMessage} — quoting someone else is the
 * whole point. Media is excluded because its `body` is the filename, and quoting
 * `IMG_1234.jpg` helps nobody; so are polls, whose text is a question rather than a
 * statement, and anything that failed to decrypt, whose body is a placeholder.
 */
export function isQuotableMessage(message: MessageView): boolean {
  return (
    !message.decryptionFailed &&
    (message.kind === 'text' ||
      message.kind === 'emote' ||
      message.kind === 'notice') &&
    message.body.trim() !== ''
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
 * Add the user ids whose room membership a rendered message depends on into `into`:
 * the sender shown in the header, the quoted sender in a reply preview, the reactors a
 * pill names, and the readers whose "seen by" receipts sit on the event. A projection
 * uses this to re-map only when a member it actually references loads or changes its
 * name/avatar, rather than on every member update in a large room.
 *
 * Each group is bounded — the reply target's sender counts only while the target is
 * loaded (exactly when a possibly-stale preview renders), reactors stop at
 * `MAX_NAMED_REACTORS`, and readers at `MAX_RECEIPTS` — so the set stays proportional to
 * what is on screen rather than to the room's membership.
 */
export function collectMessageSenders(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
  into: Set<string>,
  /**
   * Pass `{ receipts: false }` for a row that renders no "seen by" avatars — a system
   * line, whose view is built with `readReceipts: []`. Collecting its readers would
   * admit members nothing on screen depends on, widening the very gate this feeds.
   */
  options: { receipts?: boolean } = {},
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
  // The reactors a pill names, whose display names can also arrive late. Only the
  // named ones: nobody beyond the cap renders, so nobody beyond it needs to re-map.
  for (const [, reactions] of reactionEventsFor(room, event)) {
    for (const reaction of reactions.slice(0, MAX_NAMED_REACTORS)) {
      const reactor = reaction.getSender();
      if (reactor) {
        into.add(reactor);
      }
    }
  }
  // The "seen by" readers, who render as avatars just like the sender does. A reader
  // who has never posted in the loaded window is reachable ONLY here — they are
  // nobody's sender, reply target or reactor — so without this their member event is
  // discarded at the gate and their avatar never arrives.
  if (options.receipts !== false) {
    for (const reader of readReceiptUserIds(client, room, event)) {
      into.add(reader);
    }
  }
}

/**
 * An event's live reactions grouped by key in the SDK's order (count, then first
 * seen), with redacted ones dropped and empty keys omitted. Shared by the pill
 * projection and the full "who reacted" list so both read the same set.
 */
function reactionEventsFor(
  room: Room,
  event: MatrixEvent,
): [string, MatrixEvent[]][] {
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
  const groups: [string, MatrixEvent[]][] = [];
  for (const [key, set] of annotations) {
    const events = [...set].filter((e) => !e.isRedacted());
    if (events.length > 0) {
      groups.push([key, events]);
    }
  }
  return groups;
}

/** A member's resolved display name, falling back to the raw mxid. */
function displayNameOf(room: Room, userId: string): string {
  // `||` (not `??`) so an empty display name still falls back to the mxid.
  return room.getMember(userId)?.name || userId;
}

/** Read aggregated reactions for an event from the room's relations. */
export function reactionsFor(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): ReactionView[] {
  const myId = client.getUserId();
  return reactionEventsFor(room, event).map(([key, reactions]) => ({
    key,
    count: reactions.length,
    reacted: reactions.some((e) => e.getSender() === myId),
    reactors: namedReactors(room, reactions, myId),
  }));
}

/** The first few reactors by display name, the local user first as "You". */
function namedReactors(
  room: Room,
  reactions: MatrixEvent[],
  myId: string | null,
): string[] {
  const names: string[] = [];
  if (reactions.some((e) => e.getSender() === myId)) {
    names.push('You');
  }
  for (const reaction of reactions) {
    if (names.length >= MAX_NAMED_REACTORS) {
      break;
    }
    const reactor = reaction.getSender();
    if (reactor && reactor !== myId) {
      names.push(displayNameOf(room, reactor));
    }
  }
  return names;
}

/**
 * Every reactor of every reaction on an event, grouped by key — the full list behind
 * a pill's capped {@link ReactionView.reactors} hint. Read on demand (when the "who
 * reacted" dialog opens) rather than carried on every {@link MessageView}, so a
 * heavily-reacted message costs nothing until someone asks.
 */
export function reactionDetailsFor(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): ReactionDetail[] {
  const myId = client.getUserId();
  return reactionEventsFor(room, event).map(([key, reactions]) => ({
    key,
    reacted: reactions.some((e) => e.getSender() === myId),
    reactors: reactions.flatMap((reaction) => {
      const userId = reaction.getSender();
      if (!userId) {
        return [];
      }
      const name = displayNameOf(room, userId);
      return [
        {
          userId,
          name,
          initial: initialOf(name),
          avatarMxc: room.getMember(userId)?.getMxcAvatarUrl() ?? null,
        },
      ];
    }),
  }));
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
// also filters the `class` attribute to the Matrix-sanctioned allowlist.
//
// Registered once at module load, and it applies to BOTH entry points — incoming
// {@link sanitizeMatrixHtml} and outgoing {@link sanitizeOutgoingHtml}. Only
// security belongs here for that reason: attributes set inside
// `afterSanitizeAttributes` are not re-filtered against ALLOWED_ATTR, so anything
// added here would ride out onto the wire too. Render-only normalisation lives in
// {@link normaliseSpoilers} instead.
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
});

// Memoize sanitization by raw input: DOMPurify is a pure function of the html
// string (the config + hook are constant), so the same `formatted_body` always
// yields the same scrubbed output. Caching it means the timeline/thread
// projections can re-derive a view (status flip, edit, decryption) without paying
// for DOMPurify again, and identical bodies across messages are scrubbed once.
// Bounded with FIFO eviction so a long-lived session can't grow it unboundedly.
const SANITIZED_HTML_CACHE_MAX = 1000;
const sanitizedHtmlCache = new Map<string, string>();

const MATRIX_PURIFY_CONFIG = {
  ALLOWED_TAGS: MATRIX_ALLOWED_TAGS,
  ALLOWED_ATTR: MATRIX_ALLOWED_ATTR,
  // Only safe URL schemes on href/src (DOMPurify also blocks javascript:).
  ALLOWED_URI_REGEXP: /^(?:https?|ftp|mailto|magnet|mxc):/i,
} as const;

/**
 * The render-side config: the Matrix allowlist plus `input` and the two attributes needed to
 * read a GFM checkbox other clients send. Nothing here reaches the output —
 * {@link normaliseTaskItems} replaces every input with its glyph and sweeps both attributes
 * off the tree before it is serialized. **Render only**: `sanitizeOutgoingHtml` keeps
 * {@link MATRIX_PURIFY_CONFIG} untouched, so none of this can widen what we send.
 */
const RENDER_PURIFY_CONFIG = {
  ...MATRIX_PURIFY_CONFIG,
  ADD_TAGS: ['input'],
  ADD_ATTR: ['type', 'checked'],
  // `type` needs this and `checked` does not, which is not obvious: DOMPurify tests the VALUE
  // of any attribute it does not consider URI-safe against ALLOWED_URI_REGEXP, and ours only
  // admits Matrix's schemes — so `type="checkbox"` failed that test and was dropped while the
  // valueless `checked` came through, leaving every incoming box indistinguishable and
  // unchecked. Marking it URI-safe skips the scheme test; the attribute is swept off the tree
  // either way before anything is serialized.
  ADD_URI_SAFE_ATTR: ['type'],
  // No `as const` here, unlike the config above: it would make these three readonly tuples,
  // which do not satisfy DOMPurify's `string[]` config — the overload stops matching and the
  // `HTMLElement` downcast at the call site fails to compile. Vitest does not typecheck, so
  // this only surfaces in `nx build`.
};

/**
 * Turns the source of a fenced code block into highlighted nodes, or null when the
 * language is unknown and it should be left as plain text.
 */
export type CodeHighlighter = (
  code: string,
  lang: string,
  doc: Document,
) => DocumentFragment | null;

let codeHighlighter: CodeHighlighter | null = null;

/**
 * Total characters of code one message may have highlighted. The highlighter caps a single
 * block; this caps their sum, so a sender cannot spend the main thread by splitting a huge
 * listing across many fenced blocks in one event.
 */
const MAX_HIGHLIGHT_CHARS_PER_MESSAGE = 20_000;

/** Class on each wrapped line of a code block; the numbering gutter hangs off it. */
const CODE_LINE_CLASS = 'code-line';

/**
 * Lines a block must EXCEED before it is marked for numbering.
 *
 * A gutter on a two-line snippet is noise, and most code in a conversation is a snippet.
 * The line-number setting's automatic mode — its default — shows numbers only past this;
 * "Always" ignores it, in CSS, since a preference must not reach the memoized markup.
 */
const LINE_NUMBER_THRESHOLD = 5;

/**
 * Lines beyond which a single block is left unwrapped entirely.
 *
 * Wrapping runs on every block of every message, including a back-pagination's worth, and a
 * sender controls block size up to the event limit. Past this the block renders normally,
 * just without numbers — cheaper than thousands of synchronous DOM nodes for a listing
 * nobody is counting lines in.
 */
const MAX_NUMBERED_LINES = 500;

/**
 * Lines one message may have wrapped in total.
 *
 * The per-block cap above is defeated by splitting, exactly as the tokenization cap is:
 * 125 blocks each one line under it is 62,000 spans and a two-megabyte serialization from a
 * single 64 KiB event — and that string is what {@link sanitizedHtmlCache} then retains,
 * bounded by entry count rather than bytes. This bounds their sum, so how the sender
 * arranges the lines stops mattering.
 */
const MAX_NUMBERED_LINES_PER_MESSAGE = 2_000;

/** `Node.TEXT_NODE`, spelled out because this module never touches a live `Node` global. */
const NODE_TYPE_TEXT = 3;

/**
 * Install (or clear) the syntax highlighter used by {@link sanitizeMatrixHtml}.
 *
 * A registration seam rather than a direct import: this module is in the app's EAGER
 * bundle, so importing a highlighter here would put every grammar in the initial
 * chunk. The implementation lives behind `@trinity/util/matrix/code-highlight`, which
 * only the lazily-loaded rooms route pulls in.
 *
 * Clears the memo, because anything cached before installation was scrubbed without
 * highlighting and would otherwise stay that way for the life of the process.
 */
export function setCodeHighlighter(highlighter: CodeHighlighter | null): void {
  codeHighlighter = highlighter;
  sanitizedHtmlCache.clear();
}

/**
 * Sanitize sender-provided HTML (`formatted_body`) for RENDERING, against the Matrix
 * allowlist. Federated, end-to-end-encrypted content is untrusted and can't be scanned
 * server-side, so it is scrubbed here *explicitly* rather than relying on Angular's
 * implicit `[innerHTML]` sanitization at the render leaf. Never wrap the result in
 * `bypassSecurityTrust*`. The result is memoized by raw input (see
 * {@link sanitizedHtmlCache}); the scrubbed output is identical regardless.
 *
 * Also applies render-only normalisation — spoiler tagging and syntax highlighting —
 * which is why {@link sanitizeOutgoingHtml} exists separately for the send path.
 */
export function sanitizeMatrixHtml(
  html: string,
  /** Set only when the event's `m.mentions` actually names the viewer — see
   * {@link markMentionPills} for why the href alone is not enough. */
  addressesViewer = false,
): string {
  // Whether this event addresses the viewer is part of the OUTPUT, so it has to be part of
  // the key. Keying on the html alone would hand one event's marking to another with the
  // same body — and, across an account switch, keep highlighting a mention of somebody you
  // are no longer signed in as.
  const cacheKey = `${addressesViewer ? '1' : '0'}\u0000${html}`;
  const memoized = sanitizedHtmlCache.get(cacheKey);
  if (memoized !== undefined) {
    return memoized;
  }
  // RETURN_DOM hands back the scrubbed <body> rather than a string, so the passes
  // below run on the tree DOMPurify already built: one parse, one serialize, and no
  // re-parsing of a fragment outside its original context.
  // `as const` on RETURN_DOM keeps DOMPurify's typed overload: spread into a plain object it
  // widens to `boolean` and the return type falls back to `string`. That matters because the
  // downcast below is then a compile ERROR rather than a silent lie — without it, dropping
  // RETURN_DOM in a later edit would still compile and leave `innerHTML` undefined at
  // runtime, rendering every message body as the literal string "undefined".
  const body = DOMPurify.sanitize(html, {
    ...RENDER_PURIFY_CONFIG,
    RETURN_DOM: true as const,
  }) as HTMLElement;
  normaliseSpoilers(body);
  normaliseTaskItems(body);
  renderCodeBlocks(body);
  markMentionPills(body, addressesViewer);
  const clean = body.innerHTML;
  if (sanitizedHtmlCache.size >= SANITIZED_HTML_CACHE_MAX) {
    const oldest = sanitizedHtmlCache.keys().next().value;
    if (oldest !== undefined) {
      sanitizedHtmlCache.delete(oldest);
    }
  }
  sanitizedHtmlCache.set(cacheKey, clean);
  return clean;
}

/**
 * Tag `matrix.to` user links so a mention reads as a mention rather than as an ordinary
 * link, and mark them as addressed to the viewer when the event says so.
 *
 * `.mention` is keyed off the href, which is right: a link to a user IS a mention of them,
 * and it makes mentions written in Element and other clients render the same as ours.
 *
 * `.mention--self` is NOT keyed off the href, and that is the point. `formatted_body` is
 * written by the sender, so anyone can put `<a href="…/@you">whatever</a>` in a message and
 * would otherwise get the solid "this is addressed to you" treatment without addressing you
 * at all. It is gated on the event's `m.mentions` instead, so the strong visual means
 * exactly what a notification means — which is the whole point of intentional mentions.
 *
 * A render-only pass, deliberately not in the `afterSanitizeAttributes` hook: attributes set
 * there are not re-filtered and would ride out onto the wire, so a sent message would carry
 * viewer-specific classes to everyone else.
 *
 * Running AFTER DOMPurify is what stops the CLASS being injected directly: `class` is
 * filtered to {@link ALLOWED_CLASS}, so by the time this adds one, anything the sender wrote
 * is already gone.
 */
function markMentionPills(body: HTMLElement, addressesViewer: boolean): void {
  for (const anchor of body.querySelectorAll('a[href]')) {
    const target = parseMatrixToLink(anchor.getAttribute('href') ?? '');
    if (target?.kind !== 'user') {
      continue;
    }
    anchor.classList.add('mention');
    if (addressesViewer) {
      anchor.classList.add('mention--self');
    }
  }
}

/**
 * Sanitize HTML we are about to SEND, against the same Matrix allowlist the incoming
 * path uses — so the client can never emit a `formatted_body` its own renderer would
 * strip.
 *
 * Deliberately applies none of {@link sanitizeMatrixHtml}'s render-only normalisation:
 * spoiler `class`/`tabindex`/`role` and syntax-highlight spans are presentation, and
 * putting them on the wire would bloat every event with markup other clients neither
 * expect nor keep. Not memoized either — every composed message is a distinct string,
 * so caching sends would only evict useful timeline entries.
 */
export function sanitizeOutgoingHtml(html: string): string {
  const body = DOMPurify.sanitize(html, {
    ...MATRIX_PURIFY_CONFIG,
    RETURN_DOM: true as const,
  }) as HTMLElement;
  enforceMxcImages(body);
  return body.innerHTML;
}

/**
 * Reduce every `<img>` we would send whose source is not `mxc:` to its alt text.
 *
 * Matrix accepts no other source, so anything else is an empty box on arrival. The markdown
 * renderer already turns such an image into a link or its caption (see `image()` in
 * message-content.ts) — but it only sees markdown image *tokens*, and marked hands raw HTML
 * straight through. So `<img src="data:image/png;base64,…">` typed into the composer walked
 * out the other door with its whole payload, and `<img src="https://…">` shipped as the
 * src-less box the renderer exists to avoid. Enforcing it here catches both, on the one path
 * everything outgoing shares.
 */
function enforceMxcImages(root: ParentNode): void {
  for (const img of root.querySelectorAll('img')) {
    if (!/^mxc:/i.test(img.getAttribute('src') ?? '')) {
      img.replaceWith(img.getAttribute('alt') ?? '');
    }
  }
}

/**
 * Tag spoilers for the renderer. `data-mx-spoiler` marks one in Matrix HTML, but
 * Angular's `[innerHTML]` sanitizer (the defence-in-depth re-scrub at the render leaf)
 * drops all `data-*` attributes — so mirror it onto the sanctioned `mx-spoiler` class
 * instead (class/tabindex/role all survive that pass). Focusable + role=button so
 * keyboard users can reveal it too (pointer users get click-to-reveal).
 *
 * Render-side only, and deliberately not in the DOMPurify hook: the hook runs on the
 * send path as well, and attributes it sets are not re-filtered against ALLOWED_ATTR —
 * so from there `tabindex`/`role` (in neither allowlist) would end up in outgoing
 * `formatted_body`.
 */
function normaliseSpoilers(root: ParentNode): void {
  for (const node of root.querySelectorAll('[data-mx-spoiler]')) {
    node.classList.add('mx-spoiler');
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
  }
}

/** The ballot glyphs a task item opens with, as written by the markdown checkbox renderer. */
const TASK_GLYPH = /^[☑☐]\s/;

/**
 * A GFM checkbox as text, done or not. The single definition of what a task item looks like:
 * the markdown renderer writes it on the way out, {@link normaliseTaskItems} writes it for
 * checkboxes arriving from other clients, and {@link TASK_GLYPH} matches it. The trailing
 * space separates it from the item's text and is what that pattern keys on.
 */
export function taskGlyph(checked: boolean): string {
  return checked ? '☑ ' : '☐ ';
}

/**
 * Turn every GFM checkbox into its glyph, and mark the items that carry one.
 *
 * Two sources, one result. Our own sends already carry ☑/☐ as text (the `checkbox` renderer
 * in message-content.ts — `input` is in neither allowlist, and a glyph is what survives into
 * every client, screen reader and plain-text fallback). **Everyone else sends the `<input>`**,
 * which the allowlist dropped on arrival — so an Element checklist rendered as bare items with
 * the done/not-done state simply gone. Converting it here makes both render identically.
 *
 * That is why {@link RENDER_PURIFY_CONFIG} lets `input` (and the two attributes needed to read
 * it) past DOMPurify: this pass is what removes them again. Every input is replaced or deleted
 * and both attributes are swept off the whole tree before anything is serialized, so neither
 * can reach the output — pinned by tests. The widening is render-only; `sanitizeOutgoingHtml`
 * keeps the untouched allowlist and still drops the tag outright.
 *
 * The `mx-task` class is keyed on the glyph OPENING the item: anywhere else it is a character
 * someone typed, and that item is a normal one that keeps its bullet. Presentational and
 * render-side only, exactly as {@link normaliseSpoilers} is — putting it in outgoing
 * `formatted_body` would be markup no other client asked for.
 */
function normaliseTaskItems(root: ParentNode): void {
  for (const box of root.querySelectorAll('input')) {
    const isCheckbox = box.getAttribute('type')?.toLowerCase() === 'checkbox';
    box.replaceWith(
      isCheckbox
        ? box.ownerDocument.createTextNode(
            taskGlyph(box.hasAttribute('checked')),
          )
        : // Anything else was never renderable here; drop it rather than leave a control.
          '',
    );
  }
  // `type`/`checked` are in neither Matrix allowlist. ADD_ATTR is per-call, not per-tag, so
  // they could otherwise ride out on an unrelated element that happened to carry one.
  for (const node of root.querySelectorAll('[type], [checked]')) {
    node.removeAttribute('type');
    node.removeAttribute('checked');
  }
  for (const item of root.querySelectorAll('li')) {
    if (TASK_GLYPH.test(item.textContent ?? '')) {
      item.classList.add('mx-task');
    }
  }
}

/** The language a fenced block declares, lowercased, or null when it declares none. */
function fencedLanguage(code: Element): string | null {
  return (
    /(?:^|\s)language-([\w-]+)(?:\s|$)/
      .exec(code.className)?.[1]
      ?.toLowerCase() ?? null
  );
}

/**
 * Prepare every fenced code block for rendering: caption it with the language it declares,
 * and syntax-highlight it when a grammar is loaded. One pass, because both need the same
 * elements and the same parsed language.
 *
 * **The caption is an attribute, not an element.** `language` is read back by CSS
 * (`pre[language]::after`, see rendered-markdown.scss). Generated content is not part of
 * `textContent`, which matters well beyond tidiness: the edit-history diff compares the text
 * of two rendered revisions, so an inserted caption node would make a fence-language-only
 * edit read as a text change, and would show up in every diff of a message containing code.
 * `data-lang` would have been the obvious attribute, but Angular's `[innerHTML]` sanitizer
 * strips all `data-*` — `language` is on its allowlist and carries no semantics of its own
 * (unlike `lang`, which declares a *natural* language to screen readers and translators).
 *
 * Captioning runs for EVERY block that declares a language, including ones no grammar is
 * loaded for: knowing a block is `elixir` is useful even when we cannot colour it.
 *
 * Highlighting runs AFTER DOMPurify on purpose: {@link ALLOWED_CLASS} restricts class tokens
 * to `language-*`/`mx-spoiler`, so token classes could not survive the scrub — and doing it
 * here means the memo above covers the cost. The highlighter returns DOM nodes, so nothing
 * it produces can be re-parsed as markup.
 */
function renderCodeBlocks(root: ParentNode): void {
  // A per-block cap alone is defeated by splitting: forty blocks just under the limit are
  // still a quarter-megabyte of synchronous tokenization. This bounds their sum within one
  // message. It does NOT bound a whole back-pagination, where each event is sanitized
  // separately — see the note on MAX_HIGHLIGHT_CHARS_PER_MESSAGE.
  let budget = MAX_HIGHLIGHT_CHARS_PER_MESSAGE;
  // The same argument applies to line wrapping, which adds DOM rather than spending CPU:
  // a per-block cap is defeated by splitting just as a per-block tokenization cap is.
  let lineBudget = MAX_NUMBERED_LINES_PER_MESSAGE;
  // Iterating `pre` rather than `pre > code[class]` because not every pass below needs a
  // language: a bare fence produces a `<code>` with no class at all, so a code-first query
  // cannot see it. Captioning and highlighting stay gated on the language individually.
  for (const pre of root.querySelectorAll('pre')) {
    for (const code of pre.querySelectorAll(':scope > code')) {
      const lang = fencedLanguage(code);
      if (lang) {
        pre.setAttribute('language', lang);
      }
      const source = code.textContent ?? '';
      // Charged only when tokenization actually happened. The highlighter declines
      // oversized blocks and unknown languages without doing the work, and charging for
      // those would starve blocks that could have been highlighted.
      const charged = highlightBlock(code, lang, source, budget);
      budget -= charged;
      lineBudget -= markCodeLines(code, source, charged > 0, lineBudget);
    }
  }
}

/**
 * Tokenize one block in place, returning the characters to charge against the message
 * budget — 0 when nothing was highlighted.
 *
 * Extracted from the loop so declining a block does not skip the passes after it: the
 * blocks this refuses (no language, no grammar, oversized, budget exhausted) are exactly
 * the long listings most worth numbering.
 */
function highlightBlock(
  code: Element,
  lang: string | null,
  source: string,
  budget: number,
): number {
  // Only ever tokenize plain text. The Matrix allowlist permits inline markup inside
  // <code> (a link, bold, a spoiler), and replacing the children would silently delete
  // it — worse, only for languages we happen to have a grammar for, so the same body
  // would render differently depending on its fence tag.
  if (!lang || !codeHighlighter || !source || code.children.length > 0) {
    return 0;
  }
  // Declining, not aborting: a later block small enough to fit should still be coloured
  // rather than being starved by one oversized listing earlier in the message.
  if (source.length > budget) {
    return 0;
  }
  const highlighted = codeHighlighter(source, lang, code.ownerDocument);
  if (!highlighted) {
    return 0;
  }
  code.replaceChildren(highlighted);
  return source.length;
}

/**
 * Wrap each line of a block in `<span class="code-line">` and record how many there are, so
 * CSS can number them.
 *
 * The numbers themselves are generated content keyed off these wrappers, never text — the
 * same rule the language caption follows, and for the same reasons: digits in the DOM would
 * be selectable, would land in the clipboard when someone copies a pasted file, and would
 * be read by the edit-history diff, which compares the *text* of two rendered revisions.
 * The wrappers add no characters, so `textContent` is byte-identical to the sender's source.
 *
 * The newlines stay OUTSIDE the wrappers, as siblings. Under `pre`'s `white-space: pre` they
 * are what break the lines, so the wrappers can remain inline and this becomes a
 * zero-layout-change transform; block-level wrappers would turn every one of those newlines
 * into a blank line of its own.
 *
 * `rows` rather than an invented attribute name: Angular's `[innerHTML]` sanitizer runs
 * again at the render leaf against a fixed allowlist, which admits `rows` and `language` but
 * would silently drop `numbered` or `data-lines`. It carries no meaning on `<pre>`, and the
 * count is what a threshold rule would want anyway. The threshold is applied HERE, from the
 * content, rather than in CSS, because `:has()` is below this app's browser floor — and
 * because a preference must never reach the markup, which is memoized per message and not
 * per viewer.
 */
function markCodeLines(
  code: Element,
  source: string,
  highlighted: boolean,
  lineBudget: number,
): number {
  if (!source) {
    return 0;
  }
  // A newline inside a child element would put two visual lines in one wrapper, and the
  // numbering would then lie. The highlighter guarantees no token spans a newline, so a
  // block it tokenized is safe; otherwise only a block with no element children is.
  if (!highlighted && code.children.length > 0) {
    return 0;
  }
  const lines = source.split('\n');
  // marked puts a trailing newline inside `<code>`, and so does commonmark, so very nearly
  // every real fence ends with one — from this client and from Element alike. Counting it
  // would number a phantom blank row at the end of every block and fire the threshold a
  // line early, numbering a five-line block under a setting labelled "over 5 lines".
  const trailingNewline = source.endsWith('\n');
  const count = trailingNewline ? lines.length - 1 : lines.length;
  // Two bounds, because a sender controls both the size of a block and how many of them a
  // message contains. Declining, not truncating: half a numbered listing would be worse
  // than an unnumbered one, and the block still renders normally either way.
  if (count > MAX_NUMBERED_LINES || count > lineBudget) {
    return 0;
  }

  const doc = code.ownerDocument;
  const wrapped: Node[] = [];
  let current: Node[] = [];
  const flush = (): void => {
    const line = doc.createElement('span');
    line.className = CODE_LINE_CLASS;
    // An empty wrapper on a blank line is deliberate: it still takes a number.
    line.append(...current);
    wrapped.push(line);
    current = [];
  };

  for (const node of [...code.childNodes]) {
    const text =
      node.nodeType === NODE_TYPE_TEXT ? (node.textContent ?? '') : '';
    if (!text.includes('\n')) {
      current.push(node);
      continue;
    }
    text.split('\n').forEach((segment, index) => {
      if (index > 0) {
        flush();
        wrapped.push(doc.createTextNode('\n'));
      }
      if (segment) {
        current.push(doc.createTextNode(segment));
      }
    });
  }
  // Skipped for a trailing newline: its final segment is empty, and flushing it would be
  // the phantom row. The `\n` text node itself has already been emitted, so `textContent`
  // stays byte-identical either way.
  if (!trailingNewline) {
    flush();
  }

  code.replaceChildren(...wrapped);
  if (count > LINE_NUMBER_THRESHOLD) {
    // On the `code`, not the `pre`. The Matrix allowlist lets a sender put two `<code>`
    // children in one `<pre>`: writing to the block would be last-writer-wins, so a long
    // listing followed by a short one kept a stale count, and the threshold gate applied to
    // both blocks from whichever wrote last. Per-`code` makes each block answer for itself,
    // and matches where the counter is reset.
    code.setAttribute('rows', String(count));
  }
  return count;
}

/**
 * Shown in place of a body we hold no key for. Exported so every surface that can render
 * an undecryptable message says the same thing — never the SDK's internal
 * `** Unable to decrypt: <reason> **`, which is a diagnostic, not a message to a user.
 */
export const UNDECRYPTABLE_BODY = '⚠️ Unable to decrypt this message';

interface RenderedBody {
  body: string;
  html: string | null;
  kind: MessageKind;
  media: MediaPayload | null;
  caption?: string | null;
  captionHtml?: string | null;
  location?: LocationView | null;
}

/** Whether an event's `m.mentions` names the viewer — the only trustworthy "this is for
 * you" signal, since everything else in the content is written by the sender. */
function mentionsViewer(
  content: Record<string, unknown>,
  selfUserId: string,
): boolean {
  if (selfUserId === '') {
    return false;
  }
  const mentions = content['m.mentions'];
  if (typeof mentions !== 'object' || mentions === null) {
    return false;
  }
  const ids = (mentions as { user_ids?: unknown }).user_ids;
  return Array.isArray(ids) && ids.includes(selfUserId);
}

/** The text of a message body, rendered every way the msgtype branches need it. */
export interface RenderedText {
  /** Plain text, with any reply fallback stripped. */
  text: string;
  /** Sanitized `formatted_body`, or null when the sender didn't format it. */
  html: string | null;
  /** What a text body renders as: `html`, else the plain text with URLs linkified. */
  textHtml: string | null;
}

/**
 * Render a message content block's text into its three forms. The distinction between
 * `html` and `textHtml` is load-bearing and not interchangeable: a text/emote/notice body
 * renders `textHtml` (so bare URLs are clickable), while an MSC2530 media caption renders
 * `html` — deliberately un-linkified, since a caption is a label rather than prose.
 *
 * Shared by {@link buildMessageView} and the edit-history projection so a past revision
 * renders exactly as the live message does.
 */
export function renderTextBody(
  content: Record<string, unknown>,
  isReply: boolean,
  /** The viewer, so a mention OF them can be marked. Omitted where it is unknown. */
  selfUserId = '',
): RenderedText {
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
  // From `m.mentions`, never from the body: the sender writes the body, so a link in it
  // proves only that they typed your id, not that they addressed you.
  const addressesViewer = mentionsViewer(content, selfUserId);
  const html =
    strippedHtml === null
      ? null
      : sanitizeMatrixHtml(strippedHtml, addressesViewer);

  // Plain text (no formatted_body) still gets bare URLs linkified so they're clickable.
  return { text, html, textHtml: html ?? linkifyText(text) };
}

function renderBody(
  event: MatrixEvent,
  decryptionFailed: boolean,
  selfUserId: string,
): RenderedBody {
  if (decryptionFailed) {
    return {
      body: UNDECRYPTABLE_BODY,
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
  const { text, html, textHtml } = renderTextBody(
    content,
    !!event.replyEventId,
    selfUserId,
  );
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
