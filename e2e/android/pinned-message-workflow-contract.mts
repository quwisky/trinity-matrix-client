import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export const PINNED_WORKFLOW_SOURCE =
  'e2e/browser/journeys/conversations/pinned-message-workflow.spec.mts';
/**
 * The canonical bytes are the issue's pin, a Git object at the retirement
 * commit (spec open question 1): `readRetiredPredecessor` reads them.
 */
export const PINNED_WORKFLOW_SOURCE_SHA256 =
  'ee52c7e30ba06c519d277e0009416e63f1c5239a98e56fe1a6187cb8d18620f2';
export const PINNED_WORKFLOW_SOURCE_LINES = 446;

export const PINNED_WORKFLOW_SHARED_SOURCE_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
} as const;

export const PINNED_WORKFLOW_STAGE_IDS = ['pin-jump-unpin', 'repeat-jump'] as const;

export type PinnedWorkflowStageId = (typeof PINNED_WORKFLOW_STAGE_IDS)[number];

export interface PinnedWorkflowSpan {
  readonly from: number;
  readonly to: number;
}

/** Owned predecessor spans: both Room-arrangement helpers, both definitions and the excluded desktop definition. */
export const PINNED_WORKFLOW_SPANS = {
  seedPinRoom: { from: 91, to: 124 },
  seedRepeatJumpPinRoom: { from: 137, to: 188 },
  excluded: { from: 402, to: 445 },
  definitions: {
    'pin-jump-unpin': { from: 193, to: 290 },
    'repeat-jump': { from: 300, to: 400 },
  },
} as const satisfies {
  readonly seedPinRoom: PinnedWorkflowSpan;
  readonly seedRepeatJumpPinRoom: PinnedWorkflowSpan;
  readonly excluded: PinnedWorkflowSpan;
  readonly definitions: Readonly<Record<PinnedWorkflowStageId, PinnedWorkflowSpan>>;
};

/** The Android branch's one readiness helper: its `expect` sits at app.mts 220. */
export const PINNED_WORKFLOW_HELPERS = {
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

export type PinnedWorkflowHelper = keyof typeof PINNED_WORKFLOW_HELPERS;

/** The desktop `else` branch's helper: reached only from 229, never expanded here. */
export const PINNED_WORKFLOW_EXCLUDED = [
  { helper: 'clickRowMenuItem', module: 'e2e/support/app.mts', line: 206, call: 229, reason: 'desktop else branch' },
] as const;

/**
 * One source-mapped parity site. `line` is the `expect` line. An inherited
 * site's `helper` owns that line and `call` is the definition-body call line.
 */
export type PinnedWorkflowSite =
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'direct';
    }
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'inherited';
      readonly helper: PinnedWorkflowHelper;
      readonly call: number;
    };

const pinJumpUnpinSites = [
  { line: 212, suffix: 'timeline-visible', kind: 'direct' },
  { line: 220, suffix: 'sheet-ready', kind: 'inherited', helper: 'openMessageActionSheet', call: 226 },
  { line: 237, suffix: 'badge-one', kind: 'direct' },
  { line: 241, suffix: 'panel-heading-visible', kind: 'direct' },
  { line: 246, suffix: 'pin-row-visible', kind: 'direct' },
  { line: 247, suffix: 'pin-row-body', kind: 'direct' },
  { line: 263, suffix: 'jump-flash', kind: 'direct' },
  { line: 267, suffix: 'panel-closed-by-jump', kind: 'direct' },
  { line: 271, suffix: 'target-in-viewport', kind: 'direct' },
  { line: 275, suffix: 'panel-reopened', kind: 'direct' },
  { line: 284, suffix: 'empty-copy-visible', kind: 'direct' },
  { line: 289, suffix: 'badge-cleared', kind: 'direct' },
] as const satisfies readonly PinnedWorkflowSite[];

const repeatJumpSites = [
  { line: 321, suffix: 'timeline-visible', kind: 'direct' },
  { line: 354, suffix: 'last-filler-in-viewport', kind: 'direct' },
  { line: 355, suffix: 'target-offscreen', kind: 'direct' },
  { line: 365, suffix: 'first-heading-visible', kind: 'direct' },
  { line: 366, suffix: 'first-pin-row-visible', kind: 'direct' },
  { line: 369, suffix: 'first-flash', kind: 'direct' },
  { line: 376, suffix: 'first-panel-closed', kind: 'direct' },
  { line: 377, suffix: 'first-target-in-viewport', kind: 'direct' },
  { line: 384, suffix: 'target-offscreen-at-latest', kind: 'direct' },
  { line: 391, suffix: 'second-heading-visible', kind: 'direct' },
  { line: 392, suffix: 'second-pin-row-visible', kind: 'direct' },
  { line: 395, suffix: 'second-flash', kind: 'direct' },
  { line: 398, suffix: 'second-panel-closed', kind: 'direct' },
  { line: 399, suffix: 'second-target-in-viewport', kind: 'direct' },
] as const satisfies readonly PinnedWorkflowSite[];

export type PinnedWorkflowAssertion = `pinned-message-workflow.${PinnedWorkflowStageId}.${string}`;

export interface PinnedWorkflowStage {
  readonly id: PinnedWorkflowStageId;
  readonly source: string;
  readonly title: string;
  readonly sites: readonly PinnedWorkflowSite[];
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly PinnedWorkflowAssertion[];
}

function stage(
  id: PinnedWorkflowStageId,
  title: string,
  sites: readonly PinnedWorkflowSite[],
): PinnedWorkflowStage {
  const span = PINNED_WORKFLOW_SPANS.definitions[id];
  return {
    id,
    source: `${PINNED_WORKFLOW_SOURCE}:${span.from}-${span.to}`,
    title,
    sites,
    expectedAssertionRecords: sites.length,
    assertions: sites.map(
      ({ suffix }): PinnedWorkflowAssertion => `pinned-message-workflow.${id}.${suffix}`,
    ),
  };
}

export const PINNED_WORKFLOW_STAGES: readonly PinnedWorkflowStage[] = [
  stage(
    'pin-jump-unpin',
    'pin a message, see it (and its count) in the pinned panel, jump to it, then unpin it',
    pinJumpUnpinSites,
  ),
  stage(
    'repeat-jump',
    're-jumping to the SAME pinned message a second time still scrolls it into view',
    repeatJumpSites,
  ),
];

export const PINNED_WORKFLOW_ASSERTION_RECORDS = 26;
export const PINNED_WORKFLOW_DIRECT = 25;
export const PINNED_WORKFLOW_INHERITED = 1;
export const PINNED_WORKFLOW_INHERITED_COUNTS = [1, 0] as const;

/** Direct sites order by line; a helper call runs before a later-line matcher. */
function siteOrderKey(site: PinnedWorkflowSite): readonly [number, number] {
  return site.kind === 'direct' ? [site.line, 1] : [site.call, 0];
}

function after(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] !== right[0] ? left[0] > right[0] : left[1] > right[1];
}

function within(line: number, span: PinnedWorkflowSpan): boolean {
  return Number.isInteger(line) && line >= span.from && line <= span.to;
}

function validateContract(): void {
  assert.deepEqual(PINNED_WORKFLOW_STAGES.map(({ id }) => id),
    [...PINNED_WORKFLOW_STAGE_IDS], 'Pinned-workflow stages keep source order');
  const sites = PINNED_WORKFLOW_STAGES.flatMap((entry) => entry.sites);
  const identities = PINNED_WORKFLOW_STAGES.flatMap((entry) => entry.assertions);
  assert.equal(sites.length, PINNED_WORKFLOW_ASSERTION_RECORDS,
    'Pinned-workflow owns exactly 26 records');
  assert.equal(sites.filter((site) => site.kind === 'direct').length,
    PINNED_WORKFLOW_DIRECT, 'Pinned-workflow owns exactly 25 direct sites');
  assert.equal(sites.filter((site) => site.kind === 'inherited').length,
    PINNED_WORKFLOW_INHERITED, 'Pinned-workflow owns exactly 1 inherited site');
  assert.equal(new Set(identities).size, PINNED_WORKFLOW_ASSERTION_RECORDS,
    'Pinned-workflow identities are unique');
  assert.deepEqual(
    PINNED_WORKFLOW_STAGES.map((entry) => entry.sites.filter((site) => site.kind === 'inherited').length),
    [...PINNED_WORKFLOW_INHERITED_COUNTS],
    'Pinned-workflow per-stage inherited counts match [1, 0]',
  );
  assert.deepEqual(
    PINNED_WORKFLOW_STAGES.map((entry) => entry.expectedAssertionRecords),
    [12, 14],
    'Pinned-workflow per-stage record counts match [12, 14]',
  );
  for (const entry of PINNED_WORKFLOW_STAGES) {
    const span = PINNED_WORKFLOW_SPANS.definitions[entry.id];
    assert.equal(entry.expectedAssertionRecords, entry.sites.length,
      `${entry.id} expected records equal its sites`);
    for (const identity of entry.assertions) {
      assert.match(identity, new RegExp(
        `^pinned-message-workflow\\.${entry.id}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`),
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
      const lines: readonly number[] =
        (PINNED_WORKFLOW_HELPERS as Readonly<Record<string, { readonly expectLines: readonly number[] }>>)[site.helper]!.expectLines;
      assert(lines.includes(site.line),
        `${entry.id}.${site.suffix} expands one of ${site.helper}'s expect lines`);
      assert(within(site.call, span),
        `${entry.id}.${site.suffix} call lies inside its definition`);
    }
  }
}

validateContract();

function entryFor(stageId: PinnedWorkflowStageId): PinnedWorkflowStage {
  const entry = PINNED_WORKFLOW_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown pinned-workflow stage ${stageId}`);
  return entry;
}

export function pinnedWorkflowAssertion(
  stageId: PinnedWorkflowStageId,
  suffix: string,
): PinnedWorkflowAssertion {
  const entry = entryFor(stageId);
  const identity: PinnedWorkflowAssertion = `pinned-message-workflow.${stageId}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertPinnedWorkflowRecords(
  stageId: PinnedWorkflowStageId,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stageId).assertions,
    `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for a parity suffix. */
export function assertPinnedWorkflowReceiptName(name: string): void {
  assert.match(name, /^[a-z][a-z0-9-]*$/u, `Receipt name ${name} is kebab-case`);
  const suffixes = new Set(PINNED_WORKFLOW_STAGES.flatMap((entry) => entry.sites.map((site) => site.suffix)));
  assert(!suffixes.has(name), `Receipt ${name} is not a parity suffix`);
}

// Shared field readers (in #756's style: object, countField, booleanField, stringField).

function object(value: unknown, name: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value),
    `${name} is an object`);
  return value as Record<string, unknown>;
}

function arrayField(value: Record<string, unknown>, name: string): readonly unknown[] {
  const candidate = value[name];
  assert(Array.isArray(candidate), `${name} is an array`);
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

function finiteNumberField(value: Record<string, unknown>, name: string): number {
  const candidate = value[name];
  assert(typeof candidate === 'number' && Number.isFinite(candidate), `${name} is a finite number`);
  return candidate;
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

// Arrangement constants and predecessor texts (lines 40-42, 56, 91-188).

export const OTHER_BODY = 'just chatting';
export const PIN_BODY = 'pin me please';
export const REPEAT_PIN_BODY = 'pin me twice please';
export const FILLER_COUNT = 32;
/**
 * Spec D2 amendment (#757): the flood is sent in groups of this size, and each
 * group but the last waits until the app renders its last filler. The app's
 * incremental `/sync` filter sets no timeline limit, so Synapse applies its
 * default of 10; a batch holding more new events is `limited`, and the SDK
 * resets the live timeline, dropping the loaded target row.
 */
export const FILLER_GROUP = 8;
export const EMPTY_COPY = 'No pinned messages in this channel yet.';
export const PANEL_HEADING = 'Pinned messages';
export const CLOSE_LABEL = 'Close pinned messages';
export const PIN_RUN_SUFFIX = 'p';
export const REPEAT_RUN_SUFFIX = 'pr';

export const pinRoomName = (run: string): string => `Pin E2E ${run}`;
export const repeatRoomName = (run: string): string => `Pin Repeat E2E ${run}`;
export const fillerBody = (run: string, i: number): string => `pin-repeat filler ${run} ${i}`;
export const fillerTxn = (run: string, i: number): string => `pin-repeat-filler-${run}-${i}`;
export const pinOtherTxn = (run: string): string => `pin-other-${run}`;
export const pinTargetTxn = (run: string): string => `pin-target-${run}`;
export const repeatLeadTxn = (run: string): string => `pin-repeat-lead-${run}`;
export const repeatTargetTxn = (run: string): string => `pin-repeat-target-${run}`;

/** The predecessor's own bound (263, 369, 395): the renderer clock, not the native gesture (spec D5, open question 3). */
export const FLASH_LATENCY_MS = 1_500;

// Read-only workflow view (D4).

export interface WorkflowScroll { readonly count: number; readonly visible: boolean }
export interface WorkflowRowLocation { readonly count: number; readonly inViewport: boolean }
export interface WorkflowBadge { readonly host: string | null; readonly text: string; readonly visible: boolean }
export interface WorkflowHeading { readonly count: number }
export interface WorkflowPinRow {
  readonly count: number;
  readonly visible: boolean;
  readonly bodyIncludes: boolean;
  readonly unpinCount: number;
  readonly unpinInside: boolean;
  readonly unpinUnobstructed: boolean;
}
export interface WorkflowEmpty { readonly count: number; readonly visible: boolean; readonly exact: boolean }
export interface WorkflowClose { readonly count: number; readonly label: string | null }
export interface WorkflowOpenPinned { readonly count: number; readonly rendered: boolean }
export interface WorkflowJumpLatest { readonly count: number; readonly visible: boolean; readonly unobstructed: boolean }

export interface WorkflowView {
  readonly reducedMotion: boolean;
  readonly namesRoom: boolean;
  readonly scroll: WorkflowScroll;
  readonly target: WorkflowRowLocation;
  readonly lastFiller: WorkflowRowLocation;
  readonly badges: readonly WorkflowBadge[];
  readonly heading: WorkflowHeading;
  readonly pinRow: WorkflowPinRow;
  readonly empty: WorkflowEmpty;
  readonly close: WorkflowClose;
  readonly openPinned: WorkflowOpenPinned;
  readonly jumpLatest: WorkflowJumpLatest;
}

export interface SheetPin { readonly count: number; readonly visible: boolean; readonly unobstructed: boolean }
export interface SheetView { readonly dialogs: number; readonly dialogVisible: boolean; readonly pin: SheetPin }

function parseRowLocation(value: unknown, name: string): WorkflowRowLocation {
  const location = object(value, name);
  return { count: countField(location, 'count'), inViewport: booleanField(location, 'inViewport') };
}

function parseBadge(value: unknown, name: string): WorkflowBadge {
  const badge = object(value, name);
  return {
    host: nullableStringField(badge, 'host'),
    text: stringField(badge, 'text'),
    visible: booleanField(badge, 'visible'),
  };
}

/** Reject an incomplete CDP value before any source-mapped assertion is recorded. */
export function parseWorkflowView(value: unknown): WorkflowView {
  const view = object(value, 'Workflow view observation');
  const scroll = object(view['scroll'], 'Scroll observation');
  const heading = object(view['heading'], 'Heading observation');
  const pinRow = object(view['pinRow'], 'Pin row observation');
  const empty = object(view['empty'], 'Empty-copy observation');
  const close = object(view['close'], 'Close observation');
  const openPinned = object(view['openPinned'], 'Open-pinned observation');
  const jumpLatest = object(view['jumpLatest'], 'Jump-to-latest observation');
  return {
    reducedMotion: booleanField(view, 'reducedMotion'),
    namesRoom: booleanField(view, 'namesRoom'),
    scroll: { count: countField(scroll, 'count'), visible: booleanField(scroll, 'visible') },
    target: parseRowLocation(view['target'], 'Target observation'),
    lastFiller: parseRowLocation(view['lastFiller'], 'Last-filler observation'),
    badges: arrayField(view, 'badges').map((badge, index) => parseBadge(badge, `Badge ${index}`)),
    heading: { count: countField(heading, 'count') },
    pinRow: {
      count: countField(pinRow, 'count'),
      visible: booleanField(pinRow, 'visible'),
      bodyIncludes: booleanField(pinRow, 'bodyIncludes'),
      unpinCount: countField(pinRow, 'unpinCount'),
      unpinInside: booleanField(pinRow, 'unpinInside'),
      unpinUnobstructed: booleanField(pinRow, 'unpinUnobstructed'),
    },
    empty: {
      count: countField(empty, 'count'),
      visible: booleanField(empty, 'visible'),
      exact: booleanField(empty, 'exact'),
    },
    close: { count: countField(close, 'count'), label: nullableStringField(close, 'label') },
    openPinned: { count: countField(openPinned, 'count'), rendered: booleanField(openPinned, 'rendered') },
    jumpLatest: {
      count: countField(jumpLatest, 'count'),
      visible: booleanField(jumpLatest, 'visible'),
      unobstructed: booleanField(jumpLatest, 'unobstructed'),
    },
  };
}

export function parseSheetView(value: unknown): SheetView {
  const view = object(value, 'Sheet view observation');
  const pin = object(view['pin'], 'Sheet pin observation');
  return {
    dialogs: countField(view, 'dialogs'),
    dialogVisible: booleanField(view, 'dialogVisible'),
    pin: {
      count: countField(pin, 'count'),
      visible: booleanField(pin, 'visible'),
      unobstructed: booleanField(pin, 'unobstructed'),
    },
  };
}

// The passive flash recorder's window (D5).

export interface FlashEvent {
  readonly kind: 'click' | 'add' | 'remove';
  readonly at: number;
  /** `add`/`remove` only. */
  readonly label?: 'target' | 'other';
  readonly inViewport?: boolean;
  /** `click` only. */
  readonly itemLabel?: 'target' | 'other' | null;
  readonly trusted?: boolean;
  readonly targetInViewport?: boolean;
}
export interface FlashWindow { readonly events: readonly FlashEvent[] }

function parseFlashEvent(value: unknown, name: string): FlashEvent {
  const event = object(value, name);
  const kind = event['kind'];
  const at = finiteNumberField(event, 'at');
  if (kind === 'click') {
    const itemLabel = event['itemLabel'];
    assert(itemLabel === 'target' || itemLabel === 'other' || itemLabel === null,
      `${name} itemLabel is target, other or null`);
    return {
      kind,
      at,
      itemLabel,
      trusted: booleanField(event, 'trusted'),
      targetInViewport: booleanField(event, 'targetInViewport'),
    };
  }
  assert(kind === 'add' || kind === 'remove', `${name} kind is click, add or remove`);
  const label = event['label'];
  assert(label === 'target' || label === 'other', `${name} label is target or other`);
  return { kind, at, label, inViewport: booleanField(event, 'inViewport') };
}

export function parseFlashWindow(value: unknown): FlashWindow {
  const window = object(value, 'Flash window observation');
  return { events: arrayField(window, 'events').map((event, index) => parseFlashEvent(event, `Flash event ${index}`)) };
}

// Record asserters (D4, D7).

export function assertMotionFull(v: WorkflowView): void {
  assert(!v.reducedMotion, 'reduced motion is on; revisit animator_duration_scale (#755 M5)');
}
export function assertTimelineVisible(v: WorkflowView): void {
  assert(v.scroll.count === 1 && v.scroll.visible, 'The timeline is visible');
}
export function assertTargetRendered(v: WorkflowView): void {
  assert.equal(v.target.count, 1, 'Exactly one target row is rendered');
}
export function assertSheetReady(v: SheetView): void {
  assert(v.dialogs === 1 && v.dialogVisible, 'The Message actions sheet is visible');
  assert.equal(v.pin.count, 1, 'The sheet holds exactly one sheet-pin control');
}
export function assertSheetPinReachable(v: SheetView): void {
  assert(v.pin.count === 1 && v.pin.visible && v.pin.unobstructed,
    'sheet-pin is visible and unobstructed');
}
export function assertBadgeOne(v: WorkflowView): void {
  const overflow = v.badges.find((badge) => badge.host === 'room-actions-overflow');
  assert(overflow, 'The overflow pin badge exists');
  assert(overflow.visible && overflow.text === '1', 'The overflow pin badge reads 1 and is visible');
  assert(v.badges.every((badge) => badge.text === '1'), 'Every pin badge reads 1');
}
export function assertOpenPinnedHidden(v: WorkflowView): void {
  assert.equal(v.openPinned.count, 1, 'open-pinned exists in the document at Pixel 5');
  assert(!v.openPinned.rendered, 'open-pinned is visible at Pixel 5; revisit D3');
}
export function assertHeadingVisible(v: WorkflowView): void {
  assert.equal(v.heading.count, 1, 'The Pinned messages heading is visible');
}
export function assertHeadingHidden(v: WorkflowView): void {
  assert.equal(v.heading.count, 0, 'The Pinned messages heading is hidden');
}
export function assertPinRowVisible(v: WorkflowView): void {
  assert(v.pinRow.count === 1 && v.pinRow.visible, 'The target pin row is visible');
}
export function assertPinRowBody(v: WorkflowView): void {
  assert(v.pinRow.count === 1 && v.pinRow.bodyIncludes, "The pin row's body contains the target text");
}
export function assertTargetInViewport(v: WorkflowView): void {
  assert(v.target.count === 1 && v.target.inViewport, 'The target row is in the viewport');
}
/** "Not in viewport" also requires the row to be rendered (D4, D7): a removed row never passes as offscreen. */
export function assertTargetOffscreen(v: WorkflowView): void {
  assert.equal(v.target.count, 1, 'The target row is rendered');
  assert(!v.target.inViewport, 'The target row is out of the viewport');
}
export function assertLastFillerRendered(v: WorkflowView): void {
  assert.equal(v.lastFiller.count, 1, 'The last filler row is rendered');
}
export function assertLastFillerInViewport(v: WorkflowView): void {
  assert.equal(v.lastFiller.count, 1, 'The last filler row is rendered');
  assert(v.lastFiller.inViewport, 'The last filler row is in the viewport');
}
export function assertUnpinTarget(v: WorkflowView): void {
  assert.equal(v.pinRow.count, 1, 'Exactly one pin row holds the target');
  assert.equal(v.pinRow.unpinCount, 1, 'The pin row holds exactly one unpin control');
  assert(v.pinRow.unpinInside, 'The unpin control lies inside its own row');
  assert(v.pinRow.unpinUnobstructed, 'The unpin control centre is unobstructed');
}
export function assertEmptyCopy(v: WorkflowView): void {
  assert.equal(v.empty.count, 1, 'Exactly one empty-copy element exists');
  assert(v.empty.visible && v.empty.exact, 'The empty-copy text is visible and exact');
}
export function assertCloseControl(v: WorkflowView): void {
  assert.equal(v.close.count, 1, 'Exactly one pinned-close control exists');
  assert.equal(v.close.label, CLOSE_LABEL, 'The close control label is exact');
}
export function assertBadgeCleared(v: WorkflowView): void {
  assert.equal(v.badges.length, 0, 'No pin badge remains');
}
export function assertJumpLatestReady(v: WorkflowView): void {
  assert.equal(v.jumpLatest.count, 1, 'Exactly one jump-to-latest control exists');
  assert(v.jumpLatest.visible && v.jumpLatest.unobstructed,
    'jump-to-latest did not appear; revisit D3');
}

export interface FlashSummary { readonly latencyMs: number; readonly durationMs: number; readonly offscreenAtClick: boolean }

export function flashWindowComplete(window: FlashWindow): boolean {
  try { assertJumpFlash(window, { requireOffscreenAtClick: false }); return true; } catch { return false; }
}

/** Spec D5: the jump's own trusted click, then a new self-clearing flash on the target only. */
export function assertJumpFlash(window: FlashWindow,
  options: { readonly requireOffscreenAtClick: boolean }): FlashSummary {
  const clicks = window.events.filter((e) => e.kind === 'click' && e.trusted);
  assert.equal(clicks.length, 1, 'Exactly one trusted click in the flash window');
  const click = clicks[0]!;
  assert.equal(click.itemLabel, 'target', 'The trusted click landed on the target pin row');
  if (options.requireOffscreenAtClick)
    assert.equal(click.targetInViewport, false, 'The target was offscreen at the trusted click');
  const adds = window.events.filter((e) => e.kind === 'add');
  assert(!adds.some((e) => e.at < click.at), 'No flash before the jump click');
  assert(!adds.some((e) => e.label !== 'target'), 'Only the target row flashes');
  const first = adds.find((e) => e.at >= click.at);
  assert(first, 'The jump flashed the target row');
  const latencyMs = first.at - click.at;
  assert(latencyMs <= FLASH_LATENCY_MS, `The flash landed within ${FLASH_LATENCY_MS} ms of the click`);
  const removed = window.events.find((e) => e.kind === 'remove' && e.label === 'target' && e.at > first.at);
  assert(removed, 'The flash class cleared itself');
  return { latencyMs, durationMs: removed.at - first.at, offscreenAtClick: click.targetInViewport === false };
}

// Authoritative server events (`/messages` `chunk`, oldest first — the whole page, including state events).

type MatrixEvent = Readonly<Record<string, unknown>>;
const body = (event: MatrixEvent): unknown => Object(event['content'])['body'];

/** The page is the whole history only if it reaches the Room's creation. */
function assertWholeHistory(events: readonly MatrixEvent[]): void {
  assert(events.some((event) => event['type'] === 'm.room.create'), 'The /messages page reaches m.room.create');
}

function assertMessages(events: readonly MatrixEvent[], sender: string,
  expected: readonly { readonly body: string; readonly id: string }[]): void {
  assertWholeHistory(events);
  const messages = events.filter((event) => event['type'] === 'm.room.message');
  assert.equal(messages.length, expected.length, `The Room holds exactly ${expected.length} messages`);
  messages.forEach((event, index) => {
    assert.equal(event['sender'], sender, `Message ${index} is from the reader`);
    assert.equal(body(event), expected[index]!.body, `Message ${index} has the exact body`);
    assert.equal(event['event_id'], expected[index]!.id, `Message ${index} is the arranged event`);
  });
}

export function assertPinArrangement(events: readonly MatrixEvent[], pins: MatrixEvent | undefined,
  e: { readerId: string; otherId: string; targetId: string }): void {
  assertMessages(events, e.readerId, [{ body: OTHER_BODY, id: e.otherId }, { body: PIN_BODY, id: e.targetId }]);
  assert(pins === undefined || isDeepStrictEqual(pins['pinned'], []),
    'No pin exists before the native pin');
}

export function assertRepeatArrangement(events: readonly MatrixEvent[], pins: MatrixEvent | undefined,
  e: { readerId: string; leadId: string; targetId: string }): void {
  assertMessages(events, e.readerId, [{ body: OTHER_BODY, id: e.leadId }, { body: REPEAT_PIN_BODY, id: e.targetId }]);
  assert(isDeepStrictEqual(pins?.['pinned'], [e.targetId]), 'The server pinned state is exactly the target');
}

export function assertFillers(events: readonly MatrixEvent[],
  e: { readerId: string; run: string; leadId: string; targetId: string; fillerIds: readonly string[] }): void {
  assert.equal(e.fillerIds.length, FILLER_COUNT, 'Exactly 32 filler sends returned');
  assertMessages(events, e.readerId, [
    { body: OTHER_BODY, id: e.leadId }, { body: REPEAT_PIN_BODY, id: e.targetId },
    ...e.fillerIds.map((id, i) => ({ body: fillerBody(e.run, i), id })),
  ]);
}

export function assertServerPins(state: MatrixEvent | undefined, expected: readonly string[]): void {
  assert(state !== undefined && isDeepStrictEqual(state['pinned'], [...expected]),
    `The server pinned state converged to exactly ${expected.length} pin(s)`);
}
