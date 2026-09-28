import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export const PINNED_PANEL_SOURCE =
  'e2e/browser/journeys/conversations/pinned-message-panel.spec.mts';
/** The predecessor stays enabled and unchanged; the branch file hashes to the issue's pin. */
export const PINNED_PANEL_SOURCE_SHA256 =
  'd30470d1c2129818a096aefdf50768d31c4eae995ce17b5300e69afc696d56c0';
export const PINNED_PANEL_SOURCE_LINES = 161;

export const PINNED_PANEL_SHARED_SOURCE_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
} as const;

export const PINNED_PANEL_STAGE_IDS = ['list-unpin'] as const;

export type PinnedPanelStageId = (typeof PINNED_PANEL_STAGE_IDS)[number];

export interface PinnedPanelSpan {
  readonly from: number;
  readonly to: number;
}

/** Owned predecessor spans: the Room-arrangement helper and the definition. */
export const PINNED_PANEL_SPANS = {
  seedPinnedRoom: { from: 34, to: 91 },
  definitions: { 'list-unpin': { from: 96, to: 160 } },
} as const satisfies {
  readonly seedPinnedRoom: PinnedPanelSpan;
  readonly definitions: Readonly<Record<PinnedPanelStageId, PinnedPanelSpan>>;
};

/** No predecessor helper in the definition's own span reaches an `expect`. */
export const PINNED_PANEL_HELPERS = {} as const satisfies Readonly<Record<string, {
  readonly module: string;
  readonly expectLines: readonly number[];
  readonly role: string;
}>>;

export type PinnedPanelHelper = keyof typeof PINNED_PANEL_HELPERS;

/**
 * One source-mapped parity site. `line` is the `expect` line. An inherited
 * site's `helper` owns that line and `call` is the definition-body call line.
 */
export type PinnedPanelSite =
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'direct';
    }
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'inherited';
      readonly helper: PinnedPanelHelper;
      readonly call: number;
    };

const listUnpinSites = [
  { line: 119, suffix: 'panel-visible', kind: 'direct' },
  { line: 120, suffix: 'two-pinned-items', kind: 'direct' },
  { line: 135, suffix: 'room-header-measured', kind: 'direct' },
  { line: 136, suffix: 'panel-header-measured', kind: 'direct' },
  { line: 137, suffix: 'panel-title-measured', kind: 'direct' },
  { line: 139, suffix: 'header-heights-equal', kind: 'direct' },
  { line: 140, suffix: 'title-inset', kind: 'direct' },
  { line: 145, suffix: 'title-centred', kind: 'direct' },
  { line: 154, suffix: 'one-pinned-item', kind: 'direct' },
  { line: 157, suffix: 'panel-stays-open', kind: 'direct' },
  { line: 158, suffix: 'keep-remains', kind: 'direct' },
  { line: 159, suffix: 'unpin-removed', kind: 'direct' },
] as const satisfies readonly PinnedPanelSite[];

export type PinnedPanelAssertion = `pinned-message-panel.${PinnedPanelStageId}.${string}`;

export interface PinnedPanelStage {
  readonly id: PinnedPanelStageId;
  readonly source: string;
  readonly title: string;
  readonly sites: readonly PinnedPanelSite[];
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly PinnedPanelAssertion[];
}

function stage(
  id: PinnedPanelStageId,
  title: string,
  sites: readonly PinnedPanelSite[],
): PinnedPanelStage {
  const span = PINNED_PANEL_SPANS.definitions[id];
  return {
    id,
    source: `${PINNED_PANEL_SOURCE}:${span.from}-${span.to}`,
    title,
    sites,
    expectedAssertionRecords: sites.length,
    assertions: sites.map(
      ({ suffix }): PinnedPanelAssertion => `pinned-message-panel.${id}.${suffix}`,
    ),
  };
}

export const PINNED_PANEL_STAGES: readonly PinnedPanelStage[] = [
  stage('list-unpin', 'lists pinned messages and unpins one in place', listUnpinSites),
];

export const PINNED_PANEL_ASSERTION_RECORDS = 12;
export const PINNED_PANEL_DIRECT = 12;
export const PINNED_PANEL_INHERITED = 0;
export const PINNED_PANEL_HELPER_COUNTS = {} as const satisfies Readonly<Record<PinnedPanelHelper, number>>;

/** Direct sites order by line; a helper call runs before a later-line matcher. */
export function siteOrderKey(site: PinnedPanelSite): readonly [number, number] {
  return site.kind === 'direct' ? [site.line, 1] : [site.call, 0];
}

function after(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] !== right[0] ? left[0] > right[0] : left[1] > right[1];
}

function within(line: number, span: PinnedPanelSpan): boolean {
  return Number.isInteger(line) && line >= span.from && line <= span.to;
}

function validateContract(): void {
  assert.deepEqual(PINNED_PANEL_STAGES.map(({ id }) => id),
    [...PINNED_PANEL_STAGE_IDS], 'Pinned-panel stages keep source order');
  const sites = PINNED_PANEL_STAGES.flatMap((entry) => entry.sites);
  const identities = PINNED_PANEL_STAGES.flatMap((entry) => entry.assertions);
  assert.equal(sites.length, PINNED_PANEL_ASSERTION_RECORDS,
    'Pinned-panel owns exactly 12 records');
  assert.equal(sites.filter((site) => site.kind === 'direct').length,
    PINNED_PANEL_DIRECT, 'Pinned-panel owns exactly 12 direct sites');
  assert.equal(sites.filter((site) => site.kind === 'inherited').length,
    PINNED_PANEL_INHERITED, 'Pinned-panel owns exactly 0 inherited sites');
  assert.equal(new Set(identities).size, PINNED_PANEL_ASSERTION_RECORDS,
    'Pinned-panel identities are unique');
  for (const [helper, expected] of Object.entries(PINNED_PANEL_HELPER_COUNTS)) {
    assert.equal(sites.filter((site) =>
      site.kind === 'inherited' && site.helper === helper).length, expected,
    `${helper} expands exactly ${expected} time`);
  }
  for (const entry of PINNED_PANEL_STAGES) {
    const span = PINNED_PANEL_SPANS.definitions[entry.id];
    assert.equal(entry.expectedAssertionRecords, entry.sites.length,
      `${entry.id} expected records equal its sites`);
    for (const identity of entry.assertions) {
      assert.match(identity, new RegExp(
        `^pinned-message-panel\\.${entry.id}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`),
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
        (PINNED_PANEL_HELPERS as Readonly<Record<string, { readonly expectLines: readonly number[] }>>)[site.helper]!.expectLines;
      assert(lines.includes(site.line),
        `${entry.id}.${site.suffix} expands one of ${site.helper}'s expect lines`);
      assert(within(site.call, span),
        `${entry.id}.${site.suffix} call lies inside its definition`);
    }
  }
}

validateContract();

function entryFor(stageId: PinnedPanelStageId): PinnedPanelStage {
  const entry = PINNED_PANEL_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown pinned-panel stage ${stageId}`);
  return entry;
}

export function pinnedPanelAssertion(
  stageId: PinnedPanelStageId,
  suffix: string,
): PinnedPanelAssertion {
  const entry = entryFor(stageId);
  const identity: PinnedPanelAssertion = `pinned-message-panel.${stageId}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertPinnedPanelRecords(
  stageId: PinnedPanelStageId,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stageId).assertions,
    `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for parity identities. */
export function assertPinnedPanelReceiptName(name: string): void {
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `Receipt name ${name} is kebab-case`);
  assert(!name.startsWith('pinned-message-panel'), `Receipt ${name} is not a parity identity`);
}

// Shared field readers.

function object(value: unknown, name: string): Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value),
    `${name} is an object`);
  return value as Record<string, unknown>;
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

// Arrangement constants (lines 44-48, 71, 101).

export const PINNED_PANEL_RUN_SUFFIX = 'p';
export const pinnedRoomName = (run: string): string => `Pinned Room ${run}`;
export const unpinBody = (run: string): string => `unpin-me-${run}`;
export const keepBody = (run: string): string => `keep-me-${run}`;
export const TITLE_INSET_PX = 12;
export const CENTRE_IMBALANCE_PX = 2;
export const SETTLE_GAP_MS = 500;
export const HOLD_MS = 2_000;
export const HOLD_READS = 4;

export interface Box { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
export type PinLabel = 'unpin' | 'keep' | 'other';
export interface PinnedRow {
  readonly label: PinLabel; readonly box: Box; readonly unpinCount: number;
  readonly unpin: Box | null; readonly unobstructed: boolean;
}
export interface PinnedView {
  readonly roomHeader: { readonly count: number; readonly first: Box | null; readonly namesRoom: boolean };
  readonly panel: { readonly count: number; readonly visible: boolean; readonly box: Box | null;
    readonly containsKeep: boolean; readonly containsUnpin: boolean; readonly animating: boolean };
  readonly panelHeader: { readonly count: number; readonly box: Box | null };
  readonly panelTitle: { readonly count: number; readonly box: Box | null };
  readonly items: { readonly count: number; readonly order: readonly PinLabel[] };
  readonly rows: readonly PinnedRow[];
  readonly openPinned: { readonly count: number; readonly box: Box | null };
}

function parseBox(value: unknown, name: string): Box {
  const box = object(value, name);
  return {
    x: finiteNumberField(box, 'x'),
    y: finiteNumberField(box, 'y'),
    width: finiteNumberField(box, 'width'),
    height: finiteNumberField(box, 'height'),
  };
}

function parseNullableBox(value: unknown, name: string): Box | null {
  return value === null ? null : parseBox(value, name);
}

function parsePinLabel(value: unknown, name: string): PinLabel {
  assert(value === 'unpin' || value === 'keep' || value === 'other', `${name} is a pin label`);
  return value;
}

function parseRow(value: unknown, name: string): PinnedRow {
  const row = object(value, name);
  return {
    label: parsePinLabel(row['label'], `${name} label`),
    box: parseBox(row['box'], `${name} box`),
    unpinCount: countField(row, 'unpinCount'),
    unpin: parseNullableBox(row['unpin'], `${name} unpin box`),
    unobstructed: booleanField(row, 'unobstructed'),
  };
}

/** Reject an incomplete CDP value before any source-mapped assertion is recorded. */
export function parsePinnedView(value: unknown): PinnedView {
  const view = object(value, 'Pinned view observation');
  const roomHeader = object(view['roomHeader'], 'Room header observation');
  const panel = object(view['panel'], 'Panel observation');
  const panelHeader = object(view['panelHeader'], 'Panel header observation');
  const panelTitle = object(view['panelTitle'], 'Panel title observation');
  const items = object(view['items'], 'Items observation');
  const openPinned = object(view['openPinned'], 'Open-pinned observation');
  const rows = arrayField(view, 'rows');
  return {
    roomHeader: {
      count: countField(roomHeader, 'count'),
      first: parseNullableBox(roomHeader['first'], 'Room header first box'),
      namesRoom: booleanField(roomHeader, 'namesRoom'),
    },
    panel: {
      count: countField(panel, 'count'),
      visible: booleanField(panel, 'visible'),
      box: parseNullableBox(panel['box'], 'Panel box'),
      containsKeep: booleanField(panel, 'containsKeep'),
      containsUnpin: booleanField(panel, 'containsUnpin'),
      animating: booleanField(panel, 'animating'),
    },
    panelHeader: {
      count: countField(panelHeader, 'count'),
      box: parseNullableBox(panelHeader['box'], 'Panel header box'),
    },
    panelTitle: {
      count: countField(panelTitle, 'count'),
      box: parseNullableBox(panelTitle['box'], 'Panel title box'),
    },
    items: {
      count: countField(items, 'count'),
      order: arrayField(items, 'order').map((label, index) =>
        parsePinLabel(label, `Item ${index} label`)),
    },
    rows: rows.map((row, index) => parseRow(row, `Row ${index}`)),
    openPinned: {
      count: countField(openPinned, 'count'),
      box: parseNullableBox(openPinned['box'], 'Open-pinned box'),
    },
  };
}

export function assertPanelVisible(v: PinnedView): void {
  assert(v.panel.count === 1 && v.panel.visible, 'The pinned panel is visible');
}
export function assertItemCount(v: PinnedView, n: number): void {
  assert.equal(v.items.count, n, `Exactly ${n} pinned item(s)`);
}
export function assertPinOrder(v: PinnedView): void {
  assert.deepEqual(v.items.order, ['unpin', 'keep'], 'The panel lists the pins in published order');
}
export function assertOpenPinnedHidden(v: PinnedView): void {
  const b = v.openPinned.box;
  assert(v.openPinned.count === 1 && (!b || b.width === 0 || b.height === 0),
    'open-pinned is visible at Pixel 5; revisit D3');
}
export function assertHeaderNamesRoom(v: PinnedView): void {
  assert(v.roomHeader.count >= 1 && v.roomHeader.namesRoom, 'The first page header is the Room header');
}
export function assertMeasured(box: Box | null, what: string): asserts box is Box {
  assert(box !== null, `${what} has a bounding box`);
}
function bars(v: PinnedView): { chat: Box; bar: Box; title: Box } {
  const chat = v.roomHeader.first, bar = v.panelHeader.box, title = v.panelTitle.box;
  assertMeasured(chat, 'Room header'); assertMeasured(bar, 'Panel header'); assertMeasured(title, 'Panel title');
  return { chat, bar, title };
}
export function assertHeaderHeightsEqual(v: PinnedView): void {
  const { chat, bar } = bars(v);
  assert(Object.is(bar.height, chat.height), 'The panel header is as tall as the Room header');
}
export function assertTitleInset(v: PinnedView): void {
  const { bar, title } = bars(v);
  // Playwright toBeCloseTo(12, 0): |expected − received| < 10^0 / 2
  assert(Math.abs(title.x - bar.x - TITLE_INSET_PX) < 0.5, 'The panel title is inset 12 px');
}
export function assertTitleCentred(v: PinnedView): void {
  const { bar, title } = bars(v);
  const above = title.y - bar.y;
  const below = bar.y + bar.height - (title.y + title.height);
  assert(Math.abs(above - below) < CENTRE_IMBALANCE_PX, 'The panel title is vertically centred');
}
const inside = (inner: Box, outer: Box): boolean =>
  inner.x >= outer.x && inner.y >= outer.y &&
  inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
export function assertUnpinTarget(v: PinnedView): void {
  const unpinRows = v.rows.filter((r) => r.label === 'unpin');
  const keepRows = v.rows.filter((r) => r.label === 'keep');
  assert(v.rows.length === 2 && unpinRows.length === 1 && keepRows.length === 1, 'Two rows: unpin and keep');
  const [row] = unpinRows as [PinnedRow]; const [keep] = keepRows as [PinnedRow];
  assert(row.unpinCount === 1 && row.unpin, 'The unpin row holds exactly one unpin control');
  assert(inside(row.unpin, row.box) && !inside(row.unpin, keep.box), 'The unpin control lies inside its own row only');
  assert(row.unobstructed, 'The unpin control centre is unobstructed');
}
/** Records 10–12 on every held read: never satisfied by a closed or empty panel. */
export function assertHeldAfterUnpin(v: PinnedView): void {
  assertPanelVisible(v);
  assertItemCount(v, 1);
  assert(v.panel.containsKeep, 'The panel still contains the kept message');
  assert(!v.panel.containsUnpin, 'The panel no longer contains the unpinned message');
}
export function geometrySettled(
  previous: { readonly at: number; readonly view: PinnedView },
  current: { readonly at: number; readonly view: PinnedView },
): boolean {
  const pick = (v: PinnedView) => JSON.stringify([v.roomHeader.first, v.panelHeader.box, v.panelTitle.box, v.panel.box]);
  return current.at - previous.at >= SETTLE_GAP_MS && !previous.view.panel.animating &&
    !current.view.panel.animating && pick(previous.view) === pick(current.view);
}

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

export interface PinnedArrangementExpectation {
  readonly pinnerId: string;
  readonly unpinBody: string;
  readonly keepBody: string;
  readonly unpinId: string;
  readonly keepId: string;
}

/**
 * Lines 69-83: the Room holds exactly the pinner's two messages, oldest
 * first, and the server's pinned state names them in that same order.
 */
export function assertPinnedArrangement(
  events: readonly MatrixEvent[],
  state: { readonly pinned?: readonly unknown[] },
  expected: PinnedArrangementExpectation,
): void {
  assert.equal(events.length, 2, 'The Room holds exactly the two arranged messages');
  const [unpinEvent, keepEvent] = events.map((event, index) =>
    object(event, `Arranged event ${index}`));
  assert.equal(unpinEvent!['sender'], expected.pinnerId, 'The unpin message is from the pinner');
  assert.equal(object(unpinEvent!['content'], 'Unpin content')['body'], expected.unpinBody,
    'The unpin message has the exact body');
  assert.equal(unpinEvent!['event_id'], expected.unpinId, 'The unpin message has the arranged event id');
  assert.equal(keepEvent!['sender'], expected.pinnerId, 'The keep message is from the pinner');
  assert.equal(object(keepEvent!['content'], 'Keep content')['body'], expected.keepBody,
    'The keep message has the exact body');
  assert.equal(keepEvent!['event_id'], expected.keepId, 'The keep message has the arranged event id');
  assert(isDeepStrictEqual(state.pinned, [expected.unpinId, expected.keepId]),
    'The server pinned state names both events in published order');
}

/** Lines 80-83: the server pinned state deep-equals exactly the one kept event. */
export function assertServerPins(
  state: { readonly pinned?: readonly unknown[] },
  keepId: string,
): void {
  assert(isDeepStrictEqual(state.pinned, [keepId]),
    'The server pinned state holds exactly the kept event');
}
