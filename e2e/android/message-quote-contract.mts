import assert from 'node:assert/strict';

export const MESSAGE_QUOTE_SOURCE =
  'e2e/browser/journeys/conversations/message-quote.spec.mts';
/**
 * The predecessor at its branch hash. The issue pins `fdd2a9dc…`, its `develop`
 * parent; `fe2c7c3e` replaced three Enter presses with `sendComposerDraft` and
 * imported it, which moved every span down by one line.
 */
export const MESSAGE_QUOTE_SOURCE_SHA256 =
  '50b0e8a42aa1d61ee59b1c5dce97664365977aef7bc8b36aa3502e23e731064f';
export const MESSAGE_QUOTE_ISSUE_SOURCE_SHA256 =
  'fdd2a9dc98324aaea47a4d6fd3bf768bd35756119eafd4751faee849da5baf66';
export const MESSAGE_QUOTE_SOURCE_LINES = 218;

export const MESSAGE_QUOTE_SHARED_SOURCE_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
  'e2e/support/message-composer.mts':
    '4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d',
} as const;

export const MESSAGE_QUOTE_STAGE_IDS = ['quote-block', 'quote-capability'] as const;

export type MessageQuoteStageId = (typeof MESSAGE_QUOTE_STAGE_IDS)[number];

export interface MessageQuoteSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * Owned predecessor spans. Each definition owns its Android branches; the
 * desktop `else` branches (hover toolbar and overflow menu) are excluded.
 */
export const MESSAGE_QUOTE_SPANS = {
  openRoom: { from: 29, to: 37 },
  definitions: {
    'quote-block': { from: 42, to: 115 },
    'quote-capability': { from: 117, to: 217 },
  },
  androidBranches: {
    'quote-block': [{ from: 85, to: 87 }],
    'quote-capability': [{ from: 183, to: 187 }, { from: 201, to: 205 }],
  },
  desktopBranches: {
    'quote-block': [{ from: 88, to: 90 }],
    'quote-capability': [{ from: 188, to: 197 }, { from: 206, to: 216 }],
  },
} as const satisfies {
  readonly openRoom: MessageQuoteSpan;
  readonly definitions: Readonly<Record<MessageQuoteStageId, MessageQuoteSpan>>;
  readonly androidBranches: Readonly<Record<MessageQuoteStageId, readonly MessageQuoteSpan[]>>;
  readonly desktopBranches: Readonly<Record<MessageQuoteStageId, readonly MessageQuoteSpan[]>>;
};

/** Desktop-only `expect` sites inside the excluded branches; never parity records. */
export const MESSAGE_QUOTE_EXCLUDED_DESKTOP_SITES = [193, 212, 215] as const;

/**
 * Helpers whose own `expect` lines an inherited site expands. `openRoom` is the
 * predecessor's module-local helper; `sendComposerDraft` waits for the
 * composer's Send button before its mobile tap (53).
 */
export const MESSAGE_QUOTE_HELPERS = {
  openRoom: {
    module: MESSAGE_QUOTE_SOURCE,
    expectLines: [34],
    role: 'room-readiness',
  },
  sendComposerDraft: {
    module: 'e2e/support/message-composer.mts',
    expectLines: [53],
    role: 'composer-send-readiness',
  },
  waitForSent: {
    module: 'e2e/support/app.mts',
    expectLines: [178],
    role: 'real-server-echo',
  },
  openMessageActionSheet: {
    module: 'e2e/support/app.mts',
    expectLines: [220],
    role: 'action-sheet-readiness',
  },
} as const satisfies Readonly<Record<string, {
  readonly module: string;
  readonly expectLines: readonly number[];
  readonly role: string;
}>>;

export type MessageQuoteHelper = keyof typeof MESSAGE_QUOTE_HELPERS;

/**
 * One source-mapped parity site. `line` is the `expect` line. An inherited
 * site's `helper` owns that line and `call` is the definition-body call line.
 */
export type MessageQuoteSite =
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'direct';
    }
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'inherited';
      readonly helper: MessageQuoteHelper;
      readonly call: number;
    };

const quoteBlockSites = [
  { line: 34, suffix: 'room-ready', kind: 'inherited', helper: 'openRoom', call: 71 },
  { line: 53, suffix: 'source-send-enabled', kind: 'inherited', helper: 'sendComposerDraft', call: 79 },
  { line: 82, suffix: 'source-visible', kind: 'direct' },
  { line: 178, suffix: 'source-server-echo', kind: 'inherited', helper: 'waitForSent', call: 83 },
  { line: 220, suffix: 'sheet-ready', kind: 'inherited', helper: 'openMessageActionSheet', call: 86 },
  { line: 94, suffix: 'composer-quote', kind: 'direct' },
  { line: 53, suffix: 'answer-send-enabled', kind: 'inherited', helper: 'sendComposerDraft', call: 101 },
  { line: 104, suffix: 'answer-visible', kind: 'direct' },
  { line: 110, suffix: 'one-blockquote', kind: 'direct' },
  { line: 111, suffix: 'quotes-first', kind: 'direct' },
  { line: 112, suffix: 'quotes-second', kind: 'direct' },
  { line: 114, suffix: 'answer-outside', kind: 'direct' },
] as const satisfies readonly MessageQuoteSite[];

const quoteCapabilitySites = [
  { line: 34, suffix: 'room-ready', kind: 'inherited', helper: 'openRoom', call: 172 },
  { line: 53, suffix: 'control-send-enabled', kind: 'inherited', helper: 'sendComposerDraft', call: 178 },
  { line: 181, suffix: 'control-visible', kind: 'direct' },
  { line: 178, suffix: 'control-server-echo', kind: 'inherited', helper: 'waitForSent', call: 182 },
  { line: 220, suffix: 'text-sheet-ready', kind: 'inherited', helper: 'openMessageActionSheet', call: 184 },
  { line: 185, suffix: 'text-quote-visible', kind: 'direct' },
  { line: 187, suffix: 'text-sheet-closed', kind: 'direct' },
  { line: 200, suffix: 'image-visible', kind: 'direct' },
  { line: 220, suffix: 'image-sheet-ready', kind: 'inherited', helper: 'openMessageActionSheet', call: 202 },
  { line: 204, suffix: 'image-copy-visible', kind: 'direct' },
  { line: 205, suffix: 'image-no-quote', kind: 'direct' },
] as const satisfies readonly MessageQuoteSite[];

export type MessageQuoteAssertion = `message-quote.${MessageQuoteStageId}.${string}`;

export interface MessageQuoteStage {
  readonly id: MessageQuoteStageId;
  readonly source: string;
  readonly title: string;
  readonly sites: readonly MessageQuoteSite[];
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly MessageQuoteAssertion[];
}

function stage(
  id: MessageQuoteStageId,
  title: string,
  sites: readonly MessageQuoteSite[],
): MessageQuoteStage {
  const span = MESSAGE_QUOTE_SPANS.definitions[id];
  return {
    id,
    source: `${MESSAGE_QUOTE_SOURCE}:${span.from}-${span.to}`,
    title,
    sites,
    expectedAssertionRecords: sites.length,
    assertions: sites.map(
      ({ suffix }): MessageQuoteAssertion => `message-quote.${id}.${suffix}`,
    ),
  };
}

export const MESSAGE_QUOTE_STAGES: readonly MessageQuoteStage[] = [
  stage('quote-block',
    'pulls a message into the composer as a > block and sends it as a blockquote',
    quoteBlockSites),
  stage('quote-capability',
    'offers no Quote for a message with no text to bring', quoteCapabilitySites),
];

export const MESSAGE_QUOTE_STAGE_COUNTS = [12, 11] as const;
export const MESSAGE_QUOTE_DIRECT_COUNTS = [7, 6] as const;
export const MESSAGE_QUOTE_INHERITED_COUNTS = [5, 5] as const;
export const MESSAGE_QUOTE_ASSERTION_RECORDS = 23;
export const MESSAGE_QUOTE_DIRECT = 13;
export const MESSAGE_QUOTE_INHERITED = 10;
/** Room readiness, composer-send readiness, real-server echo and action-sheet readiness. */
export const MESSAGE_QUOTE_HELPER_COUNTS = {
  openRoom: 2,
  sendComposerDraft: 3,
  waitForSent: 2,
  openMessageActionSheet: 3,
} as const satisfies Readonly<Record<MessageQuoteHelper, number>>;

/** Direct sites order by line; a helper call runs before a later-line matcher. */
export function siteOrderKey(site: MessageQuoteSite): readonly [number, number] {
  return site.kind === 'direct' ? [site.line, 1] : [site.call, 0];
}

function after(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] !== right[0] ? left[0] > right[0] : left[1] > right[1];
}

function within(line: number, span: MessageQuoteSpan): boolean {
  return Number.isInteger(line) && line >= span.from && line <= span.to;
}

function validateContract(): void {
  assert.deepEqual(MESSAGE_QUOTE_STAGES.map(({ id }) => id),
    [...MESSAGE_QUOTE_STAGE_IDS], 'Message-quote stages keep source order');
  assert.deepEqual(MESSAGE_QUOTE_STAGES.map((entry) => entry.sites.length),
    [...MESSAGE_QUOTE_STAGE_COUNTS], 'Message-quote per-stage record counts');
  assert.deepEqual(
    MESSAGE_QUOTE_STAGES.map((entry) =>
      entry.sites.filter((site) => site.kind === 'direct').length),
    [...MESSAGE_QUOTE_DIRECT_COUNTS], 'Message-quote per-stage direct counts');
  assert.deepEqual(
    MESSAGE_QUOTE_STAGES.map((entry) =>
      entry.sites.filter((site) => site.kind === 'inherited').length),
    [...MESSAGE_QUOTE_INHERITED_COUNTS], 'Message-quote per-stage inherited counts');
  const sites = MESSAGE_QUOTE_STAGES.flatMap((entry) => entry.sites);
  const identities = MESSAGE_QUOTE_STAGES.flatMap((entry) => entry.assertions);
  assert.equal(sites.length, MESSAGE_QUOTE_ASSERTION_RECORDS,
    'Message-quote owns exactly 23 records');
  assert.equal(sites.filter((site) => site.kind === 'direct').length,
    MESSAGE_QUOTE_DIRECT, 'Message-quote owns exactly 13 direct sites');
  assert.equal(sites.filter((site) => site.kind === 'inherited').length,
    MESSAGE_QUOTE_INHERITED, 'Message-quote owns exactly 10 inherited sites');
  assert.equal(new Set(identities).size, MESSAGE_QUOTE_ASSERTION_RECORDS,
    'Message-quote identities are unique');
  for (const [helper, expected] of Object.entries(MESSAGE_QUOTE_HELPER_COUNTS)) {
    assert.equal(sites.filter((site) =>
      site.kind === 'inherited' && site.helper === helper).length, expected,
    `${helper} expands exactly ${expected} times`);
  }
  for (const entry of MESSAGE_QUOTE_STAGES) {
    const span = MESSAGE_QUOTE_SPANS.definitions[entry.id];
    const desktop: readonly MessageQuoteSpan[] = MESSAGE_QUOTE_SPANS.desktopBranches[entry.id];
    const outsideDesktop = (line: number): boolean =>
      desktop.every((branch) => !within(line, branch));
    assert.equal(entry.expectedAssertionRecords, entry.sites.length,
      `${entry.id} expected records equal its sites`);
    for (const identity of entry.assertions) {
      assert.match(identity, new RegExp(
        `^message-quote\\.${entry.id}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`),
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
        assert(outsideDesktop(site.line), `${site.line} is not a desktop-branch site`);
        assert(!(MESSAGE_QUOTE_EXCLUDED_DESKTOP_SITES as readonly number[]).includes(site.line),
          `${site.line} is not an excluded desktop site`);
        continue;
      }
      const lines: readonly number[] = MESSAGE_QUOTE_HELPERS[site.helper].expectLines;
      assert(lines.includes(site.line),
        `${entry.id}.${site.suffix} expands one of ${site.helper}'s expect lines`);
      assert(within(site.call, span),
        `${entry.id}.${site.suffix} call lies inside its definition`);
      assert(outsideDesktop(site.call), `${entry.id}.${site.suffix} call is not desktop-only`);
    }
  }
  assert(within(MESSAGE_QUOTE_HELPERS.openRoom.expectLines[0], MESSAGE_QUOTE_SPANS.openRoom),
    'The Room-readiness site lies inside the local openRoom helper');
}

validateContract();

function entryFor(stageId: MessageQuoteStageId): MessageQuoteStage {
  const entry = MESSAGE_QUOTE_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown message-quote stage ${stageId}`);
  return entry;
}

export function messageQuoteStage(stageId: MessageQuoteStageId): MessageQuoteStage {
  return entryFor(stageId);
}

export function messageQuoteAssertion(
  stageId: MessageQuoteStageId,
  suffix: string,
): MessageQuoteAssertion {
  const entry = entryFor(stageId);
  const identity: MessageQuoteAssertion = `message-quote.${stageId}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertMessageQuoteRecords(
  stageId: MessageQuoteStageId,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stageId).assertions,
    `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for parity identities. */
export function assertMessageQuoteReceiptName(name: string): void {
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `Receipt name ${name} is kebab-case`);
  assert(!name.startsWith('message-quote'), `Receipt ${name} is not a parity identity`);
}

// Predecessor fields: run suffixes (47, 122), Room names (50, 125), the two
// paragraphs (51–52), the inserted block (94), the answer (99), the control
// (126) and the image fixture (149–169).

export const MESSAGE_QUOTE_RUN_SUFFIX = {
  'quote-block': 'q',
  'quote-capability': 'qn',
} as const satisfies Readonly<Record<MessageQuoteStageId, string>>;

export const messageQuoteRoomName = {
  'quote-block': (run: string): string => `Quote ${run}`,
  'quote-capability': (run: string): string => `Quote none ${run}`,
} as const satisfies Readonly<Record<MessageQuoteStageId, (run: string) => string>>;

export const quoteFirst = (run: string): string => `alpha ${run}`;
export const quoteSecond = (run: string): string => `omega ${run}`;
export const quoteAnswer = (run: string): string => `my point ${run}`;
export const quoteControl = (run: string): string => `plain ${run}`;
/** Two paragraphs with a real blank line: two native Enter presses. */
export const quoteSourceBody = (run: string): string =>
  `${quoteFirst(run)}\n\n${quoteSecond(run)}`;
/** Line 94: every line marked, the blank line as a bare `>`, and a blank line to write on. */
export const quotedComposer = (run: string): string =>
  `> ${quoteFirst(run)}\n>\n> ${quoteSecond(run)}\n\n`;
/** The authoritative quote body: the inserted block, then the answer. */
export const quoteEventBody = (run: string): string =>
  `${quotedComposer(run)}${quoteAnswer(run)}`;

/** The predecessor's 1×1 PNG, uploaded as `image/png` under `shot.png`. */
export const QUOTE_IMAGE_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const QUOTE_IMAGE_FILENAME = 'shot.png';
export const QUOTE_IMAGE_BODY = 'shot.png';
export const QUOTE_IMAGE_MIME = 'image/png';
export const quoteImageTransaction = (run: string): string => `${run}img`;
export const quoteImagePng = (): Uint8Array =>
  Uint8Array.from(Buffer.from(QUOTE_IMAGE_PNG_BASE64, 'base64'));

export const HTML_FORMAT = 'org.matrix.custom.html';
/**
 * Typed before a paragraph that starts with a lowercase letter, then removed.
 * Android capitalises the first letter of a new paragraph; a digit is never
 * capitalised and Gboard leaves a digit-led lowercase word unchanged
 * (`1plain` stayed exact in the Markdown suite, `x` became `Explain`).
 */
export const PARAGRAPH_SENTINEL = '1';

/** One native step of the source draft and the exact composer value it leaves. */
export type QuoteDraftStep =
  | { readonly kind: 'fill'; readonly text: string; readonly value: string }
  | { readonly kind: 'enter'; readonly value: string }
  | { readonly kind: 'append'; readonly text: string; readonly value: string };

/** Lines 75–78: `fill(first)`, two Shift+Enter, `pressSequentially(second)`. */
export function quoteSourceSteps(run: string): readonly QuoteDraftStep[] {
  const first = quoteFirst(run);
  const second = quoteSecond(run);
  return [
    { kind: 'fill', text: first, value: first },
    { kind: 'enter', value: `${first}\n` },
    { kind: 'enter', value: `${first}\n\n` },
    { kind: 'append', text: second, value: `${first}\n\n${second}` },
  ];
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

function nullableNumberField(value: Record<string, unknown>, name: string): number | null {
  const candidate = value[name];
  assert(candidate === null || (typeof candidate === 'number' && Number.isFinite(candidate)),
    `${name} is a finite number or null`);
  return candidate;
}

function booleanField(value: Record<string, unknown>, name: string): boolean {
  const candidate = value[name];
  assert(typeof candidate === 'boolean', `${name} is a boolean`);
  return candidate;
}

function nullableBooleanField(value: Record<string, unknown>, name: string): boolean | null {
  const candidate = value[name];
  assert(candidate === null || typeof candidate === 'boolean', `${name} is a boolean or null`);
  return candidate;
}

function countField(value: Record<string, unknown>, name: string): number {
  const candidate = value[name];
  assert(typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0,
    `${name} is a nonnegative integer`);
  return candidate;
}

function stringArrayField(value: Record<string, unknown>, name: string): readonly string[] {
  const candidate = value[name];
  assert(Array.isArray(candidate) &&
    candidate.every((item: unknown) => typeof item === 'string'),
  `${name} is a string array`);
  return candidate as string[];
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

// Composer.

/** Read-only composer and Send-button state. */
export interface ComposerObservation {
  readonly count: number;
  readonly visible: boolean;
  readonly focused: boolean;
  readonly value: string | null;
  readonly placeholder: string | null;
  readonly selectionStart: number | null;
  readonly selectionEnd: number | null;
  readonly sendCount: number;
  readonly sendDisabled: boolean | null;
  readonly href: string;
}

export function parseComposer(value: unknown): ComposerObservation {
  const composer = object(value, 'Composer observation');
  return {
    count: countField(composer, 'count'),
    visible: booleanField(composer, 'visible'),
    focused: booleanField(composer, 'focused'),
    value: nullableStringField(composer, 'value'),
    placeholder: nullableStringField(composer, 'placeholder'),
    selectionStart: nullableNumberField(composer, 'selectionStart'),
    selectionEnd: nullableNumberField(composer, 'selectionEnd'),
    sendCount: countField(composer, 'sendCount'),
    sendDisabled: nullableBooleanField(composer, 'sendDisabled'),
    href: stringField(composer, 'href'),
  };
}

export interface RoomIdentity {
  readonly name: string;
  readonly roomId: string;
  readonly userId: string;
}

/** Helper line 34: the composer of the exact Room is visible after native open. */
export function assertRoomReady(composer: ComposerObservation, room: RoomIdentity): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert(composer.visible, 'The composer is visible');
  assert.equal(composer.placeholder, `Message #${room.name}`,
    'The composer names the exact Room');
  assertRoomRoute(composer.href, room.roomId, room.userId);
}

/** The composer holds exactly `expected`, focused, with a collapsed caret at `caret`. */
export function assertComposerCaret(
  composer: ComposerObservation,
  expected: string,
  caret: number,
): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert(composer.focused, 'The composer keeps native focus');
  assert.equal(composer.value, expected, 'The composer holds the exact native text');
  assert(!expected.includes('\r'), 'Line breaks are bare newlines');
  assert.equal(composer.selectionStart, caret, 'The caret is at the expected offset');
  assert.equal(composer.selectionEnd, caret, 'The caret selection is collapsed');
}

/** The composer holds exactly `expected`, entered natively, caret at its end. */
export function assertNativeComposerValue(
  composer: ComposerObservation,
  expected: string,
): void {
  assertComposerCaret(composer, expected, expected.length);
}

/**
 * Helper line 53: with the keyboard dismissed the composer's Send button is
 * enabled for the exact draft. Dismissing the keyboard may release caret focus.
 */
export function assertSendEnabled(composer: ComposerObservation, draft: string): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert.equal(composer.value, draft, 'The composer still holds the exact draft');
  assert.equal(composer.sendCount, 1, 'Exactly one Send button');
  assert.equal(composer.sendDisabled, false, 'The Send button is enabled');
}

/** The Send tap cleared the composer: the draft left through the product send path. */
export function assertDraftSent(composer: ComposerObservation): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert.equal(composer.value, '', 'The composer is empty after the native send');
}

/** Line 94: exactly the inserted block, marked blank line included, caret at its end. */
export function assertComposerQuote(composer: ComposerObservation, run: string): void {
  const expected = quotedComposer(run);
  assertNativeComposerValue(composer, expected);
  assert.equal(composer.value?.split('\n').filter((line) => line === '>').length, 1,
    'The paragraph break is marked with exactly one bare >');
  assert(composer.value?.endsWith('\n\n'), 'A blank line follows the block for the answer');
}

// Timeline rendering.

export interface BlockquoteObservation {
  readonly text: string;
  readonly visible: boolean;
}

export interface MessageTextObservation {
  readonly html: boolean;
  readonly text: string;
  readonly visible: boolean;
  readonly blockquotes: readonly BlockquoteObservation[];
}

export interface MessageRowObservation {
  readonly id: string;
  readonly event: boolean;
  readonly visible: boolean;
  readonly text: string;
  /** `.msg__media` attachments, and the rendered `.media` kinds inside them. */
  readonly media: number;
  readonly mediaKinds: readonly string[];
  readonly blockquotes: number;
  readonly texts: readonly MessageTextObservation[];
}

export interface TimelineObservation {
  readonly rows: readonly MessageRowObservation[];
}

function parseBlockquote(value: unknown, name: string): BlockquoteObservation {
  const quote = object(value, name);
  return { text: stringField(quote, 'text'), visible: booleanField(quote, 'visible') };
}

function parseMessageText(value: unknown, name: string): MessageTextObservation {
  const text = object(value, name);
  return {
    html: booleanField(text, 'html'),
    text: stringField(text, 'text'),
    visible: booleanField(text, 'visible'),
    blockquotes: arrayField(text, 'blockquotes').map((quote, index) =>
      parseBlockquote(quote, `${name} blockquote ${index}`)),
  };
}

/** Reject incomplete CDP values before any source-mapped assertion is recorded. */
export function parseTimeline(value: unknown): TimelineObservation {
  const timeline = object(value, 'Timeline observation');
  return {
    rows: arrayField(timeline, 'rows').map((raw, index): MessageRowObservation => {
      const row = object(raw, `Timeline row ${index}`);
      return {
        id: stringField(row, 'id'),
        event: booleanField(row, 'event'),
        visible: booleanField(row, 'visible'),
        text: stringField(row, 'text'),
        media: countField(row, 'media'),
        mediaKinds: stringArrayField(row, 'mediaKinds'),
        blockquotes: countField(row, 'blockquotes'),
        texts: arrayField(row, 'texts').map((text, textIndex) =>
          parseMessageText(text, `Timeline row ${index} text ${textIndex}`)),
      };
    }),
  };
}

function messageRows(timeline: TimelineObservation): readonly MessageRowObservation[] {
  return timeline.rows.filter((row) => !row.event);
}

/** Lines 82, 104, 181: exactly one visible message row carries `needle`. */
export function assertRowVisible(
  timeline: TimelineObservation,
  needle: string,
): MessageRowObservation {
  const rows = messageRows(timeline).filter((row) => row.text.includes(needle));
  assert.equal(rows.length, 1, `Exactly one Room row carries ${JSON.stringify(needle)}`);
  assert(rows[0]!.visible, 'The row is visible');
  return rows[0]!;
}

/** Helper line 178: the one row carrying `needle` is the reconciled server event. */
export function assertServerEcho(
  timeline: TimelineObservation,
  needle: string,
): MessageRowObservation {
  const row = assertRowVisible(timeline, needle);
  assert(row.id.startsWith('$'), 'The row carries the homeserver event id');
  return row;
}

/** The one row carrying `needle` is the proved event, by read-only id comparison. */
export function assertSameRow(
  timeline: TimelineObservation,
  needle: string,
  eventId: string,
): MessageRowObservation {
  const row = assertServerEcho(timeline, needle);
  assert.equal(row.id, eventId, 'The row is the proved server event');
  return row;
}

/** Line 104: the answer renders in exactly one row, the reconciled quote event. */
export function assertAnswerVisible(
  timeline: TimelineObservation,
  answer: string,
  quoteId: string,
): MessageRowObservation {
  return assertSameRow(timeline, answer, quoteId);
}

/** Line 110: the row renders exactly one real, visible blockquote in its HTML text. */
export function assertOneBlockquote(row: MessageRowObservation): BlockquoteObservation {
  assert.equal(row.blockquotes, 1, 'The quote row renders exactly one blockquote');
  const quotes = row.texts.flatMap((text) => text.blockquotes);
  assert.equal(quotes.length, 1, 'The blockquote sits in the rendered message text');
  assert(row.texts.some((text) => text.html && text.blockquotes.length === 1),
    'The blockquote is rendered Markdown, not quote-looking text');
  assert(quotes[0]!.visible, 'The blockquote is visible');
  return quotes[0]!;
}

/** Line 111. */
export function assertQuotesFirst(quote: BlockquoteObservation, run: string): void {
  assert(quote.text.includes(quoteFirst(run)), 'The blockquote contains the first paragraph');
}

/** Line 112: the second paragraph did not escape the quote at the blank line. */
export function assertQuotesSecond(quote: BlockquoteObservation, run: string): void {
  assert(quote.text.includes(quoteSecond(run)), 'The blockquote contains the second paragraph');
}

/** Line 114: the answer sits outside the quote, in the same rendered message. */
export function assertAnswerOutside(
  row: MessageRowObservation,
  quote: BlockquoteObservation,
  run: string,
): void {
  const answer = quoteAnswer(run);
  assert(!quote.text.includes(answer), 'The blockquote excludes the answer');
  assert(row.texts.some((text) => text.html && text.text.includes(answer)),
    'The answer is rendered in the quote message outside the blockquote');
}

/**
 * Line 200: exactly one row carries the fixture's filename, as the predecessor
 * finds it (`hasText: 'shot.png'`), and it is the proved `m.image` event with
 * one media attachment and no message text to quote. The fixture carries no
 * `info.mimetype`, so the renderer shows it as a named download tile.
 */
export function assertImageRow(
  timeline: TimelineObservation,
  imageId: string,
): MessageRowObservation {
  const row = assertRowVisible(timeline, QUOTE_IMAGE_FILENAME);
  assert.equal(row.id, imageId, 'The filename row is the image fixture event');
  assert.equal(row.media, 1, 'The image row renders exactly one media attachment');
  assert.equal(row.mediaKinds.length, 1, 'The attachment renders one media element');
  assert.equal(row.texts.length, 0, 'The image row renders no message text');
  assert.equal(messageRows(timeline).filter((candidate) => candidate.media > 0).length, 1,
    'Exactly one media row renders');
  return row;
}

// The Android message-action sheet.

export interface SheetControlObservation {
  readonly count: number;
  readonly visible: boolean;
}

export interface SheetObservation {
  readonly dialogs: number;
  readonly dialogVisible: boolean;
  readonly quote: SheetControlObservation;
  readonly copy: SheetControlObservation;
  readonly forward: SheetControlObservation;
  readonly cancel: SheetControlObservation;
}

function parseControl(value: unknown, name: string): SheetControlObservation {
  const control = object(value, name);
  return { count: countField(control, 'count'), visible: booleanField(control, 'visible') };
}

export function parseSheet(value: unknown): SheetObservation {
  const sheet = object(value, 'Sheet observation');
  return {
    dialogs: countField(sheet, 'dialogs'),
    dialogVisible: booleanField(sheet, 'dialogVisible'),
    quote: parseControl(sheet['quote'], 'Quote control'),
    copy: parseControl(sheet['copy'], 'Copy control'),
    forward: parseControl(sheet['forward'], 'Forward control'),
    cancel: parseControl(sheet['cancel'], 'Cancel control'),
  };
}

/** Helper line 220, exactly as the message-forward suite proves its native sheet. */
export function assertNativeSheetReady(sheet: SheetObservation): void {
  assert.equal(sheet.dialogs, 1, 'Exactly one Android message-action sheet');
  assert(sheet.dialogVisible, 'Android action sheet is visible');
  assert.equal(sheet.forward.count, 1, 'Exactly one Forward action');
  assert(sheet.forward.visible, 'Forward action is visible');
}

/** Line 185: the text message's sheet offers exactly one visible Quote. */
export function assertQuoteVisible(sheet: SheetObservation): void {
  assertNativeSheetReady(sheet);
  assert.equal(sheet.quote.count, 1, 'Exactly one Quote action');
  assert(sheet.quote.visible, 'The Quote action is visible');
}

/** Line 187: the native Cancel closed the sheet. */
export function assertSheetClosed(sheet: SheetObservation): void {
  assert.equal(sheet.dialogs, 0, 'No message-action sheet remains');
  assert.equal(sheet.quote.count + sheet.copy.count + sheet.cancel.count, 0,
    'No sheet control remains');
}

/** Line 204: the image sheet's positive per-message control. */
export function assertCopyVisible(sheet: SheetObservation): void {
  assertNativeSheetReady(sheet);
  assert.equal(sheet.copy.count, 1, 'Exactly one Copy action');
  assert(sheet.copy.visible, 'The Copy action is visible');
}

/** Line 205: the same open sheet, with Copy, has no Quote for the image. */
export function assertNoQuote(sheet: SheetObservation): void {
  assertCopyVisible(sheet);
  assert.equal(sheet.quote.count, 0, 'The image sheet offers no Quote');
}

// Authoritative server events.

type MatrixEvent = Readonly<Record<string, unknown>>;

/** Every `m.room.message` in one `/messages?dir=b&limit=50` page, oldest first. */
export function authoritativeRoomMessages(response: unknown): readonly MatrixEvent[] {
  const page = object(response, 'Room messages page');
  return arrayField(page, 'chunk')
    .map((event, index) => object(event, `Room messages event ${index}`))
    .filter((event) => event['type'] === 'm.room.message')
    .reverse();
}

export interface SentEventExpectation {
  readonly eventId: string;
  readonly roomId: string;
  readonly sender: string;
}

function content(event: MatrixEvent): Record<string, unknown> {
  return object(event['content'], 'Event content');
}

/** A real, original Room message: its id, Room, sender and type. */
function assertOriginal(event: MatrixEvent, expected: SentEventExpectation): Record<string, unknown> {
  const eventId = event['event_id'];
  assert(typeof eventId === 'string' && eventId.startsWith('$'),
    'Sent event has a real Matrix event id');
  assert.equal(eventId, expected.eventId, 'Server event matches the proved Room row');
  assert.equal(event['room_id'], expected.roomId, 'Event belongs to the exact Room');
  assert.equal(event['sender'], expected.sender, 'Event has the active sender');
  assert.equal(event['type'], 'm.room.message', 'Event is a Room message');
  const body = content(event);
  assert(!('m.relates_to' in body) && !('m.new_content' in body),
    'Event is an original message with no relation');
  return body;
}

/** A native text send with exactly `text` as its body. */
export function assertTextEvent(
  event: MatrixEvent,
  expected: SentEventExpectation & { readonly body: string },
): void {
  const body = assertOriginal(event, expected);
  assert.equal(body['msgtype'], 'm.text', 'Event is a text message');
  assert.equal(body['body'], expected.body, 'Event body is the exact native text');
}

/** The source: two paragraphs with a real blank line. */
export function assertSourceEvent(
  event: MatrixEvent,
  expected: SentEventExpectation & { readonly run: string },
): void {
  assertTextEvent(event, { ...expected, body: quoteSourceBody(expected.run) });
}

const BLOCKQUOTE = /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/giu;

/**
 * The quote: the exact Markdown body, one HTML blockquote holding both
 * paragraphs and not the answer, the answer after it, and no relation of any
 * kind, so in particular no `m.in_reply_to`: a quote is not a reply.
 */
export function assertQuoteEvent(
  event: MatrixEvent,
  expected: SentEventExpectation & { readonly run: string },
): void {
  const body = assertOriginal(event, expected);
  const { run } = expected;
  assert.equal(body['msgtype'], 'm.text', 'The quote is a text message');
  assert.equal(body['body'], quoteEventBody(run), 'The quote body is the exact Markdown');
  assert.equal(body['format'], HTML_FORMAT, 'The quote declares Matrix HTML');
  const html = body['formatted_body'];
  assert(typeof html === 'string', 'The quote carries an HTML body');
  assert(!/in_reply_to|mx-reply/iu.test(JSON.stringify(body)),
    'The quote carries no reply relation or reply fallback');
  const quotes = [...html.matchAll(BLOCKQUOTE)];
  assert.equal(quotes.length, 1, 'The HTML body holds exactly one blockquote');
  const [whole, inner] = quotes[0]!;
  assert(inner!.includes(quoteFirst(run)), 'The HTML blockquote holds the first paragraph');
  assert(inner!.includes(quoteSecond(run)), 'The HTML blockquote holds the second paragraph');
  assert(!inner!.includes(quoteAnswer(run)), 'The HTML blockquote excludes the answer');
  const rest = html.slice(quotes[0]!.index! + whole.length);
  assert(rest.includes(quoteAnswer(run)), 'The answer follows the blockquote');
  assert(!html.slice(0, quotes[0]!.index!).includes(quoteAnswer(run)),
    'Nothing of the answer precedes the blockquote');
}

/** The REST-arranged image fixture: the exact upload, filename body and sender. */
export function assertImageEvent(
  event: MatrixEvent,
  expected: SentEventExpectation & { readonly contentUri: string },
): void {
  const body = assertOriginal(event, expected);
  assert.equal(body['msgtype'], 'm.image', 'The fixture is an image message');
  assert.equal(body['body'], QUOTE_IMAGE_BODY, 'The image body is its filename');
  assert.equal(body['url'], expected.contentUri, 'The image references the exact upload');
}

export interface QuoteBlockEvents {
  readonly sourceId: string;
  readonly quoteId?: string;
}

/** The quote Room holds exactly the native source, then (once sent) the quote. */
export function assertQuoteBlockRoom(
  events: readonly MatrixEvent[],
  expected: { readonly roomId: string; readonly sender: string; readonly run: string } &
    QuoteBlockEvents,
): void {
  const length = expected.quoteId === undefined ? 1 : 2;
  assert.equal(events.length, length, 'The Room holds exactly the native messages so far');
  assertSourceEvent(events[0]!, { ...expected, eventId: expected.sourceId });
  if (expected.quoteId !== undefined)
    assertQuoteEvent(events[1]!, { ...expected, eventId: expected.quoteId });
}

/** The capability Room holds exactly the image fixture, then (once sent) the text control. */
export function assertCapabilityRoom(
  events: readonly MatrixEvent[],
  expected: {
    readonly roomId: string;
    readonly sender: string;
    readonly run: string;
    readonly imageId: string;
    readonly contentUri: string;
    readonly controlId?: string;
  },
): void {
  const length = expected.controlId === undefined ? 1 : 2;
  assert.equal(events.length, length, 'The Room holds exactly the fixture and native control');
  assertImageEvent(events[0]!, { ...expected, eventId: expected.imageId });
  if (expected.controlId !== undefined)
    assertTextEvent(events[1]!, {
      ...expected,
      eventId: expected.controlId,
      body: quoteControl(expected.run),
    });
}
