import assert from 'node:assert/strict';

export const MESSAGE_MARKDOWN_SOURCE =
  'e2e/browser/journeys/conversations/message-markdown.spec.mts';
export const MESSAGE_MARKDOWN_SOURCE_SHA256 =
  '128f6ae2660c02a9f6e0d64726999ead4960454b66cb369306f9f27b3bb0baa8';
export const MESSAGE_MARKDOWN_SOURCE_LINES = 279;

export const MESSAGE_MARKDOWN_SHARED_SOURCE_SHA256 = {
  'e2e/support/message-composer.mts':
    '4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d',
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
} as const;

export const MESSAGE_MARKDOWN_STAGE_IDS = [
  'formatting',
  'task-list',
  'code-caption',
] as const;

export type MessageMarkdownStageId = (typeof MESSAGE_MARKDOWN_STAGE_IDS)[number];

export interface MessageMarkdownSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * Owned predecessor spans. The code-caption definition ends at the Android
 * `return;` on line 224; its desktop hover-toolbar tail (225–278) is excluded.
 */
export const MESSAGE_MARKDOWN_SPANS = {
  reader: { from: 29, to: 47 },
  definitions: {
    formatting: { from: 52, to: 125 },
    'task-list': { from: 127, to: 168 },
    'code-caption': { from: 170, to: 224 },
  },
  androidBranchLine: 214,
  androidReturnLine: 224,
  excludedTail: { from: 225, to: 278 },
} as const satisfies {
  readonly reader: MessageMarkdownSpan;
  readonly definitions: Readonly<Record<MessageMarkdownStageId, MessageMarkdownSpan>>;
  readonly androidBranchLine: number;
  readonly androidReturnLine: number;
  readonly excludedTail: MessageMarkdownSpan;
};

/** Desktop-only `expect` sites after the Android `return;`; never parity records. */
export const MESSAGE_MARKDOWN_EXCLUDED_TAIL_SITES = [276, 277] as const;

/**
 * Shared helpers whose own `expect` lines, in execution order, an inherited site
 * expands. `sendComposerLines` waits for the composer-send control (75), then
 * `sendComposerDraft` waits for that composer's Send button before its mobile tap (53).
 */
export const MESSAGE_MARKDOWN_HELPERS = {
  openNamedRoom: {
    module: 'e2e/support/message-composer.mts',
    expectLines: [13],
    role: 'room-readiness',
  },
  sendComposerLines: {
    module: 'e2e/support/message-composer.mts',
    expectLines: [75, 53],
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

export type MessageMarkdownHelper = keyof typeof MESSAGE_MARKDOWN_HELPERS;

/**
 * One source-mapped parity site. `line` is the `expect` line. An inherited
 * site's `helper` owns that line (one of its `expectLines`) and `call` is the definition-body call line;
 * `iteration` numbers the runs of a call inside a literal `for…of` loop.
 */
export type MessageMarkdownSite =
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'direct';
    }
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'inherited';
      readonly helper: MessageMarkdownHelper;
      readonly call: number;
      readonly iteration?: number;
    };

const formattingSites = [
  { line: 13, suffix: 'room-ready', kind: 'inherited', helper: 'openNamedRoom', call: 82 },
  { line: 75, suffix: 'plain-send-ready', kind: 'inherited', helper: 'sendComposerLines', call: 85 },
  { line: 53, suffix: 'plain-send-enabled', kind: 'inherited', helper: 'sendComposerLines', call: 85 },
  { line: 86, suffix: 'plain-visible', kind: 'direct' },
  { line: 75, suffix: 'rich-send-ready', kind: 'inherited', helper: 'sendComposerLines', call: 92 },
  { line: 53, suffix: 'rich-send-enabled', kind: 'inherited', helper: 'sendComposerLines', call: 92 },
  { line: 94, suffix: 'rich-visible', kind: 'direct' },
  { line: 95, suffix: 'bold-run', kind: 'direct' },
  { line: 96, suffix: 'one-break', kind: 'direct' },
  { line: 178, suffix: 'plain-server-echo', kind: 'inherited', helper: 'waitForSent', call: 102, iteration: 1 },
  { line: 178, suffix: 'rich-server-echo', kind: 'inherited', helper: 'waitForSent', call: 102, iteration: 2 },
  { line: 114, suffix: 'plain-body', kind: 'direct' },
  { line: 115, suffix: 'plain-no-format', kind: 'direct' },
  { line: 116, suffix: 'plain-no-formatted-body', kind: 'direct' },
  { line: 118, suffix: 'formatted-format', kind: 'direct' },
  { line: 119, suffix: 'formatted-break', kind: 'direct' },
  { line: 120, suffix: 'formatted-bold', kind: 'direct' },
  { line: 124, suffix: 'formatted-source', kind: 'direct' },
] as const satisfies readonly MessageMarkdownSite[];

const taskListSites = [
  { line: 13, suffix: 'room-ready', kind: 'inherited', helper: 'openNamedRoom', call: 154 },
  { line: 75, suffix: 'send-ready', kind: 'inherited', helper: 'sendComposerLines', call: 160 },
  { line: 53, suffix: 'send-enabled', kind: 'inherited', helper: 'sendComposerLines', call: 160 },
  { line: 163, suffix: 'list-visible', kind: 'direct' },
  { line: 164, suffix: 'checked-glyph', kind: 'direct' },
  { line: 165, suffix: 'unchecked-glyph', kind: 'direct' },
  { line: 167, suffix: 'no-checkbox-input', kind: 'direct' },
] as const satisfies readonly MessageMarkdownSite[];

const codeCaptionSites = [
  { line: 13, suffix: 'room-ready', kind: 'inherited', helper: 'openNamedRoom', call: 197 },
  { line: 75, suffix: 'lead-send-ready', kind: 'inherited', helper: 'sendComposerLines', call: 202 },
  { line: 53, suffix: 'lead-send-enabled', kind: 'inherited', helper: 'sendComposerLines', call: 202 },
  { line: 75, suffix: 'code-send-ready', kind: 'inherited', helper: 'sendComposerLines', call: 204 },
  { line: 53, suffix: 'code-send-enabled', kind: 'inherited', helper: 'sendComposerLines', call: 204 },
  { line: 207, suffix: 'code-visible', kind: 'direct' },
  { line: 178, suffix: 'server-echo', kind: 'inherited', helper: 'waitForSent', call: 208 },
  { line: 212, suffix: 'continuation-row', kind: 'direct' },
  { line: 217, suffix: 'no-hover-toolbar', kind: 'direct' },
  { line: 218, suffix: 'language-caption', kind: 'direct' },
  { line: 220, suffix: 'sheet-ready', kind: 'inherited', helper: 'openMessageActionSheet', call: 223 },
  { line: 223, suffix: 'sheet-visible', kind: 'direct' },
] as const satisfies readonly MessageMarkdownSite[];

export type MessageMarkdownAssertion =
  `message-markdown.${MessageMarkdownStageId}.${string}`;

export interface MessageMarkdownStage {
  readonly id: MessageMarkdownStageId;
  readonly source: string;
  readonly title: string;
  readonly sites: readonly MessageMarkdownSite[];
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly MessageMarkdownAssertion[];
}

function stage(
  id: MessageMarkdownStageId,
  title: string,
  sites: readonly MessageMarkdownSite[],
): MessageMarkdownStage {
  const span = MESSAGE_MARKDOWN_SPANS.definitions[id];
  return {
    id,
    source: `${MESSAGE_MARKDOWN_SOURCE}:${span.from}-${span.to}`,
    title,
    sites,
    expectedAssertionRecords: sites.length,
    assertions: sites.map(
      ({ suffix }): MessageMarkdownAssertion => `message-markdown.${id}.${suffix}`,
    ),
  };
}

export const MESSAGE_MARKDOWN_STAGES: readonly MessageMarkdownStage[] = [
  stage('formatting',
    'renders formatting, keeps line breaks, and only sends HTML when it means something',
    formattingSites),
  stage('task-list',
    'renders a task list as glyphs rather than dropping it', taskListSites),
  stage('code-caption',
    'keeps the language caption clear of the hover toolbar', codeCaptionSites),
];

export const MESSAGE_MARKDOWN_STAGE_COUNTS = [18, 7, 12] as const;
export const MESSAGE_MARKDOWN_DIRECT_COUNTS = [11, 4, 5] as const;
export const MESSAGE_MARKDOWN_INHERITED_COUNTS = [7, 3, 7] as const;
export const MESSAGE_MARKDOWN_ASSERTION_RECORDS = 37;
export const MESSAGE_MARKDOWN_DIRECT = 20;
export const MESSAGE_MARKDOWN_INHERITED = 17;
/** Room readiness, composer-send readiness, real-server echo and action-sheet readiness. */
export const MESSAGE_MARKDOWN_HELPER_COUNTS = {
  openNamedRoom: 3,
  sendComposerLines: 10,
  waitForSent: 3,
  openMessageActionSheet: 1,
} as const satisfies Readonly<Record<MessageMarkdownHelper, number>>;

/**
 * Direct sites order by line; a helper call runs before a same-line matcher, and
 * one call's helper lines run in their `expectLines` order.
 */
export function siteOrderKey(
  site: MessageMarkdownSite,
): readonly [number, number, number, number] {
  if (site.kind === 'direct') return [site.line, 1, 0, 0];
  const lines: readonly number[] = MESSAGE_MARKDOWN_HELPERS[site.helper].expectLines;
  return [site.call, 0, site.iteration ?? 0, lines.indexOf(site.line)];
}

function after(
  left: readonly [number, number, number, number],
  right: readonly [number, number, number, number],
): boolean {
  for (let index = 0; index < 4; index++) {
    if (left[index]! !== right[index]!) return left[index]! > right[index]!;
  }
  return false;
}

function within(line: number, span: MessageMarkdownSpan): boolean {
  return Number.isInteger(line) && line >= span.from && line <= span.to;
}

function validateContract(): void {
  assert.deepEqual(MESSAGE_MARKDOWN_STAGES.map(({ id }) => id),
    [...MESSAGE_MARKDOWN_STAGE_IDS], 'Message-markdown stages keep source order');
  assert.deepEqual(MESSAGE_MARKDOWN_STAGES.map((entry) => entry.sites.length),
    [...MESSAGE_MARKDOWN_STAGE_COUNTS], 'Message-markdown per-stage record counts');
  assert.deepEqual(
    MESSAGE_MARKDOWN_STAGES.map((entry) =>
      entry.sites.filter((site) => site.kind === 'direct').length),
    [...MESSAGE_MARKDOWN_DIRECT_COUNTS], 'Message-markdown per-stage direct counts');
  assert.deepEqual(
    MESSAGE_MARKDOWN_STAGES.map((entry) =>
      entry.sites.filter((site) => site.kind === 'inherited').length),
    [...MESSAGE_MARKDOWN_INHERITED_COUNTS],
    'Message-markdown per-stage inherited counts');
  const sites = MESSAGE_MARKDOWN_STAGES.flatMap((entry) => entry.sites);
  const identities = MESSAGE_MARKDOWN_STAGES.flatMap((entry) => entry.assertions);
  assert.equal(sites.length, MESSAGE_MARKDOWN_ASSERTION_RECORDS,
    'Message-markdown owns exactly 37 records');
  assert.equal(sites.filter((site) => site.kind === 'direct').length,
    MESSAGE_MARKDOWN_DIRECT, 'Message-markdown owns exactly 20 direct sites');
  assert.equal(sites.filter((site) => site.kind === 'inherited').length,
    MESSAGE_MARKDOWN_INHERITED, 'Message-markdown owns exactly 17 inherited sites');
  assert.equal(new Set(identities).size, MESSAGE_MARKDOWN_ASSERTION_RECORDS,
    'Message-markdown identities are unique');
  for (const [helper, expected] of Object.entries(MESSAGE_MARKDOWN_HELPER_COUNTS)) {
    assert.equal(sites.filter((site) =>
      site.kind === 'inherited' && site.helper === helper).length, expected,
    `${helper} expands exactly ${expected} times`);
  }
  for (const entry of MESSAGE_MARKDOWN_STAGES) {
    const span = MESSAGE_MARKDOWN_SPANS.definitions[entry.id];
    assert.equal(entry.expectedAssertionRecords, entry.sites.length,
      `${entry.id} expected records equal its sites`);
    for (const identity of entry.assertions) {
      assert.match(identity, new RegExp(
        `^message-markdown\\.${entry.id}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`),
      `${identity} is a stage-local identity`);
    }
    let previous: readonly [number, number, number, number] = [0, 0, 0, 0];
    for (const site of entry.sites) {
      const key = siteOrderKey(site);
      assert(after(key, previous), `${entry.id}.${site.suffix} keeps source order`);
      previous = key;
      if (site.kind === 'direct') {
        assert(within(site.line, span),
          `${entry.id}.${site.suffix} lies inside its definition`);
        assert(!(MESSAGE_MARKDOWN_EXCLUDED_TAIL_SITES as readonly number[])
          .includes(site.line), `${site.line} is not a desktop-tail site`);
        continue;
      }
      const lines: readonly number[] = MESSAGE_MARKDOWN_HELPERS[site.helper].expectLines;
      assert(lines.includes(site.line),
        `${entry.id}.${site.suffix} expands one of ${site.helper}'s expect lines`);
      assert(within(site.call, span),
        `${entry.id}.${site.suffix} call lies inside its definition`);
      assert(site.call <= MESSAGE_MARKDOWN_SPANS.androidReturnLine,
        `${entry.id}.${site.suffix} call precedes the Android return`);
    }
  }
}

validateContract();

function entryFor(stageId: MessageMarkdownStageId): MessageMarkdownStage {
  const entry = MESSAGE_MARKDOWN_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown message-markdown stage ${stageId}`);
  return entry;
}

export function messageMarkdownStage(stageId: MessageMarkdownStageId): MessageMarkdownStage {
  return entryFor(stageId);
}

export function messageMarkdownAssertion(
  stageId: MessageMarkdownStageId,
  suffix: string,
): MessageMarkdownAssertion {
  const entry = entryFor(stageId);
  const identity: MessageMarkdownAssertion = `message-markdown.${stageId}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertMessageMarkdownRecords(
  stageId: MessageMarkdownStageId,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stageId).assertions,
    `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for parity identities. */
export function assertMessageMarkdownReceiptName(name: string): void {
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `Receipt name ${name} is kebab-case`);
  assert(!name.startsWith('message-markdown'),
    `Receipt ${name} is not a parity identity`);
}

// Predecessor room names (60, 135, 178) and run-token suffixes (57, 132, 175).

export const MESSAGE_MARKDOWN_RUN_SUFFIX = {
  formatting: 'md',
  'task-list': 'tl',
  'code-caption': 'ov',
} as const satisfies Readonly<Record<MessageMarkdownStageId, string>>;

export const messageMarkdownRoomName = {
  formatting: (run: string): string => `Markdown ${run}`,
  'task-list': (run: string): string => `Tasks ${run}`,
  'code-caption': (run: string): string => `Overlap ${run}`,
} as const satisfies Readonly<Record<MessageMarkdownStageId, (run: string) => string>>;

// Native drafts: every line reaches the composer through Android key input.

/**
 * One line break typed with the native Enter (a line break on a mobile device), and the exact
 * composer value it must leave before the next line is typed. The task-list
 * break is the composer's own continuation: it carries `- [ ] ` onto the line.
 */
export interface NativeDraftBreak {
  readonly afterBreak: string;
  readonly typed: string;
}

export interface NativeDraft {
  readonly name: string;
  /** The predecessor's `sendComposerLines` array, verbatim. */
  readonly lines: readonly string[];
  /** Typed through the anti-capitalisation focused fill. */
  readonly first: string;
  readonly breaks: readonly NativeDraftBreak[];
  /** The exact composer value, and therefore the exact `body`, before Enter. */
  readonly value: string;
}

function draft(
  name: string,
  lines: readonly string[],
  afterBreaks: readonly string[],
): NativeDraft {
  assert(lines.length >= 1 && afterBreaks.length === lines.length - 1,
    'A native draft has one expected value per line break');
  const breaks = lines.slice(1).map((typed, index) => ({
    afterBreak: afterBreaks[index]!,
    typed,
  }));
  return {
    name,
    lines,
    first: lines[0]!,
    breaks,
    value: breaks.length ? `${breaks.at(-1)!.afterBreak}${breaks.at(-1)!.typed}` : lines[0]!,
  };
}

export const MESSAGE_MARKDOWN_DRAFTS = {
  plain: draft('plain', ['plain one', 'plain two'], ['plain one\n']),
  rich: draft('rich', ['**bold one**', 'rich two'], ['**bold one**\n']),
  task: draft('task', ['- [x] shipped', 'pending'], ['- [x] shipped\n- [ ] ']),
  lead: draft('lead', ['setting up'], []),
  code: draft('code', ['```python', 'x = 1', '```'],
    ['```python\n', '```python\nx = 1\n']),
} as const;

export type MessageMarkdownDraftName = keyof typeof MESSAGE_MARKDOWN_DRAFTS;

export const PLAIN_BODY = 'plain one\nplain two';
export const FORMATTED_BODY = '**bold one**\nrich two';
export const TASK_BODY = '- [x] shipped\n- [ ] pending';
export const LEAD_BODY = 'setting up';
export const CODE_BODY = '```python\nx = 1\n```';
export const HTML_FORMAT = 'org.matrix.custom.html';
export const CAPTION_LANGUAGE = 'python';
/** Chromium resolves `content: attr(language)` to the quoted string. */
export const CAPTION_CONTENT = '"python"';
/**
 * Typed before a continuation line that starts with a letter, then removed. A
 * digit is never capitalized and keeps Gboard from autocorrecting the joined
 * word: on the emulator `x` + `plain` became `Explain`, while `1plain` stays exact.
 */
export const ANTI_CAPITALIZATION_SENTINEL = '1';

/** A continuation line that starts with a letter gets the sentinel; others type verbatim. */
export function needsSentinel(line: string): boolean {
  return /^[a-z]/u.test(line);
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

// Applied profile, route and composer.

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

/** Read-only composer and send-control state. */
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

/** Helper line 13: the composer of the exact Room is visible after native open. */
export function assertRoomReady(
  composer: ComposerObservation,
  room: { readonly name: string; readonly roomId: string; readonly userId: string },
): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert(composer.visible, 'The composer is visible');
  assert.equal(composer.placeholder, `Message #${room.name}`,
    'The composer names the exact Room');
  assertRoomRoute(composer.href, room.roomId, room.userId);
}

/** The composer holds exactly `expected`, entered natively, caret at its end. */
export function assertNativeComposerValue(
  composer: ComposerObservation,
  expected: string,
): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert(composer.focused, 'The composer keeps native focus');
  assert.equal(composer.value, expected, 'The composer holds the exact native text');
  assert.equal(composer.selectionStart, expected.length, 'The caret is at the draft end');
  assert.equal(composer.selectionEnd, expected.length, 'The caret selection is collapsed');
}

/** Helper line 75: the single-flight send control is enabled for the exact draft. */
export function assertSendReady(composer: ComposerObservation, draft: NativeDraft): void {
  assertNativeComposerValue(composer, draft.value);
  assert.equal(draft.value.split('\n').length, draft.lines.length,
    'Every predecessor line is a real line of the draft');
  assert(!draft.value.includes('\r'), 'Line breaks are bare newlines');
  assert.equal(composer.sendCount, 1, 'Exactly one send control');
  assert.equal(composer.sendDisabled, false, 'The send control is enabled');
}

/**
 * Helper line 53: with the keyboard dismissed the composer's Send button is still
 * enabled for the exact draft. Dismissing the keyboard may release caret focus.
 */
export function assertSendEnabled(composer: ComposerObservation, draft: NativeDraft): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert.equal(composer.value, draft.value, 'The composer still holds the exact draft');
  assert.equal(composer.sendCount, 1, 'Exactly one Send button');
  assert.equal(composer.sendDisabled, false, 'The Send button is enabled');
}

/** The Send tap cleared the composer: the draft left through the product send path. */
export function assertDraftSent(composer: ComposerObservation): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert.equal(composer.value, '', 'The composer is empty after the native send');
}

// Timeline rendering.

export interface CodeBlockObservation {
  readonly visible: boolean;
  readonly language: string | null;
  readonly caption: string | null;
  readonly captionOpacity: string | null;
  readonly captionDisplay: string | null;
  readonly text: string;
}

export interface MessageTextObservation {
  readonly html: boolean;
  readonly text: string;
  readonly normalized: string;
  readonly visible: boolean;
  readonly whiteSpace: string;
  readonly strong: readonly string[];
  readonly breaks: number;
  readonly items: readonly string[];
  readonly inputs: number;
  readonly checkboxes: number;
  readonly pres: readonly CodeBlockObservation[];
}

export interface MessageRowObservation {
  readonly id: string;
  readonly event: boolean;
  readonly continuation: boolean;
  readonly visible: boolean;
  readonly text: string;
  readonly toolbarCount: number;
  readonly texts: readonly MessageTextObservation[];
}

export interface TimelineObservation {
  readonly hoverNone: boolean | null;
  readonly toolbarCount: number;
  readonly rows: readonly MessageRowObservation[];
}

function parseCodeBlock(value: unknown, name: string): CodeBlockObservation {
  const pre = object(value, name);
  return {
    visible: booleanField(pre, 'visible'),
    language: nullableStringField(pre, 'language'),
    caption: nullableStringField(pre, 'caption'),
    captionOpacity: nullableStringField(pre, 'captionOpacity'),
    captionDisplay: nullableStringField(pre, 'captionDisplay'),
    text: stringField(pre, 'text'),
  };
}

function parseMessageText(value: unknown, name: string): MessageTextObservation {
  const text = object(value, name);
  return {
    html: booleanField(text, 'html'),
    text: stringField(text, 'text'),
    normalized: stringField(text, 'normalized'),
    visible: booleanField(text, 'visible'),
    whiteSpace: stringField(text, 'whiteSpace'),
    strong: stringArrayField(text, 'strong'),
    breaks: countField(text, 'breaks'),
    items: stringArrayField(text, 'items'),
    inputs: countField(text, 'inputs'),
    checkboxes: countField(text, 'checkboxes'),
    pres: arrayField(text, 'pres').map((pre, index) =>
      parseCodeBlock(pre, `${name} code block ${index}`)),
  };
}

/** Reject incomplete CDP values before any source-mapped assertion is recorded. */
export function parseTimeline(value: unknown): TimelineObservation {
  const timeline = object(value, 'Timeline observation');
  return {
    hoverNone: nullableBooleanField(timeline, 'hoverNone'),
    toolbarCount: countField(timeline, 'toolbarCount'),
    rows: arrayField(timeline, 'rows').map((raw, index): MessageRowObservation => {
      const row = object(raw, `Timeline row ${index}`);
      return {
        id: stringField(row, 'id'),
        event: booleanField(row, 'event'),
        continuation: booleanField(row, 'continuation'),
        visible: booleanField(row, 'visible'),
        text: stringField(row, 'text'),
        toolbarCount: countField(row, 'toolbarCount'),
        texts: arrayField(row, 'texts').map((text, textIndex) =>
          parseMessageText(text, `Timeline row ${index} text ${textIndex}`)),
      };
    }),
  };
}

/** Every rendered `.msg__text` whose text contains `needle`, in document order. */
export function messageTexts(
  timeline: TimelineObservation,
  needle: string,
  html?: boolean,
): readonly MessageTextObservation[] {
  return timeline.rows.flatMap((row) => row.texts).filter((text) =>
    text.text.includes(needle) && (html === undefined || text.html === html));
}

function oneText(
  timeline: TimelineObservation,
  needle: string,
  html: boolean | undefined,
  name: string,
): MessageTextObservation {
  const texts = messageTexts(timeline, needle, html);
  assert.equal(texts.length, 1, `Exactly one ${name} carries ${JSON.stringify(needle)}`);
  assert(texts[0]!.visible, `The ${name} is visible`);
  return texts[0]!;
}

/** Line 86 plus plain-row preservation: pre-wrap plain text with its literal newline. */
export function assertPlainRow(timeline: TimelineObservation): MessageTextObservation {
  const plain = oneText(timeline, 'plain one', undefined, 'message text');
  assert.equal(plain.html, false, 'The plain message renders as plain text');
  assert.equal(plain.text, PLAIN_BODY, 'The plain row renders the exact two lines');
  assert.equal(plain.breaks, 0, 'The plain row carries its newline as text, not <br>');
  assert.equal(plain.whiteSpace, 'pre-wrap', 'The plain row preserves its line break');
  return plain;
}

/** Line 94: exactly one rendered-markdown text carries the second line. */
export function assertRichVisible(timeline: TimelineObservation): MessageTextObservation {
  return oneText(timeline, 'rich two', true, 'rendered-markdown text');
}

/** Line 95: exactly one bold run, and it is the exact source text. */
export function assertBoldRun(rich: MessageTextObservation): void {
  assert.deepEqual(rich.strong, ['bold one'], 'Exactly one bold run reads "bold one"');
}

/** Line 96: exactly one real `<br>`; a wrapped visual line is not a break. */
export function assertOneBreak(rich: MessageTextObservation): void {
  assert.equal(rich.breaks, 1, 'Exactly one rendered <br> element');
}

/** Helper line 178: the one row carrying `needle` is the reconciled server event. */
export function assertServerEcho(
  timeline: TimelineObservation,
  needle: string,
): MessageRowObservation {
  const rows = timeline.rows.filter((row) => !row.event && row.text.includes(needle));
  assert.equal(rows.length, 1, `Exactly one Room row carries ${JSON.stringify(needle)}`);
  assert(rows[0]!.id.startsWith('$'), 'The row carries the homeserver event id');
  assert(rows[0]!.visible, 'The reconciled row is visible');
  return rows[0]!;
}

/** Line 163: exactly one visible rendered-markdown list carries the task text. */
export function assertTaskListVisible(timeline: TimelineObservation): MessageTextObservation {
  return oneText(timeline, 'shipped', true, 'rendered task list');
}

/** Line 164: the ticked item leads with the exact ballot-box-with-check glyph. */
export function assertCheckedGlyph(list: MessageTextObservation): void {
  assert(list.normalized.includes('☑ shipped'), 'The list shows "☑ shipped"');
  assert.equal(list.items[0], '☑ shipped', 'The first task item is exactly "☑ shipped"');
}

/** Line 165: the continued item is unticked with the exact empty ballot-box glyph. */
export function assertUncheckedGlyph(list: MessageTextObservation): void {
  assert(list.normalized.includes('☐ pending'), 'The list shows "☐ pending"');
  assert.deepEqual(list.items, ['☑ shipped', '☐ pending'],
    'The list holds exactly the two task items');
}

/** Line 167: the state is text, never an interactive checkbox. */
export function assertNoCheckboxInput(list: MessageTextObservation): void {
  assert.equal(list.inputs, 0, 'No input element renders in the task list');
  assert.equal(list.checkboxes, 0, 'No checkbox role or type renders in the task list');
}

export interface CodeRow {
  readonly row: MessageRowObservation;
  readonly text: MessageTextObservation;
  readonly pre: CodeBlockObservation;
}

/** Line 207: exactly one visible fenced block renders in the timeline. */
export function assertCodeVisible(timeline: TimelineObservation): CodeRow {
  const found = timeline.rows.flatMap((row) => row.texts
    .filter((text) => text.html)
    .flatMap((text) => text.pres.map((pre) => ({ row, text, pre }))));
  assert.equal(found.length, 1, 'Exactly one rendered code block');
  assert(found[0]!.pre.visible, 'The code block is visible');
  assert.equal(found[0]!.pre.text.replace(/\n$/u, ''), 'x = 1',
    'The code block holds the exact source line');
  return found[0]!;
}

/** Line 212: the code row is a ready continuation of the lead message. */
export function assertContinuationRow(
  timeline: TimelineObservation,
  codeEventId: string,
  leadEventId: string,
): MessageRowObservation {
  const messages = timeline.rows.filter((row) => !row.event);
  const index = messages.findIndex((row) => row.id === codeEventId);
  assert(index > 0, 'The code row is rendered after another message');
  const row = messages[index]!;
  assert(row.id.startsWith('$'), 'The code row is a ready server event');
  assert(row.continuation, 'The code row is a continuation row (msg--cont)');
  assert(row.texts.some((text) => text.pres.length === 1),
    'The continuation row holds the code block');
  assert.equal(messages[index - 1]!.id, leadEventId,
    'The code row continues the lead message directly');
  return row;
}

/** Line 217: installed touch hosts paint no hover toolbar on the row. */
export function assertNoHoverToolbar(row: MessageRowObservation): void {
  assert.equal(row.toolbarCount, 0, 'The code row paints no hover toolbar');
}

/** Line 218: the generated caption is exactly the declared language. */
export function assertLanguageCaption(pre: CodeBlockObservation): void {
  assert.equal(pre.language, CAPTION_LANGUAGE, 'The block declares the python language');
  assert.equal(pre.caption, CAPTION_CONTENT, 'The ::after caption renders exactly "python"');
}

export interface VisibleTarget {
  readonly visible: boolean;
}

/** Helper line 220, exactly as the message-forward suite proves its native sheet. */
export function assertNativeSheetReady(
  dialogs: readonly VisibleTarget[],
  forwardActions: readonly VisibleTarget[],
): void {
  assert.equal(dialogs.length, 1, 'Exactly one Android message-action sheet');
  assert.equal(dialogs[0]?.visible, true, 'Android action sheet is visible');
  assert.equal(forwardActions.length, 1, 'Exactly one Forward action');
  assert.equal(forwardActions[0]?.visible, true, 'Forward action is visible');
}

/** Line 223: the returned sheet is still the one visible Message actions dialog. */
export function assertSheetVisible(dialogs: readonly VisibleTarget[]): void {
  assert.equal(dialogs.length, 1, 'Exactly one Message actions dialog');
  assert.equal(dialogs[0]?.visible, true, 'The Message actions dialog is visible');
}

// Authoritative server events.

/**
 * The predecessor's reader (29–47): every `m.room.message` in one
 * `/messages?dir=b&limit=50` page, oldest first.
 */
export function authoritativeRoomMessages(
  response: unknown,
): readonly Readonly<Record<string, unknown>>[] {
  const page = object(response, 'Room messages page');
  const chunk = arrayField(page, 'chunk');
  return chunk
    .map((event, index) => object(event, `Room messages event ${index}`))
    .filter((event) => event['type'] === 'm.room.message')
    .reverse();
}

export interface SentEventExpectation {
  readonly eventId: string;
  readonly roomId: string;
  readonly sender: string;
}

function content(event: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return object(event['content'], 'Event content');
}

/** A native send, reconciled: its id, Room, sender, type and original m.text. */
export function assertSentEvent(
  event: Readonly<Record<string, unknown>>,
  expected: SentEventExpectation,
): void {
  const eventId = event['event_id'];
  assert(typeof eventId === 'string' && eventId.startsWith('$'),
    'Sent event has a real Matrix event id');
  assert.equal(eventId, expected.eventId, 'Server event matches the reconciled Room row');
  assert.equal(event['room_id'], expected.roomId, 'Event belongs to the exact Room');
  assert.equal(event['sender'], expected.sender, 'Event has the active sender');
  assert.equal(event['type'], 'm.room.message', 'Event is a Room message');
  const body = content(event);
  assert.equal(body['msgtype'], 'm.text', 'Event is a text message');
  assert(!('m.relates_to' in body) && !('m.new_content' in body),
    'Event is an original message');
}

export interface FormattingEvents {
  readonly plain: Readonly<Record<string, unknown>>;
  readonly formatted: Readonly<Record<string, unknown>>;
}

/** The Room holds exactly the two native sends, oldest first, as the reconciled rows. */
export function assertFormattingEvents(
  events: readonly Readonly<Record<string, unknown>>[],
  plain: SentEventExpectation,
  formatted: SentEventExpectation,
): FormattingEvents {
  assert.equal(events.length, 2, 'The Room holds exactly the two native messages');
  assertSentEvent(events[0]!, plain);
  assertSentEvent(events[1]!, formatted);
  return { plain: events[0]!, formatted: events[1]! };
}

/** Line 114. */
export function assertPlainBody(plain: Readonly<Record<string, unknown>>): void {
  assert.equal(content(plain)['body'], PLAIN_BODY, 'The plain body is the exact two lines');
}

/** Line 115. */
export function assertPlainNoFormat(plain: Readonly<Record<string, unknown>>): void {
  assert(!('format' in content(plain)), 'The plain message carries no format');
}

/** Line 116. */
export function assertPlainNoFormattedBody(plain: Readonly<Record<string, unknown>>): void {
  assert(!('formatted_body' in content(plain)), 'The plain message carries no HTML body');
}

/** Line 118. */
export function assertFormattedFormat(formatted: Readonly<Record<string, unknown>>): void {
  assert.equal(content(formatted)['format'], HTML_FORMAT,
    'The formatted message declares Matrix HTML');
}

function formattedBody(formatted: Readonly<Record<string, unknown>>): string {
  const body = content(formatted)['formatted_body'];
  assert(typeof body === 'string', 'The formatted message carries an HTML body');
  return body;
}

/** Line 119: one exact `<br>` on the wire; rendering is never used to infer it. */
export function assertFormattedBreak(formatted: Readonly<Record<string, unknown>>): void {
  const body = formattedBody(formatted);
  assert(body.includes('<br>'), 'The HTML body contains an exact <br>');
  assert.equal(body.match(/<br\b[^>]*>/giu)?.length, 1, 'The HTML body holds exactly one break');
}

/** Line 120. */
export function assertFormattedBold(formatted: Readonly<Record<string, unknown>>): void {
  assert(formattedBody(formatted).includes('<strong>bold one</strong>'),
    'The HTML body contains the exact bold run');
}

/** Line 124: `body` keeps the author's Markdown source. */
export function assertFormattedSource(formatted: Readonly<Record<string, unknown>>): void {
  assert.equal(content(formatted)['body'], FORMATTED_BODY,
    'The formatted body retains the exact Markdown source');
}

/** Task-list receipt: the ready event carries the continued source and glyph HTML. */
export function assertTaskEvent(
  event: Readonly<Record<string, unknown>>,
  expected: SentEventExpectation,
): void {
  assertSentEvent(event, expected);
  assert.equal(content(event)['body'], TASK_BODY, 'The task body is the continued source');
  assertFormattedFormat(event);
  const body = formattedBody(event);
  assert(body.includes('☑') && body.includes('☐'), 'The HTML body carries both glyphs');
  assert(!/<input\b/iu.test(body), 'The HTML body carries no input element');
}

/** Code-caption receipt: a plain lead and a fenced python block. */
export function assertLeadEvent(
  event: Readonly<Record<string, unknown>>,
  expected: SentEventExpectation,
): void {
  assertSentEvent(event, expected);
  assert.equal(content(event)['body'], LEAD_BODY, 'The lead body is exact');
  assert(!('format' in content(event)) && !('formatted_body' in content(event)),
    'The lead is plain text');
}

export function assertCodeEvent(
  event: Readonly<Record<string, unknown>>,
  expected: SentEventExpectation,
): void {
  assertSentEvent(event, expected);
  assert.equal(content(event)['body'], CODE_BODY, 'The code body is the exact fence');
  assertFormattedFormat(event);
  const body = formattedBody(event);
  assert(/<pre>\s*<code class="language-python">/u.test(body),
    'The HTML body is a python fenced block');
}
