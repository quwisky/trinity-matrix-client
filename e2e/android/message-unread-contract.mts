import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export const MESSAGE_UNREAD_SOURCE =
  'e2e/browser/journeys/conversations/message-unread.spec.mts';
/** The predecessor stays enabled and unchanged; the branch file hashes to the issue's pin. */
export const MESSAGE_UNREAD_SOURCE_SHA256 =
  'f66ad80bb41f3cc32fb45935a88ad5a94582d1a8921069517f5f0a891d40b8bd';
export const MESSAGE_UNREAD_SOURCE_LINES = 278;

export const MESSAGE_UNREAD_SHARED_SOURCE_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
} as const;

export const MESSAGE_UNREAD_STAGE_IDS = ['divider-jump'] as const;

export type MessageUnreadStageId = (typeof MESSAGE_UNREAD_STAGE_IDS)[number];

export interface MessageUnreadSpan {
  readonly from: number;
  readonly to: number;
}

/** Owned predecessor spans: the two REST helpers, the Room helper and the definition. */
export const MESSAGE_UNREAD_SPANS = {
  apiToken: { from: 21, to: 40 },
  sendText: { from: 42, to: 57 },
  openRoom: { from: 59, to: 67 },
  definitions: { 'divider-jump': { from: 72, to: 277 } },
} as const satisfies {
  readonly apiToken: MessageUnreadSpan;
  readonly sendText: MessageUnreadSpan;
  readonly openRoom: MessageUnreadSpan;
  readonly definitions: Readonly<Record<MessageUnreadStageId, MessageUnreadSpan>>;
};

/** The one helper whose own `expect` line an inherited site expands. */
export const MESSAGE_UNREAD_HELPERS = {
  openRoom: {
    module: MESSAGE_UNREAD_SOURCE,
    expectLines: [64],
    role: 'room-readiness',
  },
} as const satisfies Readonly<Record<string, {
  readonly module: string;
  readonly expectLines: readonly number[];
  readonly role: string;
}>>;

export type MessageUnreadHelper = keyof typeof MESSAGE_UNREAD_HELPERS;

/**
 * One source-mapped parity site. `line` is the `expect` line. An inherited
 * site's `helper` owns that line and `call` is the definition-body call line.
 */
export type MessageUnreadSite =
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'direct';
    }
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'inherited';
      readonly helper: MessageUnreadHelper;
      readonly call: number;
    };

const dividerJumpSites = [
  { line: 64, suffix: 'room-ready', kind: 'inherited', helper: 'openRoom', call: 164 },
  { line: 168, suffix: 'divider-text', kind: 'direct' },
  { line: 171, suffix: 'one-thread-connector', kind: 'direct' },
  { line: 184, suffix: 'connector-above', kind: 'direct' },
  { line: 185, suffix: 'connector-below', kind: 'direct' },
  { line: 206, suffix: 'divider-styled', kind: 'direct' },
  { line: 217, suffix: 'jump-visible', kind: 'direct' },
  { line: 240, suffix: 'jump-hidden', kind: 'direct' },
  { line: 246, suffix: 'smooth-trajectory', kind: 'direct' },
  { line: 256, suffix: 'reduced-motion-query', kind: 'direct' },
  { line: 267, suffix: 'jump-visible-at-latest', kind: 'direct' },
  { line: 272, suffix: 'reduced-jump-hidden', kind: 'direct' },
  { line: 275, suffix: 'reduced-scrolled', kind: 'direct' },
  { line: 276, suffix: 'automatic-only', kind: 'direct' },
] as const satisfies readonly MessageUnreadSite[];

export type MessageUnreadAssertion = `message-unread.${MessageUnreadStageId}.${string}`;

export interface MessageUnreadStage {
  readonly id: MessageUnreadStageId;
  readonly source: string;
  readonly title: string;
  readonly sites: readonly MessageUnreadSite[];
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly MessageUnreadAssertion[];
}

function stage(
  id: MessageUnreadStageId,
  title: string,
  sites: readonly MessageUnreadSite[],
): MessageUnreadStage {
  const span = MESSAGE_UNREAD_SPANS.definitions[id];
  return {
    id,
    source: `${MESSAGE_UNREAD_SOURCE}:${span.from}-${span.to}`,
    title,
    sites,
    expectedAssertionRecords: sites.length,
    assertions: sites.map(
      ({ suffix }): MessageUnreadAssertion => `message-unread.${id}.${suffix}`,
    ),
  };
}

export const MESSAGE_UNREAD_STAGES: readonly MessageUnreadStage[] = [
  stage('divider-jump', 'shows a divider and a jump pill for unread messages', dividerJumpSites),
];

export const MESSAGE_UNREAD_ASSERTION_RECORDS = 14;
export const MESSAGE_UNREAD_DIRECT = 13;
export const MESSAGE_UNREAD_INHERITED = 1;
export const MESSAGE_UNREAD_HELPER_COUNTS = {
  openRoom: 1,
} as const satisfies Readonly<Record<MessageUnreadHelper, number>>;

/** Direct sites order by line; a helper call runs before a later-line matcher. */
export function siteOrderKey(site: MessageUnreadSite): readonly [number, number] {
  return site.kind === 'direct' ? [site.line, 1] : [site.call, 0];
}

function after(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] !== right[0] ? left[0] > right[0] : left[1] > right[1];
}

function within(line: number, span: MessageUnreadSpan): boolean {
  return Number.isInteger(line) && line >= span.from && line <= span.to;
}

function validateContract(): void {
  assert.deepEqual(MESSAGE_UNREAD_STAGES.map(({ id }) => id),
    [...MESSAGE_UNREAD_STAGE_IDS], 'Message-unread stages keep source order');
  const sites = MESSAGE_UNREAD_STAGES.flatMap((entry) => entry.sites);
  const identities = MESSAGE_UNREAD_STAGES.flatMap((entry) => entry.assertions);
  assert.equal(sites.length, MESSAGE_UNREAD_ASSERTION_RECORDS,
    'Message-unread owns exactly 14 records');
  assert.equal(sites.filter((site) => site.kind === 'direct').length,
    MESSAGE_UNREAD_DIRECT, 'Message-unread owns exactly 13 direct sites');
  assert.equal(sites.filter((site) => site.kind === 'inherited').length,
    MESSAGE_UNREAD_INHERITED, 'Message-unread owns exactly 1 inherited site');
  assert.equal(new Set(identities).size, MESSAGE_UNREAD_ASSERTION_RECORDS,
    'Message-unread identities are unique');
  for (const [helper, expected] of Object.entries(MESSAGE_UNREAD_HELPER_COUNTS)) {
    assert.equal(sites.filter((site) =>
      site.kind === 'inherited' && site.helper === helper).length, expected,
    `${helper} expands exactly ${expected} time`);
  }
  for (const entry of MESSAGE_UNREAD_STAGES) {
    const span = MESSAGE_UNREAD_SPANS.definitions[entry.id];
    assert.equal(entry.expectedAssertionRecords, entry.sites.length,
      `${entry.id} expected records equal its sites`);
    for (const identity of entry.assertions) {
      assert.match(identity, new RegExp(
        `^message-unread\\.${entry.id}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`),
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
      const lines: readonly number[] = MESSAGE_UNREAD_HELPERS[site.helper].expectLines;
      assert(lines.includes(site.line),
        `${entry.id}.${site.suffix} expands one of ${site.helper}'s expect lines`);
      assert(within(site.call, span),
        `${entry.id}.${site.suffix} call lies inside its definition`);
    }
  }
  assert(within(MESSAGE_UNREAD_HELPERS.openRoom.expectLines[0], MESSAGE_UNREAD_SPANS.openRoom),
    'The Room-readiness site lies inside the local openRoom helper');
}

validateContract();

function entryFor(stageId: MessageUnreadStageId): MessageUnreadStage {
  const entry = MESSAGE_UNREAD_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown message-unread stage ${stageId}`);
  return entry;
}

export function messageUnreadAssertion(
  stageId: MessageUnreadStageId,
  suffix: string,
): MessageUnreadAssertion {
  const entry = entryFor(stageId);
  const identity: MessageUnreadAssertion = `message-unread.${stageId}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertMessageUnreadRecords(
  stageId: MessageUnreadStageId,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stageId).assertions,
    `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for parity identities. */
export function assertMessageUnreadReceiptName(name: string): void {
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `Receipt name ${name} is kebab-case`);
  assert(!name.startsWith('message-unread'), `Receipt ${name} is not a parity identity`);
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

function finiteNumberField(value: Record<string, unknown>, name: string): number {
  const candidate = value[name];
  assert(typeof candidate === 'number' && Number.isFinite(candidate), `${name} is a finite number`);
  return candidate;
}

function countField(value: Record<string, unknown>, name: string): number {
  const candidate = value[name];
  assert(typeof candidate === 'number' && Number.isInteger(candidate) && candidate >= 0,
    `${name} is a nonnegative integer`);
  return candidate;
}

function arrayField(value: Record<string, unknown>, name: string): readonly unknown[] {
  const candidate = value[name];
  assert(Array.isArray(candidate), `${name} is an array`);
  return candidate;
}

// Applied profile.

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

// Arrangement constants (lines 76, 97, 116, 123, 129, 135, 138, 146, 148, 183-185).

export const MESSAGE_UNREAD_RUN_SUFFIX = 'u';
export const UNREAD_ROOMS = ['motion', 'reduced'] as const;
export type UnreadRoomKey = (typeof UNREAD_ROOMS)[number];
export const unreadRoomName = (run: string, room: UnreadRoomKey): string =>
  `Unread E2E ${run}-${room}`;
export const SEEN_BODY = 'seen already';
export const UNREAD_COUNT = 14;
export const THREAD_ROOT_INDEX = 2;
export const THREAD_BODY = 'Thread after the unread marker';
export const unreadBody = (index: number): string => `unread message ${index}`;
export const transactionId = (run: string, room: UnreadRoomKey, part: string): string =>
  `${run}-${room}-${part}`;
export const GEOMETRY_TOLERANCE = 0.01;
export const DIVIDER_STYLE = {
  display: 'flex', alignItems: 'center', fontWeight: '600', ruleFlexGrow: '1',
} as const;

// Authoritative server events (`/messages` `chunk`, newest first from Synapse).

type MatrixEvent = Readonly<Record<string, unknown>>;

/** Every `m.room.message` in one `/messages` page, oldest first. */
export function authoritativeRoomMessages(response: unknown): readonly MatrixEvent[] {
  const page = object(response, 'Room messages page');
  return arrayField(page, 'chunk')
    .map((event, index) => object(event, `Room messages event ${index}`))
    .filter((event) => event['type'] === 'm.room.message')
    .reverse();
}

export interface UnreadArrangementExpectation {
  readonly readerId: string;
  readonly memberId: string;
  readonly rootEventId: string;
}

/**
 * Lines 97-154: the Room holds exactly `seen already` (member), 14 unread
 * events (member), then the reader's thread reply naming unread event 2 as
 * both its `m.thread` root and `m.in_reply_to` target.
 */
export function assertUnreadArrangement(
  events: readonly MatrixEvent[],
  expected: UnreadArrangementExpectation,
): void {
  assert.equal(events.length, UNREAD_COUNT + 2,
    `The Room holds exactly the arranged ${UNREAD_COUNT + 2} messages`);
  const seen = object(events[0], 'Seen event');
  assert.equal(seen['sender'], expected.memberId, 'The seen message is from the member');
  assert.equal(object(seen['content'], 'Seen content')['body'], SEEN_BODY,
    'The seen message has the exact body');
  for (let i = 0; i < UNREAD_COUNT; i++) {
    const event = object(events[1 + i], `Unread event ${i}`);
    assert.equal(event['sender'], expected.memberId, `Unread event ${i} is from the member`);
    assert.equal(object(event['content'], `Unread event ${i} content`)['body'], unreadBody(i),
      `Unread event ${i} has the exact body`);
  }
  const root = object(events[1 + THREAD_ROOT_INDEX], 'Thread root event');
  assert.equal(root['event_id'], expected.rootEventId,
    'The thread root is the exact unread event at index 2');
  const thread = object(events[UNREAD_COUNT + 1], 'Thread reply event');
  assert.equal(thread['sender'], expected.readerId, 'The thread reply is from the reader');
  const content = object(thread['content'], 'Thread reply content');
  assert.equal(content['body'], THREAD_BODY, 'The thread reply has the exact body');
  assert(isDeepStrictEqual(content['m.relates_to'], {
    rel_type: 'm.thread',
    event_id: expected.rootEventId,
    'm.in_reply_to': { event_id: expected.rootEventId },
  }), 'The thread reply relates to the exact root, both as thread and in-reply-to');
}

// The unread view: scroller, divider, jump pills and the reduced-motion query.

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

function parseBox(value: unknown, name: string): Box {
  const box = object(value, name);
  return {
    left: finiteNumberField(box, 'left'),
    top: finiteNumberField(box, 'top'),
    right: finiteNumberField(box, 'right'),
    bottom: finiteNumberField(box, 'bottom'),
    width: finiteNumberField(box, 'width'),
    height: finiteNumberField(box, 'height'),
  };
}

function parseNullableBox(value: unknown, name: string): Box | null {
  return value === null ? null : parseBox(value, name);
}

export interface ScrollerObservation {
  readonly top: number;
  readonly height: number;
  readonly clientHeight: number;
  readonly box: Box;
}

export interface DividerObservation {
  readonly count: number;
  readonly textContent: string;
  readonly innerText: string;
  readonly box: Box;
  readonly connectorCount: number;
  readonly above: number;
  readonly below: number;
  readonly display: string;
  readonly alignItems: string;
  readonly fontWeight: string;
  readonly ruleFlexGrow: string;
}

export interface PillObservation {
  readonly count: number;
  readonly visible: boolean;
  readonly box: Box | null;
}

export interface UnreadView {
  readonly scroller: ScrollerObservation | null;
  readonly divider: DividerObservation | null;
  readonly jump: PillObservation;
  readonly latest: PillObservation;
  readonly reducedMotion: boolean;
}

function parseScroller(value: unknown): ScrollerObservation | null {
  if (value === null) return null;
  const scroller = object(value, 'Scroller observation');
  return {
    top: finiteNumberField(scroller, 'top'),
    height: finiteNumberField(scroller, 'height'),
    clientHeight: finiteNumberField(scroller, 'clientHeight'),
    box: parseBox(scroller['box'], 'Scroller box'),
  };
}

function parseDivider(value: unknown): DividerObservation | null {
  if (value === null) return null;
  const divider = object(value, 'Divider observation');
  return {
    count: countField(divider, 'count'),
    textContent: stringField(divider, 'textContent'),
    innerText: stringField(divider, 'innerText'),
    box: parseBox(divider['box'], 'Divider box'),
    connectorCount: countField(divider, 'connectorCount'),
    above: finiteNumberField(divider, 'above'),
    below: finiteNumberField(divider, 'below'),
    display: stringField(divider, 'display'),
    alignItems: stringField(divider, 'alignItems'),
    fontWeight: stringField(divider, 'fontWeight'),
    ruleFlexGrow: stringField(divider, 'ruleFlexGrow'),
  };
}

function parsePill(value: unknown, name: string): PillObservation {
  const pill = object(value, name);
  return {
    count: countField(pill, 'count'),
    visible: booleanField(pill, 'visible'),
    box: parseNullableBox(pill['box'], `${name} box`),
  };
}

/** Reject an incomplete CDP value before any source-mapped assertion is recorded. */
export function parseUnreadView(value: unknown): UnreadView {
  const view = object(value, 'Unread view observation');
  return {
    scroller: parseScroller(view['scroller']),
    divider: parseDivider(view['divider']),
    jump: parsePill(view['jump'], 'Jump pill observation'),
    latest: parsePill(view['latest'], 'Jump-to-latest observation'),
    reducedMotion: booleanField(view, 'reducedMotion'),
  };
}

/** Line 168: exactly one divider, whose text names new messages. */
export function assertDividerText(view: UnreadView): void {
  assert(view.divider, 'A divider is rendered');
  assert.equal(view.divider.count, 1, 'Exactly one divider is rendered');
  assert.match(view.divider.textContent, /New messages/iu, 'The divider names new messages');
}

/** Line 171: exactly one thread connector inside the divider. */
export function assertOneConnector(view: UnreadView): void {
  assert(view.divider, 'A divider is rendered');
  assert.equal(view.divider.connectorCount, 1, 'Exactly one thread connector in the divider');
}

/** Line 184: the connector extends at least 8px (with tolerance) above the divider. */
export function assertConnectorAbove(view: UnreadView): void {
  assert(view.divider, 'A divider is rendered');
  assert(view.divider.above >= 8 - GEOMETRY_TOLERANCE,
    'The connector extends above the divider');
}

/** Line 185: the connector extends at least 8px (with tolerance) below the divider. */
export function assertConnectorBelow(view: UnreadView): void {
  assert(view.divider, 'A divider is rendered');
  assert(view.divider.below >= 8 - GEOMETRY_TOLERANCE,
    'The connector extends below the divider');
}

/** Lines 206-211: the divider is actually styled, not merely present. */
export function assertDividerStyled(view: UnreadView): void {
  assert(view.divider, 'A divider is rendered');
  assert(isDeepStrictEqual({
    display: view.divider.display,
    alignItems: view.divider.alignItems,
    fontWeight: view.divider.fontWeight,
    ruleFlexGrow: view.divider.ruleFlexGrow,
  }, DIVIDER_STYLE), 'The divider is styled exactly as the design requires');
}

/** Line 217 / 267: exactly one visible jump-to-unread (or jump-to-latest) pill. */
export function assertJumpVisible(view: UnreadView): void {
  assert.equal(view.jump.count, 1, 'Exactly one jump pill');
  assert(view.jump.visible, 'The jump pill is visible');
}

/** Line 240 / 272: the jump pill is gone or not visible. */
export function assertJumpHidden(view: UnreadView): void {
  assert(view.jump.count === 0 || !view.jump.visible, 'The jump pill is hidden');
}

/** The divider lies above the scroller's own box, off-screen on open. */
export function assertDividerOffAbove(view: UnreadView): void {
  assert(view.scroller, 'The scroller is measured');
  assert(view.divider, 'A divider is rendered');
  assert(view.divider.box.top + view.divider.box.height <= view.scroller.box.top,
    'The divider lies above the scroller, off-screen');
}

/** The scroller sits at its bottom and the jump-to-latest control is gone. */
export function assertAtBottom(view: UnreadView): void {
  assert(view.scroller, 'The scroller is measured');
  assert(view.scroller.top + view.scroller.clientHeight >= view.scroller.height - 1,
    'The scroller sits at its bottom');
  assert(view.latest.count === 0 || !view.latest.visible,
    'The jump-to-latest control is hidden at the bottom');
}

/** Line 256: `matchMedia('(prefers-reduced-motion: reduce)').matches` is exactly `true`. */
export function assertReducedMotionQuery(value: unknown): true {
  assert.equal(value, true, 'The renderer reports prefers-reduced-motion: reduce');
  return true;
}

// The passive frame trajectory: baseline, movement, run, settlement.

export type TrajectorySample = readonly [t: number, scrollTop: number, dividerInView: boolean];
export interface TrajectoryClass {
  readonly kind: 'smooth' | 'automatic' | 'ambiguous' | 'still';
  readonly frames: number;
  readonly baselineFrames: number;
  readonly movements: number;
  readonly longestRun: number;
  /** The jump is the first run; later runs are the re-aim after layout. */
  readonly jumpFrames: number;
  readonly jumpSpanMs: number;
  readonly jumpMaxStepShare: number;
  readonly startTop: number;
  readonly endTop: number;
  readonly settledInView: boolean;
}
export const MOVEMENT_PX = 1;
export const BASELINE_FRAMES = 30;
/** D4: a smooth run passes 2 positions strictly between its ends... */
export const SMOOTH_MIN_INTERMEDIATES = 2;
/** ...spread over at least 45 ms from its first to its last movement... */
export const SMOOTH_MIN_SPAN_MS = 45;
/** ...with no single frame covering 80 % or more of its travel. */
export const SMOOTH_MAX_STEP_SHARE = 0.8;

export function parseTrajectory(value: unknown): readonly TrajectorySample[] {
  assert(Array.isArray(value) && value.length > 0, 'Trajectory samples are an array');
  return value.map((sample: unknown) => {
    assert(Array.isArray(sample) && sample.length === 3, 'Trajectory sample shape');
    const [t, top, inView] = sample as unknown[];
    assert(typeof t === 'number' && Number.isFinite(t), 'Trajectory sample time');
    assert(typeof top === 'number' && Number.isFinite(top), 'Trajectory sample offset');
    assert(typeof inView === 'boolean', 'Trajectory sample divider flag');
    return [t, top, inView] as const;
  });
}

/**
 * D4: a sampler window is evidence only if it saw the tap's click and ended by
 * settling or by the 45 s window after that click. A window that never saw the
 * tap, or that the 120 s ceiling cut short, fails closed before classification.
 */
export function parseSamplerWindow(value: unknown): readonly TrajectorySample[] {
  const window = object(value, 'Sampler window');
  assert.equal(window['done'], true, 'The sampler finished');
  assert.equal(window['tapped'], true, 'The sampler observed the tap');
  assert(window['ended'] === 'settled' || window['ended'] === 'tap-window',
    'The sampler window ended before its 120 s ceiling');
  return parseTrajectory(window['samples']);
}

interface Run {
  readonly frames: number;
  readonly spanMs: number;
  readonly maxStepShare: number;
}

/**
 * D4: a run is a sequence of consecutive frames that move in the same
 * direction; a still frame or a reversal ends it. A run is smooth-shaped when
 * it shows an animation over time, not a frame count: frame starvation under
 * host load spreads a real animation over as few as 3 frames.
 */
function smoothShaped(run: Run): boolean {
  return run.frames - 1 >= SMOOTH_MIN_INTERMEDIATES
    && run.spanMs >= SMOOTH_MIN_SPAN_MS
    && run.maxStepShare < SMOOTH_MAX_STEP_SHARE;
}

export function classifyTrajectory(samples: readonly TrajectorySample[]): TrajectoryClass {
  const runs: Run[] = [];
  let movements = 0;
  let first = -1;
  let steps: number[] = [];
  let startT = 0;
  let lastT = 0;
  const close = (): void => {
    if (steps.length === 0) return;
    const travel = steps.reduce((sum, step) => sum + step, 0);
    runs.push({ frames: steps.length, spanMs: lastT - startT, maxStepShare: Math.max(...steps) / travel });
    steps = [];
  };
  let direction = 0;
  for (let i = 1; i < samples.length; i++) {
    const delta = samples[i]![1] - samples[i - 1]![1];
    if (Math.abs(delta) < MOVEMENT_PX) {
      close();
      direction = 0;
      continue;
    }
    movements++;
    if (first < 0) first = i;
    const sign = Math.sign(delta);
    if (sign !== direction) {
      close();
      startT = samples[i]![0];
    }
    direction = sign;
    lastT = samples[i]![0];
    steps.push(Math.abs(delta));
  }
  close();
  const jump = runs[0];
  const kind =
    jump === undefined ? 'still'
    : smoothShaped(jump) ? 'smooth'
    : jump.frames === 1 && !runs.some(smoothShaped) ? 'automatic'
    : 'ambiguous';
  return {
    kind,
    frames: samples.length,
    baselineFrames: first < 0 ? samples.length : first,
    movements,
    longestRun: Math.max(0, ...runs.map((run) => run.frames)),
    jumpFrames: jump?.frames ?? 0,
    jumpSpanMs: jump?.spanMs ?? 0,
    jumpMaxStepShare: jump?.maxStepShare ?? 0,
    startTop: samples[0]![1],
    endTop: samples.at(-1)![1],
    settledInView: samples.at(-1)![2],
  };
}

function assertSettledAfterBaseline(c: TrajectoryClass): void {
  assert(c.baselineFrames >= BASELINE_FRAMES, 'The scroller was still for the baseline before the tap');
  assert(c.settledInView, 'The divider settled inside the scroller');
}
export function assertSmoothTrajectory(c: TrajectoryClass): void {
  assertSettledAfterBaseline(c);
  assert.equal(c.kind, 'smooth', 'The default jump moved over consecutive frames');
}
export function assertReducedScrolled(c: TrajectoryClass): void {
  assertSettledAfterBaseline(c);
  assert(c.movements >= 1, 'The reduced-motion jump scrolled');
}
export function assertAutomaticOnly(c: TrajectoryClass): void {
  assertSettledAfterBaseline(c);
  assert.equal(c.kind, 'automatic', 'Every reduced-motion movement was a discrete jump');
}
