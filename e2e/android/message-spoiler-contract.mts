import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export const MESSAGE_SPOILER_SOURCE =
  'e2e/browser/journeys/conversations/message-spoiler.spec.mts';
/** The predecessor at the issue's pin; `fe2c7c3e` left it unchanged. */
export const MESSAGE_SPOILER_SOURCE_SHA256 =
  'd89c5751a43ac54b44329e2d65b9e7b0db2974118f6198d2fff1d6f0d050f673';
export const MESSAGE_SPOILER_SOURCE_LINES = 111;

export const MESSAGE_SPOILER_SHARED_SOURCE_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
} as const;

export const MESSAGE_SPOILER_STAGE_IDS = ['conceal-reveal'] as const;

export type MessageSpoilerStageId = (typeof MESSAGE_SPOILER_STAGE_IDS)[number];

export interface MessageSpoilerSpan {
  readonly from: number;
  readonly to: number;
}

/** Owned predecessor spans: the fixture helper, the Room helper and the definition. */
export const MESSAGE_SPOILER_SPANS = {
  seedRoomWithSpoiler: { from: 20, to: 69 },
  openRoom: { from: 71, to: 79 },
  definitions: { 'conceal-reveal': { from: 84, to: 110 } },
} as const satisfies {
  readonly seedRoomWithSpoiler: MessageSpoilerSpan;
  readonly openRoom: MessageSpoilerSpan;
  readonly definitions: Readonly<Record<MessageSpoilerStageId, MessageSpoilerSpan>>;
};

/** The one helper whose own `expect` line an inherited site expands. */
export const MESSAGE_SPOILER_HELPERS = {
  openRoom: {
    module: MESSAGE_SPOILER_SOURCE,
    expectLines: [76],
    role: 'room-readiness',
  },
} as const satisfies Readonly<Record<string, {
  readonly module: string;
  readonly expectLines: readonly number[];
  readonly role: string;
}>>;

export type MessageSpoilerHelper = keyof typeof MESSAGE_SPOILER_HELPERS;

/**
 * One source-mapped parity site. `line` is the `expect` line. An inherited
 * site's `helper` owns that line and `call` is the definition-body call line.
 */
export type MessageSpoilerSite =
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'direct';
    }
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'inherited';
      readonly helper: MessageSpoilerHelper;
      readonly call: number;
    };

const concealRevealSites = [
  { line: 76, suffix: 'room-ready', kind: 'inherited', helper: 'openRoom', call: 96 },
  { line: 101, suffix: 'spoiler-visible', kind: 'direct' },
  { line: 102, suffix: 'initial-unrevealed', kind: 'direct' },
  { line: 104, suffix: 'initial-transparent', kind: 'direct' },
  { line: 108, suffix: 'revealed', kind: 'direct' },
  { line: 109, suffix: 'revealed-painted', kind: 'direct' },
] as const satisfies readonly MessageSpoilerSite[];

export type MessageSpoilerAssertion = `message-spoiler.${MessageSpoilerStageId}.${string}`;

export interface MessageSpoilerStage {
  readonly id: MessageSpoilerStageId;
  readonly source: string;
  readonly title: string;
  readonly sites: readonly MessageSpoilerSite[];
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly MessageSpoilerAssertion[];
}

function stage(
  id: MessageSpoilerStageId,
  title: string,
  sites: readonly MessageSpoilerSite[],
): MessageSpoilerStage {
  const span = MESSAGE_SPOILER_SPANS.definitions[id];
  return {
    id,
    source: `${MESSAGE_SPOILER_SOURCE}:${span.from}-${span.to}`,
    title,
    sites,
    expectedAssertionRecords: sites.length,
    assertions: sites.map(
      ({ suffix }): MessageSpoilerAssertion => `message-spoiler.${id}.${suffix}`,
    ),
  };
}

export const MESSAGE_SPOILER_STAGES: readonly MessageSpoilerStage[] = [
  stage('conceal-reveal', 'conceals a spoiler and reveals it on click', concealRevealSites),
];

export const MESSAGE_SPOILER_ASSERTION_RECORDS = 6;
export const MESSAGE_SPOILER_DIRECT = 5;
export const MESSAGE_SPOILER_INHERITED = 1;
/** Room readiness only; the fixture helper and login reach no `expect`. */
export const MESSAGE_SPOILER_HELPER_COUNTS = {
  openRoom: 1,
} as const satisfies Readonly<Record<MessageSpoilerHelper, number>>;

/** Direct sites order by line; a helper call runs before a later-line matcher. */
export function siteOrderKey(site: MessageSpoilerSite): readonly [number, number] {
  return site.kind === 'direct' ? [site.line, 1] : [site.call, 0];
}

function after(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] !== right[0] ? left[0] > right[0] : left[1] > right[1];
}

function within(line: number, span: MessageSpoilerSpan): boolean {
  return Number.isInteger(line) && line >= span.from && line <= span.to;
}

function validateContract(): void {
  assert.deepEqual(MESSAGE_SPOILER_STAGES.map(({ id }) => id),
    [...MESSAGE_SPOILER_STAGE_IDS], 'Message-spoiler stages keep source order');
  const sites = MESSAGE_SPOILER_STAGES.flatMap((entry) => entry.sites);
  const identities = MESSAGE_SPOILER_STAGES.flatMap((entry) => entry.assertions);
  assert.equal(sites.length, MESSAGE_SPOILER_ASSERTION_RECORDS,
    'Message-spoiler owns exactly 6 records');
  assert.equal(sites.filter((site) => site.kind === 'direct').length,
    MESSAGE_SPOILER_DIRECT, 'Message-spoiler owns exactly 5 direct sites');
  assert.equal(sites.filter((site) => site.kind === 'inherited').length,
    MESSAGE_SPOILER_INHERITED, 'Message-spoiler owns exactly 1 inherited site');
  assert.equal(new Set(identities).size, MESSAGE_SPOILER_ASSERTION_RECORDS,
    'Message-spoiler identities are unique');
  for (const [helper, expected] of Object.entries(MESSAGE_SPOILER_HELPER_COUNTS)) {
    assert.equal(sites.filter((site) =>
      site.kind === 'inherited' && site.helper === helper).length, expected,
    `${helper} expands exactly ${expected} time`);
  }
  for (const entry of MESSAGE_SPOILER_STAGES) {
    const span = MESSAGE_SPOILER_SPANS.definitions[entry.id];
    assert.equal(entry.expectedAssertionRecords, entry.sites.length,
      `${entry.id} expected records equal its sites`);
    for (const identity of entry.assertions) {
      assert.match(identity, new RegExp(
        `^message-spoiler\\.${entry.id}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`),
      `${identity} is a stage-local identity`);
    }
    let previous: readonly [number, number] = [0, 0];
    for (const site of entry.sites) {
      const key = siteOrderKey(site);
      assert(after(key, previous), `${entry.id}.${site.suffix} keeps source order`);
      previous = key;
      if (site.kind === 'direct') {
        assert(within(site.line, span),
          `${entry.id}.${site.suffix} lies inside its definition`);
        continue;
      }
      const lines: readonly number[] = MESSAGE_SPOILER_HELPERS[site.helper].expectLines;
      assert(lines.includes(site.line),
        `${entry.id}.${site.suffix} expands one of ${site.helper}'s expect lines`);
      assert(within(site.call, span),
        `${entry.id}.${site.suffix} call lies inside its definition`);
    }
  }
  assert(within(MESSAGE_SPOILER_HELPERS.openRoom.expectLines[0], MESSAGE_SPOILER_SPANS.openRoom),
    'The Room-readiness site lies inside the local openRoom helper');
}

validateContract();

function entryFor(stageId: MessageSpoilerStageId): MessageSpoilerStage {
  const entry = MESSAGE_SPOILER_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown message-spoiler stage ${stageId}`);
  return entry;
}

export function messageSpoilerStage(stageId: MessageSpoilerStageId): MessageSpoilerStage {
  return entryFor(stageId);
}

export function messageSpoilerAssertion(
  stageId: MessageSpoilerStageId,
  suffix: string,
): MessageSpoilerAssertion {
  const entry = entryFor(stageId);
  const identity: MessageSpoilerAssertion = `message-spoiler.${stageId}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertMessageSpoilerRecords(
  stageId: MessageSpoilerStageId,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stageId).assertions,
    `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for parity identities. */
export function assertMessageSpoilerReceiptName(name: string): void {
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `Receipt name ${name} is kebab-case`);
  assert(!name.startsWith('message-spoiler'), `Receipt ${name} is not a parity identity`);
}

// Predecessor fields: the run suffix (88), the Room name (28), the secret (29),
// the transaction (52) and the exact formatted content (56–59).

export const MESSAGE_SPOILER_RUN_SUFFIX = 's';
export const spoilerRoomName = (run: string): string => `Spoiler E2E ${run}`;
export const spoilerSecret = (run: string): string => `answer-${run}`;
export const spoilerTransaction = (run: string): string => `spoiler-${run}`;
export const SPOILER_EVENT_TYPE = 'm.room.message';
export const SPOILER_FORMAT = 'org.matrix.custom.html';
export const SPOILER_REVEALED_CLASS = 'is-revealed';

/** The exact `m.room.message` content the predecessor sends. */
export interface SpoilerContent {
  readonly msgtype: 'm.text';
  readonly body: string;
  readonly format: typeof SPOILER_FORMAT;
  readonly formatted_body: string;
}

export function spoilerContent(secret: string): SpoilerContent {
  return {
    msgtype: 'm.text',
    body: `the secret is ${secret}`,
    format: SPOILER_FORMAT,
    formatted_body: `the secret is <span data-mx-spoiler>${secret}</span>`,
  };
}

// Shared field readers.

function object(value: unknown, name: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value),
    `${name} is an object`);
  return value as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, name: string): string {
  const candidate = value[name];
  assert(typeof candidate === 'string', `${name} is a string`);
  return candidate;
}

function nullableStringField(value: Record<string, unknown>, name: string): string | null {
  const candidate = value[name];
  assert(candidate === null || typeof candidate === 'string', `${name} is a string or null`);
  return candidate;
}

function booleanField(value: Record<string, unknown>, name: string): boolean {
  const candidate = value[name];
  assert(typeof candidate === 'boolean', `${name} is a boolean`);
  return candidate;
}

function countField(value: Record<string, unknown>, name: string): number {
  const candidate = value[name];
  assert(typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0,
    `${name} is a nonnegative integer`);
  return candidate;
}

function nullableCountField(value: Record<string, unknown>, name: string): number | null {
  if (value[name] === null) return null;
  return countField(value, name);
}

function numberField(value: Record<string, unknown>, name: string): number {
  const candidate = value[name];
  assert(typeof candidate === 'number', `${name} is a number`);
  return candidate;
}

function arrayField(value: Record<string, unknown>, name: string): readonly unknown[] {
  const candidate = value[name];
  assert(Array.isArray(candidate), `${name} is an array`);
  return candidate;
}

// Applied profile and route.

/** The per-stage `profile-applied.json` payload read back from the WebView. */
export interface AppliedProfileObservation {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly devicePixelRatio: number;
  readonly coarsePointer: boolean;
  readonly hoverNone: boolean;
  readonly platform: string | null;
}

export function parseAppliedProfile(value: unknown): AppliedProfileObservation {
  const profile = object(value, 'Applied profile');
  for (const name of ['innerWidth', 'innerHeight', 'devicePixelRatio']) {
    const candidate = profile[name];
    assert(typeof candidate === 'number' && Number.isFinite(candidate) && candidate > 0,
      `Applied ${name} is positive`);
  }
  return {
    innerWidth: profile['innerWidth'] as number,
    innerHeight: profile['innerHeight'] as number,
    devicePixelRatio: profile['devicePixelRatio'] as number,
    coarsePointer: booleanField(profile, 'coarsePointer'),
    hoverNone: booleanField(profile, 'hoverNone'),
    platform: nullableStringField(profile, 'platform'),
  };
}

export function roomRouteSegment(roomId: string): string {
  return Buffer.from(roomId).toString('base64url');
}

export function assertRoomRoute(url: string, roomId: string, userId: string): void {
  const route = new URL(url);
  assert.equal(route.pathname, `/rooms/${roomRouteSegment(roomId)}`,
    'Native navigation reached the exact Room');
  assert.equal(route.searchParams.get('account'), userId,
    'Native navigation retained the exact Account');
  assert.equal(route.searchParams.get('view'), 'rooms',
    'Native navigation retained the Rooms view');
}

// Composer (Room readiness only; nothing is typed).

export interface ComposerObservation {
  readonly count: number;
  readonly visible: boolean;
  readonly placeholder: string | null;
  readonly href: string;
}

export function parseComposer(value: unknown): ComposerObservation {
  const composer = object(value, 'Composer observation');
  return {
    count: countField(composer, 'count'),
    visible: booleanField(composer, 'visible'),
    placeholder: nullableStringField(composer, 'placeholder'),
    href: stringField(composer, 'href'),
  };
}

export interface RoomIdentity {
  readonly name: string;
  readonly roomId: string;
  readonly userId: string;
}

/** Helper line 76: the composer of the exact Room is visible after native open. */
export function assertRoomReady(composer: ComposerObservation, room: RoomIdentity): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert(composer.visible, 'The composer is visible');
  assert.equal(composer.placeholder, `Message #${room.name}`,
    'The composer names the exact Room');
  assertRoomRoute(composer.href, room.roomId, room.userId);
}

// Authoritative server event.

type MatrixEvent = Readonly<Record<string, unknown>>;

/** Every `m.room.message` in one `/messages?dir=b&limit=50` page, oldest first. */
export function authoritativeRoomMessages(response: unknown): readonly MatrixEvent[] {
  const page = object(response, 'Room messages page');
  return arrayField(page, 'chunk')
    .map((event, index) => object(event, `Room messages event ${index}`))
    .filter((event) => event['type'] === SPOILER_EVENT_TYPE)
    .reverse();
}

export interface SpoilerExpectation {
  readonly eventId: string;
  readonly roomId: string;
  readonly sender: string;
  readonly secret: string;
}

/** `data-mx-spoiler` spans in a formatted body, however they are written. */
export function spoilerSpanCount(html: string): number {
  return [...html.matchAll(/data-mx-spoiler/giu)].length;
}

/**
 * Lines 51–62 on real Synapse: the Room holds exactly the one arranged message,
 * an original `m.text` from the Account whose content is exactly the
 * predecessor's, with exactly one `data-mx-spoiler` span around the secret.
 */
export function assertSpoilerRoom(
  events: readonly MatrixEvent[],
  expected: SpoilerExpectation,
): MatrixEvent {
  assert.equal(events.length, 1, 'The Room holds exactly the arranged message');
  const event = events[0]!;
  assert.equal(event['event_id'], expected.eventId, 'The server event is the arranged event');
  assert.equal(event['room_id'], expected.roomId, 'The event belongs to the exact Room');
  assert.equal(event['sender'], expected.sender, 'The event has the arranging sender');
  assert.equal(event['type'], SPOILER_EVENT_TYPE, 'The event is a Room message');
  const content = object(event['content'], 'Event content');
  assert(!('m.relates_to' in content) && !('m.new_content' in content),
    'The event is an original message with no relation');
  assert(isDeepStrictEqual(content, { ...spoilerContent(expected.secret) }),
    'The event content is exactly the predecessor spoiler message');
  assert.equal(spoilerSpanCount(stringField(content, 'formatted_body')), 1,
    'The formatted body holds exactly one spoiler span');
  return event;
}

// The rendered spoiler leaf.

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface SpoilerLeafObservation {
  readonly rowId: string | null;
  readonly rowEvent: boolean;
  readonly rowText: string;
  readonly text: string;
  readonly nested: number;
  readonly revealed: boolean;
  readonly visible: boolean;
  readonly rects: number;
  readonly box: Box;
  /** Centre then four inset corners, each a read-only hit test inside the leaf. */
  readonly hits: readonly boolean[];
  /** Running CSS animations and transitions; `null` where the API is absent. */
  readonly animations: number | null;
  readonly color: string;
  readonly backgroundColor: string;
}

export interface SpoilerObservation {
  readonly scrollers: number;
  readonly conversation: Box | null;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly devicePixelRatio: number;
  readonly leaves: readonly SpoilerLeafObservation[];
}

function parseBox(value: unknown, name: string): Box {
  const box = object(value, name);
  return {
    left: numberField(box, 'left'),
    top: numberField(box, 'top'),
    right: numberField(box, 'right'),
    bottom: numberField(box, 'bottom'),
    width: numberField(box, 'width'),
    height: numberField(box, 'height'),
  };
}

export function parseSpoiler(value: unknown): SpoilerObservation {
  const view = object(value, 'Spoiler observation');
  const viewport = object(view['viewport'], 'Viewport');
  return {
    scrollers: countField(view, 'scrollers'),
    conversation: view['conversation'] === null
      ? null : parseBox(view['conversation'], 'Conversation box'),
    viewport: { width: numberField(viewport, 'width'), height: numberField(viewport, 'height') },
    devicePixelRatio: numberField(view, 'devicePixelRatio'),
    leaves: arrayField(view, 'leaves').map((raw, index): SpoilerLeafObservation => {
      const leaf = object(raw, `Spoiler leaf ${index}`);
      const hits = arrayField(leaf, 'hits');
      assert(hits.length === 5 && hits.every((hit) => typeof hit === 'boolean'),
        'Spoiler leaf has five boolean hit tests');
      return {
        rowId: nullableStringField(leaf, 'rowId'),
        rowEvent: booleanField(leaf, 'rowEvent'),
        rowText: stringField(leaf, 'rowText'),
        text: stringField(leaf, 'text'),
        nested: countField(leaf, 'nested'),
        revealed: booleanField(leaf, 'revealed'),
        visible: booleanField(leaf, 'visible'),
        rects: countField(leaf, 'rects'),
        box: parseBox(leaf['box'], 'Spoiler leaf box'),
        hits: hits as boolean[],
        animations: nullableCountField(leaf, 'animations'),
        color: stringField(leaf, 'color'),
        backgroundColor: stringField(leaf, 'backgroundColor'),
      };
    }),
  };
}

function intersects(left: Box, right: Box): boolean {
  return left.left < right.right && left.right > right.left &&
    left.top < right.bottom && left.bottom > right.top;
}

/**
 * Lines 100–101: the Room renders exactly one spoiler leaf; it is the exact
 * secret, in the arranged event's row, visible over the conversation and
 * unobstructed at its centre.
 */
export function assertSpoilerVisible(
  view: SpoilerObservation,
  expected: SpoilerExpectation,
): SpoilerLeafObservation {
  assert.equal(view.scrollers, 1, 'Exactly one conversation scroller');
  assert.equal(view.leaves.length, 1, 'Exactly one rendered spoiler leaf in the Room');
  const leaf = view.leaves[0]!;
  assert.equal(leaf.text, expected.secret, 'The leaf holds exactly the secret');
  assert.equal(leaf.nested, 0, 'The leaf holds no nested spoiler');
  assert.equal(leaf.rowId, expected.eventId, 'The leaf lies in the arranged event row');
  assert(!leaf.rowEvent, 'The leaf row is a message, not a Room event');
  assert(leaf.rowText.includes(spoilerContent(expected.secret).body),
    'The leaf row carries the exact body');
  assert(leaf.visible, 'The spoiler leaf is visible');
  const { box } = leaf;
  for (const value of [box.left, box.top, box.right, box.bottom, box.width, box.height])
    assert(Number.isFinite(value), 'The leaf box is finite');
  assert(box.width > 0 && box.height > 0, 'The leaf box is non-zero');
  assert(view.conversation && intersects(box, view.conversation),
    'The leaf lies over the conversation');
  assert(leaf.hits[0], 'The leaf is topmost at its centre');
  return leaf;
}

/** Line 102: the leaf begins without the revealed state. */
export function assertInitialUnrevealed(
  view: SpoilerObservation,
  expected: SpoilerExpectation,
): SpoilerLeafObservation {
  const leaf = assertSpoilerVisible(view, expected);
  assert(!leaf.revealed, 'The leaf begins without the revealed state');
  return leaf;
}

// Computed colour.

const ALPHA = /^(?:(\d*\.?\d+(?:e[+-]?\d+)?)(%)?)$/iu;

function alphaValue(token: string): number | null {
  const match = ALPHA.exec(token.trim());
  if (!match) return null;
  const value = Number(match[1]) / (match[2] ? 100 : 1);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : null;
}

/**
 * The alpha of one computed CSS colour: legacy `rgb()`/`rgba()`/`hsl()`/`hsla()`
 * with commas, space-separated forms with `/ alpha`, and functional spaces such
 * as `oklch()`, `lab()` and `color()`. `null` when the colour is not understood.
 */
export function cssColorAlpha(color: string): number | null {
  const text = color.trim().toLowerCase();
  if (text === 'transparent') return 0;
  const match = /^([a-z-]+)\((.*)\)$/u.exec(text);
  if (!match) return null;
  const [, name, args] = match as unknown as [string, string, string];
  if (!/^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/u.test(name)) return null;
  if (args.includes('/')) {
    const parts = args.split('/');
    if (parts.length !== 2) return null;
    return alphaValue(parts[1]!);
  }
  if (args.includes(',')) {
    const parts = args.split(',');
    if (parts.length === 3) return 1;
    if (parts.length === 4) return alphaValue(parts[3]!);
    return null;
  }
  const parts = args.trim().split(/\s+/u);
  const channels = name === 'color' ? 4 : 3;
  return parts.length === channels && parts.every((part) => part.length > 0) ? 1 : null;
}

/** Line 104: the unrevealed leaf's own computed text colour is fully transparent. */
export function assertInitialTransparent(
  view: SpoilerObservation,
  expected: SpoilerExpectation,
): number {
  const leaf = assertInitialUnrevealed(view, expected);
  const alpha = cssColorAlpha(leaf.color);
  assert(alpha !== null, 'The computed text colour is understood');
  assert.equal(alpha, 0, 'The concealed text is painted fully transparent');
  return alpha;
}

/** The black bar: the concealed leaf paints a background of its own. */
export function assertBlackBar(
  view: SpoilerObservation,
  expected: SpoilerExpectation,
): number {
  assertInitialTransparent(view, expected);
  const alpha = cssColorAlpha(view.leaves[0]!.backgroundColor);
  assert(alpha !== null, 'The computed bar colour is understood');
  assert(alpha > 0, 'The concealed leaf paints its bar');
  return alpha;
}

/** Line 108: after the native tap the same single leaf carries the revealed state. */
export function assertRevealed(
  view: SpoilerObservation,
  expected: SpoilerExpectation,
): SpoilerLeafObservation {
  const leaf = assertSpoilerVisible(view, expected);
  assert(leaf.revealed, 'The leaf gained the revealed state');
  return leaf;
}

/** Line 109: the revealed leaf's own computed text colour is no longer transparent. */
export function assertRevealedPainted(
  view: SpoilerObservation,
  expected: SpoilerExpectation,
): number {
  const leaf = assertRevealed(view, expected);
  const alpha = cssColorAlpha(leaf.color);
  assert(alpha !== null, 'The computed text colour is understood');
  assert(alpha > 0, 'The revealed text is painted');
  return alpha;
}

// Leaf-scoped visual capture.

export type SpoilerCaptureState = 'concealed' | 'revealed' | 'failed';

export interface SpoilerClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A capture is scoped to exactly the one leaf: one client rect inside the
 * viewport, unobstructed at its centre and four inset corners, with no running
 * animation. The clip is the leaf box in viewport CSS pixels.
 */
export function assertCaptureScope(view: SpoilerObservation): SpoilerClip {
  assert.equal(view.scrollers, 1, 'Exactly one conversation scroller');
  assert.equal(view.leaves.length, 1, 'Exactly one spoiler leaf to capture');
  const leaf = view.leaves[0]!;
  const { box } = leaf;
  assert(leaf.visible, 'The captured leaf is visible');
  assert.equal(leaf.rects, 1, 'The captured leaf is one unwrapped box');
  for (const value of [box.left, box.top, box.right, box.bottom, box.width, box.height])
    assert(Number.isFinite(value), 'The captured box is finite');
  assert(box.width >= 2 && box.height >= 2, 'The captured box is measurable');
  assert(box.left >= 0 && box.top >= 0 &&
    box.right <= view.viewport.width && box.bottom <= view.viewport.height,
  'The captured leaf lies inside the viewport');
  assert(view.conversation &&
    box.left >= view.conversation.left && box.right <= view.conversation.right &&
    box.top >= view.conversation.top && box.bottom <= view.conversation.bottom,
  'The captured leaf lies inside the conversation');
  assert(leaf.hits.every(Boolean), 'Nothing covers the captured leaf');
  assert.equal(leaf.animations, 0, 'The captured leaf paint has settled');
  return { x: box.left, y: box.top, width: box.width, height: box.height };
}

/** The concealed capture: the exact unrevealed, transparent, barred leaf, settled. */
export function assertConcealedCapture(
  view: SpoilerObservation,
  expected: SpoilerExpectation,
): SpoilerClip {
  assertBlackBar(view, expected);
  return assertCaptureScope(view);
}

/** The revealed capture: the exact revealed, painted leaf, settled. */
export function assertRevealedCapture(
  view: SpoilerObservation,
  expected: SpoilerExpectation,
): SpoilerClip {
  assertRevealedPainted(view, expected);
  return assertCaptureScope(view);
}

/** Width and height from a PNG's IHDR chunk; rejects anything that is not a PNG. */
export function pngDimensions(png: Uint8Array): { readonly width: number; readonly height: number } {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  assert(png.length >= 24 && signature.every((byte, index) => png[index] === byte),
    'The capture is a PNG');
  assert.equal(Buffer.from(png.subarray(12, 16)).toString('latin1'), 'IHDR',
    'The PNG starts with its header chunk');
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/** Device-pixel corners of a clip, as the client maps native taps. */
export interface NativeClip {
  readonly topLeft: { readonly x: number; readonly y: number };
  readonly bottomRight: { readonly x: number; readonly y: number };
}

/** The inclusive device-pixel crop of a mapped clip; it must be a real area. */
export function nativeCrop(native: NativeClip): {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
} {
  const { topLeft, bottomRight } = native;
  for (const value of [topLeft.x, topLeft.y, bottomRight.x, bottomRight.y])
    assert(Number.isInteger(value) && value >= 0, 'The native clip is in whole device pixels');
  const crop = {
    left: topLeft.x,
    top: topLeft.y,
    width: bottomRight.x - topLeft.x + 1,
    height: bottomRight.y - topLeft.y + 1,
  };
  assert(crop.width >= 2 && crop.height >= 2, 'The native clip covers the leaf');
  return crop;
}

/** The raster covers exactly the mapped device-pixel crop of the leaf. */
export function assertRasterMatchesNative(
  dimensions: { readonly width: number; readonly height: number },
  native: NativeClip,
): void {
  const crop = nativeCrop(native);
  assert(dimensions.width === crop.width && dimensions.height === crop.height,
    'The capture covers exactly the leaf clip');
}
