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
import { displaySafeMime, mimeEssence } from './display-mime';
import { isPollStart } from './poll';
import { MSC1767_AUDIO, MSC3245_VOICE } from './voice';
import { trimTrailing } from './trim-trailing';
import {
  isMatrixLinkHref,
  matrixToPermalink,
  parseMatrixLink,
  parseMatrixToLink,
} from './matrix-to';

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

/**
 * User ids whose read receipt sits on this event, capped. Excludes the local user and
 * the event's author, whose receipt on their own message carries no information.
 */
function readReceiptUserIds(
  client: MatrixClient,
  room: Room,
  event: MatrixEvent,
): string[] {
  const selfId = client.getUserId();
  const senderId = event.getSender();
  return (room.getUsersReadUpTo?.(event) ?? [])
    .filter((id) => id !== selfId && id !== senderId)
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
 * True when an event should render as a message row (message, sticker, or poll). A state
 * event never is, whatever its type: it is room state, not a turn in the conversation.
 */
export function isDisplayableMessage(event: MatrixEvent): boolean {
  if (event.isState()) {
    return false;
  }
  if (isPollStart(event)) {
    return true;
  }
  return (
    (event.getType() === EventType.RoomMessage ||
      event.getType() === EventType.Sticker) &&
    !event.isRelation(RelationType.Replace)
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
  's',
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
// `target` and `rel` stay out of the allowlist, so a sender's own values never survive;
// `markExternalLinks` sets them render-side on http(s) links only.
const MATRIX_ALLOWED_ATTR = [
  'href',
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
  'data-mx-emoticon',
  'data-mx-spoiler',
  'data-mx-maths',
];

/**
 * Attributes whose values are not URIs. DOMPurify tests the value of every attribute it does
 * not consider URI-safe against ALLOWED_URI_REGEXP, and ours admits only Matrix's schemes, so
 * without this `color="#ff0000"`, `start="3"` and an image's `width`/`height` were dropped.
 */
const MATRIX_URI_SAFE_ATTR = ['color', 'start', 'width', 'height'];

/**
 * The attributes Matrix permits on each tag ("Clients should only permit the attributes listed
 * for the tags below", spec v1.19 § m.room.message msgtypes). Keyed by upper-case `nodeName`;
 * a tag missing here keeps no attribute. `font` is deprecated (v1.10) and kept only so older
 * messages still read as their sender meant; `sanitizeOutgoingHtml` never sends it. `input` is
 * the render path's GFM checkbox, read by {@link normaliseTaskItems} and then removed. An
 * image's `width`/`height` reserve its box: {@link normaliseImages} keeps only plain 1–5 digit
 * values, and the feature layer draws an inline image no taller than 300px and no wider than the
 * body (`--trinity-message-image-max-height` on `img.mx-image` in
 * `apps/trinity/src/rendered-markdown.scss`), so a sender's size cannot open a huge empty box.
 */
const MATRIX_TAG_ATTRIBUTES: ReadonlyMap<string, ReadonlySet<string>> = new Map<
  string,
  ReadonlySet<string>
>([
  ['A', new Set(['href'])],
  [
    'IMG',
    new Set(['width', 'height', 'alt', 'title', 'src', 'data-mx-emoticon']),
  ],
  ['OL', new Set(['start'])],
  ['CODE', new Set(['class'])],
  [
    'SPAN',
    new Set([
      'data-mx-color',
      'data-mx-bg-color',
      'data-mx-spoiler',
      'data-mx-maths',
    ]),
  ],
  ['DIV', new Set(['data-mx-maths'])],
  ['FONT', new Set(['color', 'data-mx-color', 'data-mx-bg-color'])],
  ['INPUT', new Set(['type', 'checked'])],
]);

const NO_ATTRIBUTES: ReadonlySet<string> = new Set();

// The only image source Matrix permits ("src (provided it is a Matrix Content (mxc://) URI)",
// spec v1.19). Every other scheme is stripped below, so sender HTML can neither smuggle a
// tracking pixel nor embed a `data:` payload; such an image becomes its alt text.
const MXC_SCHEME = /^mxc:\/\//i;

// A sender's `<img src>` must BE an `mxc://` URI, not merely become one. DOMPurify trims every
// attribute value before its attribute hooks see it, so the raw value is checked here, first:
// ` mxc://…` or `\u0001mxc://…` loses its source instead of being trimmed into a valid one.
DOMPurify.addHook('beforeSanitizeAttributes', (node) => {
  if (
    node.nodeName === 'IMG' &&
    !MXC_SCHEME.test(node.getAttribute('src') ?? '')
  ) {
    node.removeAttribute('src');
  }
});

// The only `class` tokens Matrix sanctions: `language-*`, on `code` (syntax highlighting). Every
// class the renderer needs (mx-spoiler, mx-emoticon, colour tokens, …) is added after this
// filter by a render-only pass, so a sender can borrow none of them, nor app/Ionic classes.
const ALLOWED_CLASS = /^language-[\w-]+$/;

// A sender's `formatted_body` can embed `<img src="https://attacker/x.gif">`,
// which the browser would fetch on render — leaking the viewer's IP and acting
// as a read receipt. So the hook above strips the `src` of any non-`mxc:` image. This one
// enforces the per-tag attribute list above and filters `class` to the Matrix-sanctioned tokens.
//
// Registered once at module load, and it applies to BOTH entry points — incoming
// {@link sanitizeMatrixHtml} and outgoing {@link sanitizeOutgoingHtml}. Only
// security belongs here for that reason: attributes set inside
// `afterSanitizeAttributes` are not re-filtered against ALLOWED_ATTR, so anything
// added here would ride out onto the wire too. Render-only normalisation lives in
// {@link normaliseSpoilers} and the other passes instead. It sits on the default DOMPurify
// instance, so any other sanitizer in the app must create its own (`DOMPurify(window)`), as
// the maths renderer does, or this per-tag table would strip its markup too.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  const allowed = MATRIX_TAG_ATTRIBUTES.get(node.nodeName) ?? NO_ATTRIBUTES;
  for (const name of node.getAttributeNames()) {
    if (!allowed.has(name)) node.removeAttribute(name);
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
  ADD_URI_SAFE_ATTR: MATRIX_URI_SAFE_ATTR,
  // Only safe URL schemes on href/src (DOMPurify also blocks javascript:).
  ALLOWED_URI_REGEXP: /^(?:https?|ftp|mailto|magnet|matrix|mxc):/i,
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
  ADD_URI_SAFE_ATTR: [...MATRIX_URI_SAFE_ATTR, 'type'],
  // No `as const` here, unlike the config above: it would make these three readonly tuples,
  // which do not satisfy DOMPurify's `string[]` config — the overload stops matching and the
  // `HTMLElement` downcast at the call site fails to compile. Vitest does not typecheck, so
  // this only surfaces in `nx build`.
};

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

/** "Tags must not be nested more than 100 levels deep" (spec v1.19). */
const MAX_NESTING_DEPTH = 100;

/**
 * Replace every element nested deeper than {@link MAX_NESTING_DEPTH} with its text. Iterative,
 * so hostile nesting cannot exhaust the stack, and linear: a flattened subtree is turned into
 * one text node and never visited again. Runs on both paths, before any render pass.
 */
function flattenDeepNesting(body: HTMLElement): void {
  const pending: Array<{ readonly element: Element; readonly depth: number }> =
    [{ element: body, depth: 0 }];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const depth = next.depth + 1;
    for (const child of [...next.element.children]) {
      if (depth > MAX_NESTING_DEPTH) {
        child.replaceWith(
          child.ownerDocument.createTextNode(child.textContent ?? ''),
        );
      } else {
        pending.push({ element: child, depth });
      }
    }
  }
}

/**
 * `font` and `strike` are read for older messages but never sent (deprecated in spec v1.10):
 * `font` gives way to its content and `strike` becomes `del`, which is what the markdown
 * renderer emits for `~~text~~`.
 */
function replaceDeprecatedTags(root: ParentNode): void {
  // The type argument selects the generic overload; lib.dom marks the `font`/`strike`
  // tag-name overloads deprecated, which `@typescript-eslint/no-deprecated` rejects.
  for (const font of root.querySelectorAll<HTMLElement>('font')) {
    font.replaceWith(...font.childNodes);
  }
  for (const strike of root.querySelectorAll<HTMLElement>('strike')) {
    const del = strike.ownerDocument.createElement('del');
    del.append(...strike.childNodes);
    strike.replaceWith(del);
  }
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
  flattenDeepNesting(body);
  normaliseMatrixUris(body);
  markExternalLinks(body);
  normaliseSpoilers(body);
  normaliseColours(body);
  normaliseImages(body);
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
 * Angular sanitizes `[innerHTML]` after this framework-free Matrix sanitizer and does not
 * trust custom URI schemes. Convert valid `matrix:` links to their equivalent HTTPS
 * matrix.to form before that second boundary. Malformed Matrix URIs become a deliberately
 * invalid Matrix permalink so the click directive can intercept them and explain the error
 * rather than leaving a dead or externally navigable link.
 */
function normaliseMatrixUris(body: HTMLElement): void {
  for (const anchor of body.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href') ?? '';
    if (!/^matrix:/i.test(href)) continue;
    const target = parseMatrixLink(href);
    anchor.setAttribute(
      'href',
      target
        ? matrixToPermalink(target)
        : 'https://matrix.to/#/__invalid-matrix-uri__',
    );
  }
}

/** A link that leaves Trinity: only `http(s)`. `mailto:`, `ftp:` and `magnet:` keep their behaviour. */
const EXTERNAL_LINK = /^https?:\/\//i;

/** The spec asks for `noopener`; `noreferrer` also keeps the room's URL out of the destination's logs. */
const EXTERNAL_LINK_REL = 'noopener noreferrer';

/**
 * What the URL parser drops from an href (URL Standard): leading C0 controls and spaces, and
 * ASCII tab, LF and CR anywhere. DOMPurify keeps them, so `\u0001https://…` and
 * `ht\ttps://…` still open `https://…`. Neither pattern can backtrack: the first is anchored
 * and non-global, the second matches one character at a time. Trailing controls don't change
 * the scheme, so they need no pass.
 */
const URL_LEADING_CONTROLS = /^[\u0000- ]+/;
const URL_TAB_OR_NEWLINE = /[\t\n\r]/g;

/**
 * Give every link that leaves Trinity `target="_blank"` and `rel="noopener noreferrer"`, so a
 * middle-click, a modifier-click, a context-menu open or a drag behaves like the plain click
 * `MatrixLinkDirective` already intercepts. Runs after {@link normaliseMatrixUris}, so a
 * `matrix:` link has become its `matrix.to` form and is skipped with the other permalinks,
 * which stay routed in Trinity.
 *
 * Render-only, like every pass after DOMPurify: `target` is in neither allowlist, so a
 * sender's own `target` never survives, and attributes set here never reach the wire.
 */
function markExternalLinks(root: ParentNode): void {
  for (const anchor of root.querySelectorAll('a[href]')) {
    const href = (anchor.getAttribute('href') ?? '')
      .replace(URL_LEADING_CONTROLS, '')
      .replace(URL_TAB_OR_NEWLINE, '');
    if (!EXTERNAL_LINK.test(href) || isMatrixLinkHref(href)) continue;
    // Write back the href the browser would open, so Angular's URL check sees it too.
    anchor.setAttribute('href', href);
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', EXTERNAL_LINK_REL);
  }
}

/**
 * {@link linkifyText}, with each link that leaves Trinity marked as {@link markExternalLinks}
 * marks it. `linkifyText` emits exactly `<a href="…">` with an escaped URL, so this matches only
 * its own output; the pattern is fixed, never built from the text.
 */
function linkifyMessageText(text: string): string | null {
  return (
    linkifyText(text)?.replace(/<a href="([^"]*)">/g, (anchor, href: string) =>
      EXTERNAL_LINK.test(href) && !isMatrixLinkHref(href)
        ? `<a href="${href}" target="_blank" rel="${EXTERNAL_LINK_REL}">`
        : anchor,
    ) ?? null
  );
}

/** Images one message may show inline (spec A2); past it the rest read as their alt text. */
const MAX_INLINE_IMAGES = 10;

/** A plain `mxc://server/media-id`, the shape the SDK accepts (as InlineMxcImagesDirective). */
const MXC_IMAGE_SOURCE = /^mxc:\/\/[^/\s]+\/[\w-]+$/;

/** A sender `width`/`height` the leaf may trust to reserve a box: 1–5 digits, nothing else. */
const SENDER_SIZE = /^\d{1,5}$/;

/**
 * Prepare every image for the render leaf. A valid `mxc://` source moves to `data-mx-src`:
 * Angular strips `data-*` at the leaf, so the browser never sees an `mxc:` URL (the CSP would
 * block it as a broken image), and InlineMxcImagesDirective re-reads the source from this string
 * and resolves it through authenticated media. Any other image (no source, `data:`, `blob:`,
 * remote), and every image over the cap, becomes its alt text here, never a fetch; without
 * one it reads "Image", so the reader still sees that something was there.
 *
 * MSC2545 custom emoji (`data-mx-emoticon`) are sized as before and capped at the leaf (50).
 * Other images are marked `mx-image`, the first {@link MAX_INLINE_IMAGES} only, so a crafted
 * message cannot fire many downloads; outside a link they are buttons that open the viewer,
 * named after their alt text ("Image" without one). Inside a link they follow the link. Their
 * `width`/`height` survive only as plain digits; the leaf caps the drawn size (300px tall).
 */
function normaliseImages(root: ParentNode): void {
  let inline = 0;
  for (const image of root.querySelectorAll('img')) {
    const source = image.getAttribute('src') ?? '';
    const alt = image.getAttribute('alt');
    const emote = image.hasAttribute('data-mx-emoticon');
    if (
      !MXC_IMAGE_SOURCE.test(source) ||
      (!emote && inline >= MAX_INLINE_IMAGES)
    ) {
      image.replaceWith(
        emote ? (alt ?? 'custom emoji') : alt?.trim() || 'Image',
      );
      continue;
    }
    image.removeAttribute('src');
    image.setAttribute('data-mx-src', source);
    if (emote) {
      image.classList.add('mx-emoticon');
      image.removeAttribute('width');
      image.setAttribute('height', '32');
      continue;
    }
    inline += 1;
    for (const size of ['width', 'height']) {
      if (!SENDER_SIZE.test(image.getAttribute(size) ?? '')) {
        image.removeAttribute(size);
      }
    }
    const name = alt?.trim();
    image.classList.add('mx-image');
    image.setAttribute('alt', name || 'Image');
    if (!image.closest('a[href]')) {
      image.setAttribute('role', 'button');
      image.setAttribute('tabindex', '0');
      image.setAttribute(
        'aria-label',
        name ? `View image: ${name}` : 'View image',
      );
    }
  }
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
  flattenDeepNesting(body);
  replaceDeprecatedTags(body);
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
 *
 * The reason is copied into `label`, which Angular keeps and which is inert on `span`; CSS
 * shows it as generated content on the concealed bar (rendered-markdown.scss), so it stays
 * out of `textContent`, copies and the edit-history diff. `aria-label` names the concealed
 * spoiler for screen readers instead of its hidden text; SpoilerRevealDirective removes it
 * and the role on reveal, and the tab stop once the revealed spoiler does not hold focus.
 */
function normaliseSpoilers(root: ParentNode): void {
  for (const node of root.querySelectorAll('[data-mx-spoiler]')) {
    node.classList.add('mx-spoiler');
    node.setAttribute('tabindex', '0');
    node.setAttribute('role', 'button');
    const reason = spoilerReason(node.getAttribute('data-mx-spoiler') ?? '');
    if (reason) {
      node.setAttribute('label', reason);
      node.setAttribute('aria-label', `Spoiler: ${reason}, activate to reveal`);
    } else {
      node.setAttribute('aria-label', 'Spoiler, activate to reveal');
    }
  }
}

/** Longest spoiler reason shown, in characters (code points, so an emoji is one). */
const MAX_SPOILER_REASON = 80;

/**
 * C0 and C1 controls other than the whitespace ones (tab to CR, which collapse to a space
 * instead), and the bidi marks, embeddings, overrides and isolates (ALM/LRM/RLM, U+202A–U+202E,
 * U+2066–U+2069): a reason must not reorder the bar's "Spoiler: " prefix or the message text
 * around it. One character per match, so it cannot backtrack.
 */
const SPOILER_REASON_CONTROLS =
  /[\u0000-\u0008\u000e-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/**
 * A sender's spoiler reason ("the reason (optionally) being in the `data-mx-spoiler`
 * attribute", spec v1.19) as one short line: controls stripped, trimmed, whitespace
 * collapsed, cut to {@link MAX_SPOILER_REASON}. Linear in the attribute's length.
 */
function spoilerReason(raw: string): string {
  const visible = raw.replace(SPOILER_REASON_CONTROLS, '');
  return Array.from(visible.trim().replace(/\s+/g, ' '))
    .slice(0, MAX_SPOILER_REASON)
    .join('')
    .trimEnd();
}

/** `#` and exactly six hex digits: the only sender colour Trinity applies (owner decision 2). */
const SENDER_COLOUR = /^#([0-9a-f]{6})$/i;

/**
 * Turn sender colours into class tokens the render leaf can read: `mx-fg-rrggbb` from
 * `data-mx-color` (or a `font`'s deprecated `color`), `mx-bg-rrggbb` from `data-mx-bg-color`.
 * Angular's `[innerHTML]` sanitizer strips `data-*` and `style` but keeps `class`, and the
 * colour is applied only after the leaf has checked its contrast against the current theme
 * (`SenderColoursDirective`), which this memoized, theme-free string cannot know. `color` is
 * removed so no browser paints a colour that has not been checked.
 *
 * Render-only and after DOMPurify: the allowlist hook has already removed every sender `class`
 * outside `code` (see {@link ALLOWED_CLASS}), so a sender cannot write a token directly.
 */
function normaliseColours(root: ParentNode): void {
  for (const node of root.querySelectorAll(
    'span[data-mx-color], span[data-mx-bg-color], font[data-mx-color], font[data-mx-bg-color], font[color]',
  )) {
    // The first valid colour wins, so an invalid `data-mx-color` can't hide a valid `font color`.
    const fg =
      SENDER_COLOUR.exec(node.getAttribute('data-mx-color') ?? '')?.[1] ??
      (node.nodeName === 'FONT'
        ? SENDER_COLOUR.exec(node.getAttribute('color') ?? '')?.[1]
        : undefined);
    const bg = SENDER_COLOUR.exec(
      node.getAttribute('data-mx-bg-color') ?? '',
    )?.[1];
    if (fg) node.classList.add(`mx-fg-${fg.toLowerCase()}`);
    if (bg) node.classList.add(`mx-bg-${bg.toLowerCase()}`);
    node.removeAttribute('color');
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
 * and wrap its lines for numbering. Syntax colouring is NOT done here: it happens at the
 * render leaf, only for rendered rows (see CodeHighlightDirective in the rooms feature).
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
 * Colouring is applied after DOMPurify and Angular's own `[innerHTML]` scrub, from DOM
 * nodes, so nothing it produces can be re-parsed as markup.
 */
function renderCodeBlocks(root: ParentNode): void {
  // A per-block cap is defeated by splitting, so line wrapping also has a per-message sum.
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
      lineBudget -= markCodeLines(code, source, lineBudget);
    }
  }
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
  lineBudget: number,
): number {
  if (!source) {
    return 0;
  }
  // A newline inside a child element would put two visual lines in one wrapper, and the
  // numbering would then lie, so only a block with no element children is wrapped.
  if (code.children.length > 0) {
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
 * Shared by Message Presentation and the edit-history projection so a past revision
 * renders exactly as the live message does.
 */
export function renderTextBody(
  content: Record<string, unknown>,
  isReply: boolean,
  /** The viewer, so a mention OF them can be marked. Omitted where it is unknown. */
  selfUserId = '',
): RenderedText {
  const rawHtml =
    content['format'] === 'org.matrix.custom.html' &&
    typeof content['formatted_body'] === 'string'
      ? (content['formatted_body'] as string)
      : null;
  // From `m.mentions`, never from the body: the sender writes the body, so a link in it
  // proves only that they typed your id, not that they addressed you.
  return renderNormalizedTextBody(
    typeof content['body'] === 'string' ? content['body'] : '',
    rawHtml,
    isReply,
    mentionsViewer(content, selfUserId),
  );
}

/** Render text after a Matrix adapter has normalized its content fields. */
export function renderNormalizedTextBody(
  body: string,
  formattedBody: string | null,
  isReply: boolean,
  addressesViewer: boolean,
): RenderedText {
  const text = isReply ? stripReplyFallbackText(body) : body;
  const strippedHtml =
    isReply && formattedBody
      ? stripReplyFallbackHtml(formattedBody)
      : formattedBody;
  const html =
    strippedHtml === null
      ? null
      : sanitizeMatrixHtml(strippedHtml, addressesViewer);

  // Plain text (no formatted_body) still gets bare URLs linkified so they're clickable.
  return { text, html, textHtml: html ?? linkifyMessageText(text) };
}

/** A well-formed essence for an inline kind: a bare `image`, `video` or `audio` type. */
const INLINE_ESSENCE = /^(?:image|video|audio)\/[a-z0-9][a-z0-9.+-]*$/;

/** Document types (compared by essence) that are only offered as downloads, never shown inline. */
const DOWNLOAD_ONLY_MIME: ReadonlySet<string> = new Set([
  'image/svg+xml',
  'text/html',
  'application/xhtml+xml',
  'application/xml',
  'text/xml',
]);

/**
 * Project an `m.image`/`m.file`/`m.video`/`m.audio` content block into a
 * {@link MediaPayload}, or null when it lacks a source (`url`/`file`). The kind is
 * derived from the msgtype, then downgraded to `'file'` (download-only) for a declared
 * MIME type that mismatches it, is a download-only document type, or is not a well-formed
 * essence, so only recognisable media is shown inline.
 */
export function normalizeMediaPayload(
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
  const declaredMime =
    typeof info['mimetype'] === 'string' ? (info['mimetype'] as string) : null;
  const mimeType = declaredMime ?? 'application/octet-stream';
  const essence = mimeEssence(declaredMime);

  let kind: MediaKind =
    msgtype === MsgType.Image
      ? 'image'
      : msgtype === MsgType.Video
        ? 'video'
        : msgtype === MsgType.Audio
          ? 'audio'
          : 'file';
  // A declared MIME must be a well-formed type of its category and not a download-only
  // document type. `info` is optional, so an undeclared one trusts the msgtype; the blob
  // stays opaque and the media element sniffs the bytes.
  const category = kind === 'file' ? null : kind;
  if (
    declaredMime !== null &&
    (DOWNLOAD_ONLY_MIME.has(essence) ||
      (category &&
        !(INLINE_ESSENCE.test(essence) && essence.startsWith(`${category}/`))))
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
        ? displaySafeMime(thumbInfo['mimetype'])
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
 * Sentence punctuation that is left outside a URL when it ends the match. `>` can never
 * be captured by the URL pattern's `[^\s<>"']+`; it stays to keep the original set.
 */
const TRAILING_URL_PUNCTUATION = '.,;:!?)]}>';

/** `url` without trailing sentence punctuation, in time linear in the URL length. */
function trimTrailingUrlPunctuation(url: string): string {
  return trimTrailing(url, TRAILING_URL_PUNCTUATION);
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
    const url = trimTrailingUrlPunctuation(whole);
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
  return trimTrailingUrlPunctuation(match[0]);
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
