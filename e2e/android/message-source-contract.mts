import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';

export const MESSAGE_SOURCE_SOURCE =
  'e2e/browser/journeys/conversations/message-source.spec.mts';
/**
 * The predecessor at its branch hash. The issue pins `3d763764…`, its `develop`
 * parent; `fe2c7c3e` replaced the Enter press with `sendComposerDraft` and
 * imported it, which moved every span down by one line.
 */
export const MESSAGE_SOURCE_SOURCE_SHA256 =
  '1a18b0772645d8d1a9cfeb38c8f620f53f37c818543d32b044a7c48be0151ca6';
export const MESSAGE_SOURCE_ISSUE_SOURCE_SHA256 =
  '3d7637643bb5f9b4c8124077f9eb880cb5b8e95e22a899f0ab82269f55115512';
export const MESSAGE_SOURCE_SOURCE_LINES = 106;

export const MESSAGE_SOURCE_SHARED_SOURCE_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
  'e2e/support/message-composer.mts':
    '4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d',
} as const;

export const MESSAGE_SOURCE_STAGE_IDS = ['view-source'] as const;

export type MessageSourceStageId = (typeof MESSAGE_SOURCE_STAGE_IDS)[number];

export interface MessageSourceSpan {
  readonly from: number;
  readonly to: number;
}

/**
 * Owned predecessor spans. The definition owns its Android branch; the desktop
 * `else` branch (the overflow menu) is excluded.
 */
export const MESSAGE_SOURCE_SPANS = {
  openRoom: { from: 18, to: 26 },
  definitions: { 'view-source': { from: 31, to: 105 } },
  androidBranches: { 'view-source': [{ from: 69, to: 71 }] },
  desktopBranches: { 'view-source': [{ from: 72, to: 74 }] },
} as const satisfies {
  readonly openRoom: MessageSourceSpan;
  readonly definitions: Readonly<Record<MessageSourceStageId, MessageSourceSpan>>;
  readonly androidBranches: Readonly<Record<MessageSourceStageId, readonly MessageSourceSpan[]>>;
  readonly desktopBranches: Readonly<Record<MessageSourceStageId, readonly MessageSourceSpan[]>>;
};

/**
 * Helpers whose own `expect` lines an inherited site expands. `openRoom` is the
 * predecessor's module-local helper; `sendComposerDraft` waits for the
 * composer's Send button before its mobile tap (53).
 */
export const MESSAGE_SOURCE_HELPERS = {
  openRoom: {
    module: MESSAGE_SOURCE_SOURCE,
    expectLines: [23],
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

export type MessageSourceHelper = keyof typeof MESSAGE_SOURCE_HELPERS;

/**
 * One source-mapped parity site. `line` is the `expect` line. An inherited
 * site's `helper` owns that line and `call` is the definition-body call line.
 */
export type MessageSourceSite =
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'direct';
    }
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'inherited';
      readonly helper: MessageSourceHelper;
      readonly call: number;
    };

const viewSourceSites = [
  { line: 23, suffix: 'room-ready', kind: 'inherited', helper: 'openRoom', call: 59 },
  { line: 53, suffix: 'send-enabled', kind: 'inherited', helper: 'sendComposerDraft', call: 63 },
  { line: 65, suffix: 'row-visible', kind: 'direct' },
  { line: 178, suffix: 'server-echo', kind: 'inherited', helper: 'waitForSent', call: 66 },
  { line: 220, suffix: 'sheet-ready', kind: 'inherited', helper: 'openMessageActionSheet', call: 70 },
  { line: 78, suffix: 'dialog-visible', kind: 'direct' },
  { line: 80, suffix: 'json-event', kind: 'direct' },
  { line: 81, suffix: 'json-body', kind: 'direct' },
  { line: 100, suffix: 'surface-opaque', kind: 'direct' },
  { line: 103, suffix: 'surface-border', kind: 'direct' },
  { line: 104, suffix: 'surface-shadow', kind: 'direct' },
] as const satisfies readonly MessageSourceSite[];

export type MessageSourceAssertion = `message-source.${MessageSourceStageId}.${string}`;

export interface MessageSourceStage {
  readonly id: MessageSourceStageId;
  readonly source: string;
  readonly title: string;
  readonly sites: readonly MessageSourceSite[];
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly MessageSourceAssertion[];
}

function stage(
  id: MessageSourceStageId,
  title: string,
  sites: readonly MessageSourceSite[],
): MessageSourceStage {
  const span = MESSAGE_SOURCE_SPANS.definitions[id];
  return {
    id,
    source: `${MESSAGE_SOURCE_SOURCE}:${span.from}-${span.to}`,
    title,
    sites,
    expectedAssertionRecords: sites.length,
    assertions: sites.map(
      ({ suffix }): MessageSourceAssertion => `message-source.${id}.${suffix}`,
    ),
  };
}

export const MESSAGE_SOURCE_STAGES: readonly MessageSourceStage[] = [
  stage('view-source', 'shows an event’s raw JSON in the view-source dialog', viewSourceSites),
];

export const MESSAGE_SOURCE_ASSERTION_RECORDS = 11;
export const MESSAGE_SOURCE_DIRECT = 7;
export const MESSAGE_SOURCE_INHERITED = 4;
/** Room readiness, composer-send readiness, real-server echo and action-sheet readiness. */
export const MESSAGE_SOURCE_HELPER_COUNTS = {
  openRoom: 1,
  sendComposerDraft: 1,
  waitForSent: 1,
  openMessageActionSheet: 1,
} as const satisfies Readonly<Record<MessageSourceHelper, number>>;

/** Direct sites order by line; a helper call runs before a later-line matcher. */
export function siteOrderKey(site: MessageSourceSite): readonly [number, number] {
  return site.kind === 'direct' ? [site.line, 1] : [site.call, 0];
}

function after(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] !== right[0] ? left[0] > right[0] : left[1] > right[1];
}

function within(line: number, span: MessageSourceSpan): boolean {
  return Number.isInteger(line) && line >= span.from && line <= span.to;
}

function validateContract(): void {
  assert.deepEqual(MESSAGE_SOURCE_STAGES.map(({ id }) => id),
    [...MESSAGE_SOURCE_STAGE_IDS], 'Message-source stages keep source order');
  const sites = MESSAGE_SOURCE_STAGES.flatMap((entry) => entry.sites);
  const identities = MESSAGE_SOURCE_STAGES.flatMap((entry) => entry.assertions);
  assert.equal(sites.length, MESSAGE_SOURCE_ASSERTION_RECORDS,
    'Message-source owns exactly 11 records');
  assert.equal(sites.filter((site) => site.kind === 'direct').length,
    MESSAGE_SOURCE_DIRECT, 'Message-source owns exactly 7 direct sites');
  assert.equal(sites.filter((site) => site.kind === 'inherited').length,
    MESSAGE_SOURCE_INHERITED, 'Message-source owns exactly 4 inherited sites');
  assert.equal(new Set(identities).size, MESSAGE_SOURCE_ASSERTION_RECORDS,
    'Message-source identities are unique');
  for (const [helper, expected] of Object.entries(MESSAGE_SOURCE_HELPER_COUNTS)) {
    assert.equal(sites.filter((site) =>
      site.kind === 'inherited' && site.helper === helper).length, expected,
    `${helper} expands exactly ${expected} time`);
  }
  for (const entry of MESSAGE_SOURCE_STAGES) {
    const span = MESSAGE_SOURCE_SPANS.definitions[entry.id];
    const desktop: readonly MessageSourceSpan[] = MESSAGE_SOURCE_SPANS.desktopBranches[entry.id];
    const outsideDesktop = (line: number): boolean =>
      desktop.every((branch) => !within(line, branch));
    assert.equal(entry.expectedAssertionRecords, entry.sites.length,
      `${entry.id} expected records equal its sites`);
    for (const identity of entry.assertions) {
      assert.match(identity, new RegExp(
        `^message-source\\.${entry.id}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`),
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
        continue;
      }
      const lines: readonly number[] = MESSAGE_SOURCE_HELPERS[site.helper].expectLines;
      assert(lines.includes(site.line),
        `${entry.id}.${site.suffix} expands one of ${site.helper}'s expect lines`);
      assert(within(site.call, span),
        `${entry.id}.${site.suffix} call lies inside its definition`);
      assert(outsideDesktop(site.call), `${entry.id}.${site.suffix} call is not desktop-only`);
    }
  }
  assert(within(MESSAGE_SOURCE_HELPERS.openRoom.expectLines[0], MESSAGE_SOURCE_SPANS.openRoom),
    'The Room-readiness site lies inside the local openRoom helper');
}

validateContract();

function entryFor(stageId: MessageSourceStageId): MessageSourceStage {
  const entry = MESSAGE_SOURCE_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown message-source stage ${stageId}`);
  return entry;
}

export function messageSourceStage(stageId: MessageSourceStageId): MessageSourceStage {
  return entryFor(stageId);
}

export function messageSourceAssertion(
  stageId: MessageSourceStageId,
  suffix: string,
): MessageSourceAssertion {
  const entry = entryFor(stageId);
  const identity: MessageSourceAssertion = `message-source.${stageId}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertMessageSourceRecords(
  stageId: MessageSourceStageId,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stageId).assertions,
    `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for parity identities. */
export function assertMessageSourceReceiptName(name: string): void {
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `Receipt name ${name} is kebab-case`);
  assert(!name.startsWith('message-source'), `Receipt ${name} is not a parity identity`);
}

// Predecessor fields: the run suffix (36), the Room name (39), the body (40).

export const MESSAGE_SOURCE_RUN_SUFFIX = 'src';
export const sourceRoomName = (run: string): string => `Source ${run}`;
export const sourceBody = (run: string): string => `inspect me ${run}`;
export const SOURCE_EVENT_TYPE = 'm.room.message';
/**
 * Typed before the body, then removed. Android capitalises the first letter
 * typed into an empty field; a digit is never capitalised and Gboard leaves a
 * digit-led lowercase word unchanged (`x` joined to `plain` became `Explain`).
 */
export const BODY_SENTINEL = '1';

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

/** Helper line 23: the composer of the exact Room is visible after native open. */
export function assertRoomReady(composer: ComposerObservation, room: RoomIdentity): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert(composer.visible, 'The composer is visible');
  assert.equal(composer.placeholder, `Message #${room.name}`,
    'The composer names the exact Room');
  assertRoomRoute(composer.href, room.roomId, room.userId);
}

/** The composer holds exactly `expected`, entered natively, with the caret at its end. */
export function assertNativeComposerValue(
  composer: ComposerObservation,
  expected: string,
): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert.equal(composer.value, expected, 'The composer holds the exact native text');
  assert.equal(composer.selectionStart, expected.length, 'The caret is at the end');
  assert.equal(composer.selectionEnd, expected.length, 'The caret selection is collapsed');
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

// Timeline rows.

export interface MessageRowObservation {
  readonly id: string;
  readonly event: boolean;
  readonly visible: boolean;
  readonly text: string;
}

export interface TimelineObservation {
  readonly rows: readonly MessageRowObservation[];
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
      };
    }),
  };
}

/** Line 65: exactly one visible message row carries the body. */
export function assertRowVisible(
  timeline: TimelineObservation,
  body: string,
): MessageRowObservation {
  const rows = timeline.rows.filter((row) => !row.event && row.text.includes(body));
  assert.equal(rows.length, 1, 'Exactly one Room row carries the body');
  assert(rows[0]!.visible, 'The row is visible');
  return rows[0]!;
}

/** Helper line 178: the one row carrying the body is the reconciled server event. */
export function assertServerEcho(
  timeline: TimelineObservation,
  body: string,
): MessageRowObservation {
  const row = assertRowVisible(timeline, body);
  assert(row.id.startsWith('$'), 'The row carries the homeserver event id');
  return row;
}

/** The one row carrying the body is the proved event, by read-only id comparison. */
export function assertSameRow(
  timeline: TimelineObservation,
  body: string,
  eventId: string,
): MessageRowObservation {
  const row = assertServerEcho(timeline, body);
  assert.equal(row.id, eventId, 'The row is the proved server event');
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
  readonly forward: SheetControlObservation;
  readonly viewSource: SheetControlObservation;
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
    forward: parseControl(sheet['forward'], 'Forward control'),
    viewSource: parseControl(sheet['viewSource'], 'View source control'),
  };
}

/**
 * Helper line 220, exactly as the message-forward suite proves its native
 * sheet, plus the one View-source control the Android branch taps (line 71).
 */
export function assertNativeSheetReady(sheet: SheetObservation): void {
  assert.equal(sheet.dialogs, 1, 'Exactly one Android message-action sheet');
  assert(sheet.dialogVisible, 'Android action sheet is visible');
  assert.equal(sheet.forward.count, 1, 'Exactly one Forward action');
  assert(sheet.forward.visible, 'Forward action is visible');
  assert.equal(sheet.viewSource.count, 1, 'Exactly one View source action');
}

/** View source closed the sheet it was picked from. */
export function assertSheetClosed(sheet: SheetObservation): void {
  assert.equal(sheet.dialogs, 0, 'No message-action sheet remains');
  assert.equal(sheet.forward.count + sheet.viewSource.count, 0, 'No sheet control remains');
}

// Authoritative server event.

type MatrixEvent = Readonly<Record<string, unknown>>;

/** Every `m.room.message` in one `/messages?dir=b&limit=50` page, oldest first. */
export function authoritativeRoomMessages(response: unknown): readonly MatrixEvent[] {
  const page = object(response, 'Room messages page');
  return arrayField(page, 'chunk')
    .map((event, index) => object(event, `Room messages event ${index}`))
    .filter((event) => event['type'] === SOURCE_EVENT_TYPE)
    .reverse();
}

export interface SourceEventExpectation {
  readonly eventId: string;
  readonly roomId: string;
  readonly sender: string;
  readonly body: string;
}

/**
 * The Room holds exactly the one native send: a real, original `m.text` with
 * the exact body from the active sender, whose id is the reconciled row.
 */
export function assertSourceRoom(
  events: readonly MatrixEvent[],
  expected: SourceEventExpectation,
): MatrixEvent {
  assert.equal(events.length, 1, 'The Room holds exactly the native message');
  const event = events[0]!;
  const eventId = event['event_id'];
  assert(typeof eventId === 'string' && eventId.startsWith('$'),
    'The sent event has a real Matrix event id');
  assert.equal(eventId, expected.eventId, 'The server event is the reconciled row');
  assert.equal(event['room_id'], expected.roomId, 'The event belongs to the exact Room');
  assert.equal(event['sender'], expected.sender, 'The event has the active sender');
  assert.equal(event['type'], SOURCE_EVENT_TYPE, 'The event is a Room message');
  const content = object(event['content'], 'Event content');
  assert(!('m.relates_to' in content) && !('m.new_content' in content),
    'The event is an original message with no relation');
  assert.equal(content['msgtype'], 'm.text', 'The event is a text message');
  assert.equal(content['body'], expected.body, 'The event body is the exact native text');
  return event;
}

// The message-source dialog.

export interface Box {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface SurfacePaintObservation {
  readonly backgroundColor: string;
  readonly borderTopWidth: string;
  readonly borderTopStyle: string;
  readonly boxShadow: string;
}

export interface SourceDialogObservation {
  /** `[role="dialog"][aria-label="Message source"]` containers. */
  readonly dialogs: number;
  /** `[data-testid="message-source"]` surfaces anywhere. */
  readonly surfaces: number;
  readonly surfaceVisible: boolean;
  readonly surfaceInDialog: boolean;
  /** `[data-testid="message-source-json"]` elements inside the one surface. */
  readonly jsonElements: number;
  readonly json: string | null;
  /** Open message-action sheets. */
  readonly sheets: number;
  readonly box: Box | null;
  readonly conversation: Box | null;
  readonly centerInside: boolean;
  readonly paint: SurfacePaintObservation | null;
}

function parseBox(value: unknown, name: string): Box | null {
  if (value === null) return null;
  const box = object(value, name);
  const read = (field: string): number => {
    const candidate = box[field];
    assert(typeof candidate === 'number', `${name} ${field} is a number`);
    return candidate;
  };
  return {
    left: read('left'),
    top: read('top'),
    right: read('right'),
    bottom: read('bottom'),
    width: read('width'),
    height: read('height'),
  };
}

function parsePaint(value: unknown): SurfacePaintObservation | null {
  if (value === null) return null;
  const paint = object(value, 'Surface paint');
  return {
    backgroundColor: stringField(paint, 'backgroundColor'),
    borderTopWidth: stringField(paint, 'borderTopWidth'),
    borderTopStyle: stringField(paint, 'borderTopStyle'),
    boxShadow: stringField(paint, 'boxShadow'),
  };
}

export function parseSourceDialog(value: unknown): SourceDialogObservation {
  const dialog = object(value, 'Source dialog observation');
  return {
    dialogs: countField(dialog, 'dialogs'),
    surfaces: countField(dialog, 'surfaces'),
    surfaceVisible: booleanField(dialog, 'surfaceVisible'),
    surfaceInDialog: booleanField(dialog, 'surfaceInDialog'),
    jsonElements: countField(dialog, 'jsonElements'),
    json: nullableStringField(dialog, 'json'),
    sheets: countField(dialog, 'sheets'),
    box: parseBox(dialog['box'], 'Surface box'),
    conversation: parseBox(dialog['conversation'], 'Conversation box'),
    centerInside: booleanField(dialog, 'centerInside'),
    paint: parsePaint(dialog['paint']),
  };
}

/** Line 78: exactly one visible message-source surface, inside the one named dialog. */
export function assertDialogVisible(dialog: SourceDialogObservation): void {
  assert.equal(dialog.sheets, 0, 'The message-action sheet closed for View source');
  assert.equal(dialog.dialogs, 1, 'Exactly one Message source dialog');
  assert.equal(dialog.surfaces, 1, 'Exactly one message-source surface');
  assert(dialog.surfaceInDialog, 'The surface is the Message source dialog');
  assert(dialog.surfaceVisible, 'The message-source surface is visible');
  assert.equal(dialog.jsonElements, 1, 'The surface shows exactly one JSON block');
  assert(typeof dialog.json === 'string', 'The JSON block has text');
}

/** The dialog's JSON text, parsed strictly as one object; substrings never count. */
export function parseSourceJson(dialog: SourceDialogObservation): Record<string, unknown> {
  assertDialogVisible(dialog);
  let parsed: unknown;
  try {
    parsed = JSON.parse(dialog.json!);
  } catch {
    assert.fail('The dialog JSON parses');
  }
  return object(parsed, 'The dialog JSON');
}

/**
 * Line 80: the parsed JSON is the authoritative `m.room.message` event: its
 * `event_id`, `type`, `sender` and `room_id` equal the server event's and the
 * expected values exactly.
 */
export function assertJsonEvent(
  dialog: SourceDialogObservation,
  authoritative: MatrixEvent,
  expected: SourceEventExpectation,
): Record<string, unknown> {
  const json = parseSourceJson(dialog);
  const pairs = [
    ['event_id', expected.eventId],
    ['type', SOURCE_EVENT_TYPE],
    ['sender', expected.sender],
    ['room_id', expected.roomId],
  ] as const;
  for (const [field, value] of pairs) {
    assert.equal(json[field], authoritative[field], `The dialog ${field} is the server event's`);
    assert.equal(json[field], value, `The dialog ${field} is the expected value`);
  }
  return json;
}

/**
 * Line 81: the parsed `content.body` is exactly the native body, and the
 * parsed `content` is exactly the authoritative content.
 */
export function assertJsonBody(
  dialog: SourceDialogObservation,
  authoritative: MatrixEvent,
  expected: SourceEventExpectation,
): void {
  const json = assertJsonEvent(dialog, authoritative, expected);
  const content = object(json['content'], 'The dialog content');
  assert.equal(content['body'], expected.body, 'The dialog body is the exact native text');
  assert(isDeepStrictEqual(content, authoritative['content']),
    'The dialog content is exactly the server event content');
}

// Measured paint.

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

function intersects(left: Box, right: Box): boolean {
  return left.left < right.right && left.right > right.left &&
    left.top < right.bottom && left.bottom > right.top;
}

/**
 * The measured surface is a finite, non-zero box drawn over the conversation:
 * it intersects the scroller's measured box and its centre hit-tests inside it.
 */
export function assertSurfaceOverConversation(
  dialog: SourceDialogObservation,
): { readonly box: Box; readonly paint: SurfacePaintObservation } {
  assertDialogVisible(dialog);
  const { box, conversation, paint } = dialog;
  assert(box && paint, 'The surface is measured with its computed paint');
  for (const value of [box.left, box.top, box.right, box.bottom, box.width, box.height])
    assert(Number.isFinite(value), 'The surface box is finite');
  assert(box.width > 0 && box.height > 0, 'The surface box is non-zero');
  assert(conversation, 'The conversation scroller is measured');
  assert(conversation.width > 0 && conversation.height > 0, 'The conversation box is non-zero');
  assert(intersects(box, conversation), 'The surface lies over the conversation');
  assert(dialog.centerInside, 'The surface is topmost at its centre');
  return { box, paint };
}

/** Line 100: the computed background colour is fully opaque. */
export function assertSurfaceOpaque(dialog: SourceDialogObservation): number {
  const { paint } = assertSurfaceOverConversation(dialog);
  const alpha = cssColorAlpha(paint.backgroundColor);
  assert(alpha !== null, 'The computed background colour is understood');
  assert.equal(alpha, 1, 'The computed background colour is fully opaque');
  return alpha;
}

/** Line 103: a non-zero, drawn top border. */
export function assertSurfaceBorder(dialog: SourceDialogObservation): number {
  const { paint } = assertSurfaceOverConversation(dialog);
  const width = /^(\d*\.?\d+)px$/u.exec(paint.borderTopWidth.trim());
  assert(width, 'The computed top border width is a pixel length');
  const value = Number(width[1]);
  assert(Number.isFinite(value) && value > 0, 'The computed top border is non-zero');
  assert(!['none', 'hidden'].includes(paint.borderTopStyle.trim()),
    'The computed top border is drawn');
  return value;
}

/** Split a computed `box-shadow` into its comma-separated layers, outside parentheses. */
function shadowLayers(shadow: string): readonly string[] {
  const layers: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of shadow) {
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (character === ',' && depth === 0) {
      layers.push(current.trim());
      current = '';
    } else current += character;
  }
  layers.push(current.trim());
  return layers;
}

/**
 * The layers of a computed `box-shadow` that actually paint: a colour with a
 * non-zero alpha and a non-zero offset, blur or spread. Tailwind composes its
 * ring and shadow variables into one list, so transparent zero layers are
 * normal and never count. `null` when a layer is not understood.
 */
export function visibleShadowLayers(shadow: string): number | null {
  const text = shadow.trim();
  if (text === 'none' || text === '') return 0;
  let visible = 0;
  for (const layer of shadowLayers(text)) {
    const color = /[a-z-]+\([^()]*\)|\btransparent\b/iu.exec(layer)?.[0];
    if (!color) return null;
    const alpha = cssColorAlpha(color);
    if (alpha === null) return null;
    const rest = layer.replace(color, ' ').replace(/\binset\b/u, ' ').trim();
    const lengths = rest.split(/\s+/u).map((token) => /^(-?\d*\.?\d+)px$/u.exec(token));
    if (lengths.length < 2 || lengths.length > 4 || lengths.some((length) => !length))
      return null;
    const values = lengths.map((length) => Number(length![1]));
    if (alpha > 0 && values.some((value) => value !== 0)) visible++;
  }
  return visible;
}

/** Line 104: a computed shadow that is not `none` and paints at least one layer. */
export function assertSurfaceShadow(dialog: SourceDialogObservation): number {
  const { paint } = assertSurfaceOverConversation(dialog);
  const shadow = paint.boxShadow.trim();
  assert(shadow.length > 0 && shadow !== 'none', 'The computed box shadow is not none');
  const visible = visibleShadowLayers(shadow);
  assert(visible !== null, 'The computed box shadow is understood');
  assert(visible > 0, 'The computed box shadow paints at least one layer');
  return visible;
}
