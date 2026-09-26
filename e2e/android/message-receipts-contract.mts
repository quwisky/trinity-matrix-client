import assert from 'node:assert/strict';

export const MESSAGE_RECEIPTS_SOURCE =
  'e2e/browser/journeys/conversations/message-receipts.spec.mts';
/** The predecessor as the issue pins it; this branch carries it unchanged. */
export const MESSAGE_RECEIPTS_SOURCE_SHA256 =
  '5d4d757364c6b5b1a5a0e148c8c17adf173296bb2f435730d2803ed7854baa42';
export const MESSAGE_RECEIPTS_SOURCE_LINES = 166;

export const MESSAGE_RECEIPTS_SHARED_SOURCE_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
} as const;

export const MESSAGE_RECEIPTS_STAGE_IDS = ['seen-by'] as const;

export type MessageReceiptsStageId = (typeof MESSAGE_RECEIPTS_STAGE_IDS)[number];

export interface MessageReceiptsSpan {
  readonly from: number;
  readonly to: number;
}

/** Owned predecessor spans: the definition and its two module-local helpers. */
export const MESSAGE_RECEIPTS_SPANS = {
  apiToken: { from: 19, to: 38 },
  openRoom: { from: 40, to: 48 },
  definitions: {
    'seen-by': { from: 53, to: 165 },
  },
} as const satisfies {
  readonly apiToken: MessageReceiptsSpan;
  readonly openRoom: MessageReceiptsSpan;
  readonly definitions: Readonly<Record<MessageReceiptsStageId, MessageReceiptsSpan>>;
};

/**
 * Helpers whose own `expect` lines an inherited site expands. `openRoom` is the
 * predecessor's module-local helper; `apiToken`, `registerUser` and `login`
 * reach no `expect` site.
 */
export const MESSAGE_RECEIPTS_HELPERS = {
  openRoom: {
    module: MESSAGE_RECEIPTS_SOURCE,
    expectLines: [45],
    role: 'room-readiness',
  },
} as const satisfies Readonly<Record<string, {
  readonly module: string;
  readonly expectLines: readonly number[];
  readonly role: string;
}>>;

export type MessageReceiptsHelper = keyof typeof MESSAGE_RECEIPTS_HELPERS;

/**
 * One source-mapped parity site. `line` is the `expect` line. An inherited
 * site's `helper` owns that line and `call` is the definition-body call line.
 */
export type MessageReceiptsSite =
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'direct';
    }
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'inherited';
      readonly helper: MessageReceiptsHelper;
      readonly call: number;
    };

const seenBySites = [
  { line: 45, suffix: 'room-ready', kind: 'inherited', helper: 'openRoom', call: 118 },
  { line: 122, suffix: 'cluster-visible', kind: 'direct' },
  { line: 123, suffix: 'seer-named', kind: 'direct' },
  { line: 164, suffix: 'text-clear', kind: 'direct' },
] as const satisfies readonly MessageReceiptsSite[];

export type MessageReceiptsAssertion = `message-receipts.${MessageReceiptsStageId}.${string}`;

export interface MessageReceiptsStage {
  readonly id: MessageReceiptsStageId;
  readonly source: string;
  readonly title: string;
  readonly sites: readonly MessageReceiptsSite[];
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly MessageReceiptsAssertion[];
}

function stage(
  id: MessageReceiptsStageId,
  title: string,
  sites: readonly MessageReceiptsSite[],
): MessageReceiptsStage {
  const span = MESSAGE_RECEIPTS_SPANS.definitions[id];
  return {
    id,
    source: `${MESSAGE_RECEIPTS_SOURCE}:${span.from}-${span.to}`,
    title,
    sites,
    expectedAssertionRecords: sites.length,
    assertions: sites.map(
      ({ suffix }): MessageReceiptsAssertion => `message-receipts.${id}.${suffix}`,
    ),
  };
}

export const MESSAGE_RECEIPTS_STAGES: readonly MessageReceiptsStage[] = [
  stage('seen-by', "shows a reader's avatar on the message they read", seenBySites),
];

export const MESSAGE_RECEIPTS_ASSERTION_RECORDS = 4;
export const MESSAGE_RECEIPTS_DIRECT = 3;
export const MESSAGE_RECEIPTS_INHERITED = 1;

/** Direct sites order by line; a helper call runs before a later-line matcher. */
export function siteOrderKey(site: MessageReceiptsSite): readonly [number, number] {
  return site.kind === 'direct' ? [site.line, 1] : [site.call, 0];
}

function after(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] !== right[0] ? left[0] > right[0] : left[1] > right[1];
}

function within(line: number, span: MessageReceiptsSpan): boolean {
  return Number.isInteger(line) && line >= span.from && line <= span.to;
}

function validateContract(): void {
  assert.deepEqual(MESSAGE_RECEIPTS_STAGES.map(({ id }) => id),
    [...MESSAGE_RECEIPTS_STAGE_IDS], 'Message-receipts stages keep source order');
  const sites = MESSAGE_RECEIPTS_STAGES.flatMap((entry) => entry.sites);
  const identities = MESSAGE_RECEIPTS_STAGES.flatMap((entry) => entry.assertions);
  assert.equal(sites.length, MESSAGE_RECEIPTS_ASSERTION_RECORDS,
    'Message-receipts owns exactly 4 records');
  assert.equal(sites.filter((site) => site.kind === 'direct').length,
    MESSAGE_RECEIPTS_DIRECT, 'Message-receipts owns exactly 3 direct sites');
  assert.equal(sites.filter((site) => site.kind === 'inherited').length,
    MESSAGE_RECEIPTS_INHERITED, 'Message-receipts owns exactly 1 inherited site');
  assert.equal(new Set(identities).size, MESSAGE_RECEIPTS_ASSERTION_RECORDS,
    'Message-receipts identities are unique');
  for (const entry of MESSAGE_RECEIPTS_STAGES) {
    const span = MESSAGE_RECEIPTS_SPANS.definitions[entry.id];
    assert.equal(entry.expectedAssertionRecords, entry.sites.length,
      `${entry.id} expected records equal its sites`);
    for (const identity of entry.assertions) {
      assert.match(identity, new RegExp(
        `^message-receipts\\.${entry.id}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`),
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
      const lines: readonly number[] = MESSAGE_RECEIPTS_HELPERS[site.helper].expectLines;
      assert(lines.includes(site.line),
        `${entry.id}.${site.suffix} expands one of ${site.helper}'s expect lines`);
      assert(within(site.call, span),
        `${entry.id}.${site.suffix} call lies inside its definition`);
    }
  }
  assert(within(MESSAGE_RECEIPTS_HELPERS.openRoom.expectLines[0], MESSAGE_RECEIPTS_SPANS.openRoom),
    'The Room-readiness site lies inside the local openRoom helper');
}

validateContract();

function entryFor(stageId: MessageReceiptsStageId): MessageReceiptsStage {
  const entry = MESSAGE_RECEIPTS_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown message-receipts stage ${stageId}`);
  return entry;
}

export function messageReceiptsStage(stageId: MessageReceiptsStageId): MessageReceiptsStage {
  return entryFor(stageId);
}

export function messageReceiptsAssertion(
  stageId: MessageReceiptsStageId,
  suffix: string,
): MessageReceiptsAssertion {
  const entry = entryFor(stageId);
  const identity: MessageReceiptsAssertion = `message-receipts.${stageId}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertMessageReceiptsRecords(
  stageId: MessageReceiptsStageId,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stageId).assertions,
    `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for parity identities. */
export function assertMessageReceiptsReceiptName(name: string): void {
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `Receipt name ${name} is kebab-case`);
  assert(!name.startsWith('message-receipts'), `Receipt ${name} is not a parity identity`);
}

// Predecessor fields: the run suffix (57), the three roles (60–75), the seer
// name (77), the Room name (83), the body (99) and the transaction (102).

export const MESSAGE_RECEIPTS_RUN_SUFFIX = 's';
/** Fixture roles, one per predecessor `rcpt-<role>-${runId}` Account. */
export const MESSAGE_RECEIPTS_ROLES = ['reader', 'author', 'seer'] as const;
export type MessageReceiptsRole = (typeof MESSAGE_RECEIPTS_ROLES)[number];
export const receiptsAccountRole = (role: MessageReceiptsRole): string => `rcpt-${role}`;

export const receiptsSeerName = (run: string): string => `Cara${run}`;
export const receiptsRoomName = (run: string): string => `Receipts E2E ${run}`;
export const receiptsBody = (run: string): string => `read receipt target ${run}`;
export const receiptsTransaction = (run: string): string => `rcpt-${run}`;
/** The product's accessible name for a receipt cluster: `seenByLabel`. */
export const SEEN_BY_PREFIX = 'Seen by ';
export const SEEN_BY_SEPARATOR = ', ';

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

/** The `profile-applied.json` payload read back from the WebView. */
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

/** Read-only composer state after the Room opens. */
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

/** Helper line 45: the composer of the exact Room is visible after native open. */
export function assertRoomReady(composer: ComposerObservation, room: RoomIdentity): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert(composer.visible, 'The composer is visible');
  assert.equal(composer.placeholder, `Message #${room.name}`,
    'The composer names the exact Room');
  assertRoomRoute(composer.href, room.roomId, room.userId);
}

// Rendered receipts.

export interface MeasuredBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface ReceiptRowObservation {
  readonly id: string;
  readonly event: boolean;
  readonly visible: boolean;
  /** Each `.msg__text` of the row, in order. */
  readonly texts: readonly string[];
  /** `[data-testid="read-receipts"]` clusters inside the row. */
  readonly clusters: number;
}

/** The first `.scroll [data-testid="read-receipts"]`, the predecessor's `receipts.first()`. */
export interface ReceiptClusterObservation {
  /** The owning `.msg` row's `data-mid`, or null when it has no row. */
  readonly rowId: string | null;
  /** Whether it is the first cluster of its own row. */
  readonly firstInRow: boolean;
  /** Whether it is also the document's first cluster, the predecessor's geometry target. */
  readonly firstInDocument: boolean;
  readonly tag: string;
  readonly visible: boolean;
  readonly label: string | null;
  readonly avatars: number;
  readonly box: MeasuredBox;
  /** The owning row's first `.msg__text` and its measured box. */
  readonly text: { readonly content: string; readonly box: MeasuredBox } | null;
}

export interface ReceiptsViewObservation {
  readonly rows: readonly ReceiptRowObservation[];
  readonly clusters: number;
  readonly first: ReceiptClusterObservation | null;
}

function parseBox(value: unknown, name: string): MeasuredBox {
  const box = object(value, name);
  const values: Record<string, number> = {};
  for (const edge of ['left', 'top', 'right', 'bottom', 'width', 'height']) {
    const candidate = box[edge];
    assert(typeof candidate === 'number', `${name} ${edge} is a number`);
    values[edge] = candidate;
  }
  return values as unknown as MeasuredBox;
}

/** Reject incomplete CDP values before any source-mapped assertion is recorded. */
export function parseReceiptsView(value: unknown): ReceiptsViewObservation {
  const view = object(value, 'Receipts observation');
  const rows = arrayField(view, 'rows').map((raw, index): ReceiptRowObservation => {
    const row = object(raw, `Timeline row ${index}`);
    return {
      id: stringField(row, 'id'),
      event: booleanField(row, 'event'),
      visible: booleanField(row, 'visible'),
      texts: stringArrayField(row, 'texts'),
      clusters: countField(row, 'clusters'),
    };
  });
  const rawFirst = view['first'];
  let first: ReceiptClusterObservation | null = null;
  if (rawFirst !== null) {
    const cluster = object(rawFirst, 'First receipt cluster');
    const rawText = cluster['text'];
    let text: ReceiptClusterObservation['text'] = null;
    if (rawText !== null) {
      const parsed = object(rawText, 'Cluster message text');
      text = {
        content: stringField(parsed, 'content'),
        box: parseBox(parsed['box'], 'Message text box'),
      };
    }
    first = {
      rowId: nullableStringField(cluster, 'rowId'),
      firstInRow: booleanField(cluster, 'firstInRow'),
      firstInDocument: booleanField(cluster, 'firstInDocument'),
      tag: stringField(cluster, 'tag'),
      visible: booleanField(cluster, 'visible'),
      label: nullableStringField(cluster, 'label'),
      avatars: countField(cluster, 'avatars'),
      box: parseBox(cluster['box'], 'Receipt cluster box'),
      text,
    };
  }
  return { rows, clusters: countField(view, 'clusters'), first };
}

/**
 * The exact message row, read-only: exactly one message row's `.msg__text`
 * carries the body, it is reconciled and its id is the proved event.
 */
export function assertMessageRow(
  view: ReceiptsViewObservation,
  body: string,
  eventId: string,
): ReceiptRowObservation {
  const rows = view.rows.filter((row) =>
    !row.event && row.texts.some((text) => text.includes(body)));
  assert.equal(rows.length, 1, 'Exactly one Room row carries the message body');
  const row = rows[0]!;
  assert(row.id.startsWith('$'), 'The message row carries the homeserver event id');
  assert.equal(row.id, eventId, 'The message row is the proved author event');
  assert(row.visible, 'The message row is visible');
  return row;
}

/**
 * Line 122: the Room's first read-receipt cluster is visible, and it belongs to
 * the exact message row as that row's first cluster. A visible avatar elsewhere
 * in the Room is never accepted.
 */
export function assertClusterVisible(
  view: ReceiptsViewObservation,
  body: string,
  eventId: string,
): ReceiptClusterObservation {
  const row = assertMessageRow(view, body, eventId);
  const cluster = view.first;
  assert(cluster, 'The Room renders a read-receipt cluster');
  assert.equal(cluster.rowId, row.id, 'The first cluster belongs to the exact message row');
  assert(cluster.firstInRow, 'It is the message row\'s first cluster');
  assert(cluster.firstInDocument, 'It is also the document\'s first cluster');
  assert.equal(cluster.tag, 'BUTTON', 'The cluster is the product receipt button');
  assert(cluster.visible, 'The read-receipt cluster is visible');
  assert(cluster.avatars > 0, 'The cluster renders at least one avatar');
  return cluster;
}

/** The product's `Seen by a, b` label as its exact name list, or null. */
export function seenByNames(label: string | null): readonly string[] | null {
  if (label === null || !label.startsWith(SEEN_BY_PREFIX)) return null;
  const names = label.slice(SEEN_BY_PREFIX.length).split(SEEN_BY_SEPARATOR);
  return names.every((name) => name.length > 0) ? names : null;
}

export interface SeerNameExpectation {
  readonly seerName: string;
  /** Authoritative display names of joined non-reader members (author, seer). */
  readonly memberNames: readonly string[];
  readonly readerName: string;
}

/**
 * Line 123: the cluster's accessible name names the exact seer. Beyond the
 * predecessor's `RegExp(seerName)`, the parsed name list holds the seer exactly
 * once, lists only joined non-reader members, and has one name per avatar.
 */
export function assertSeerNamed(
  cluster: ReceiptClusterObservation,
  expected: SeerNameExpectation,
): readonly string[] {
  const label = cluster.label;
  assert(label !== null, 'The cluster has an accessible label');
  assert(label.includes(expected.seerName), 'The accessible label contains the seer name');
  const names = seenByNames(label);
  assert(names, 'The accessible label has the product Seen by form');
  assert.equal(names.filter((name) => name === expected.seerName).length, 1,
    'The label names the exact seer exactly once');
  assert(!names.includes(expected.readerName), 'The label never names the reader');
  for (const name of names)
    assert(expected.memberNames.includes(name),
      'Every listed name is a joined non-reader member of the Room');
  assert.equal(new Set(names).size, names.length, 'No member is listed twice');
  assert.equal(names.length, cluster.avatars, 'The label lists one name per avatar');
  return names;
}

export interface Separation {
  readonly intersects: boolean;
  readonly separatedBy: readonly ('above' | 'below' | 'left' | 'right')[];
}

function assertMeasured(box: MeasuredBox, name: string): void {
  for (const value of Object.values(box))
    assert(Number.isFinite(value), `${name} is a finite measured box`);
  assert(box.width > 0 && box.height > 0, `${name} has a non-zero measured size`);
  assert(Math.abs(box.right - box.left - box.width) < 0.01 &&
    Math.abs(box.bottom - box.top - box.height) < 0.01,
  `${name} edges agree with its size`);
}

/** The predecessor's four-edge intersection, recomputed from measured numbers. */
export function separation(cluster: MeasuredBox, text: MeasuredBox): Separation {
  const intersects =
    cluster.left < text.right &&
    cluster.right > text.left &&
    cluster.top < text.bottom &&
    cluster.bottom > text.top;
  const separatedBy: Separation['separatedBy'][number][] = [];
  if (cluster.bottom <= text.top) separatedBy.push('above');
  if (cluster.top >= text.bottom) separatedBy.push('below');
  if (cluster.right <= text.left) separatedBy.push('left');
  if (cluster.left >= text.right) separatedBy.push('right');
  return { intersects, separatedBy };
}

/**
 * Line 164: the measured cluster box does not intersect the measured text box
 * of the message it belongs to.
 */
export function assertTextClear(
  cluster: ReceiptClusterObservation,
  body: string,
  eventId: string,
): Separation {
  assert.equal(cluster.rowId, eventId, 'The measured cluster belongs to the exact row');
  assert(cluster.firstInDocument, 'The measured cluster is the document\'s first cluster');
  assert(cluster.text, 'The cluster\'s row renders its message text');
  assert(cluster.text.content.includes(body), 'The measured text is the exact message');
  assertMeasured(cluster.box, 'The cluster');
  assertMeasured(cluster.text.box, 'The message text');
  const result = separation(cluster.box, cluster.text.box);
  assert.equal(result.intersects, false, 'The receipt cluster does not cover the message text');
  return result;
}

// Authoritative Matrix state.

type MatrixEvent = Readonly<Record<string, unknown>>;

/** Every event in one `/messages?dir=b&limit=50` page, oldest first. */
export function authoritativeTimeline(response: unknown): readonly MatrixEvent[] {
  const page = object(response, 'Room messages page');
  return arrayField(page, 'chunk')
    .map((event, index) => object(event, `Room messages event ${index}`))
    .reverse();
}

export interface ReceiptRoomExpectation {
  readonly roomId: string;
  readonly readerId: string;
  readonly authorId: string;
  readonly seerId: string;
  readonly seerName: string;
  readonly body: string;
  readonly eventId: string;
}

function content(event: MatrixEvent): Record<string, unknown> {
  return object(event['content'], 'Event content');
}

function memberEvents(events: readonly MatrixEvent[], userId: string): readonly MatrixEvent[] {
  return events.filter((event) =>
    event['type'] === 'm.room.member' && event['state_key'] === userId);
}

function joinIndex(events: readonly MatrixEvent[], userId: string): number {
  const joins = events.flatMap((event, index) =>
    event['type'] === 'm.room.member' && event['state_key'] === userId &&
      content(event)['membership'] === 'join' ? [index] : []);
  assert.equal(joins.length, 1, 'Each Room member joined exactly once');
  return joins[0]!;
}

/**
 * The Room timeline holds exactly the author's one original message, and the
 * seer's name was set before any seer membership activity: every seer member
 * event that names the seer carries the exact name, the seer was invited by
 * the reader and joined exactly once, carrying it.
 */
export function assertReceiptRoom(
  events: readonly MatrixEvent[],
  expected: ReceiptRoomExpectation,
): { readonly authorName: string; readonly readerName: string } {
  for (const event of events)
    assert(event['room_id'] === undefined || event['room_id'] === expected.roomId,
      'Every event belongs to the exact Room');
  const messages = events.filter((event) => event['type'] === 'm.room.message');
  assert.equal(messages.length, 1, 'The Room holds exactly one message');
  const message = messages[0]!;
  assert.equal(message['event_id'], expected.eventId, 'The message is the proved author event');
  assert(typeof expected.eventId === 'string' && expected.eventId.startsWith('$'),
    'The message has a real Matrix event id');
  assert.equal(message['sender'], expected.authorId, 'The message is from the author');
  const body = content(message);
  assert.equal(body['msgtype'], 'm.text', 'The message is text');
  assert.equal(body['body'], expected.body, 'The message body is exact');
  assert(!('m.relates_to' in body) && !('m.new_content' in body),
    'The message is an original with no relation');
  const members = events.filter((event) => event['type'] === 'm.room.member');
  const known = new Set([expected.readerId, expected.authorId, expected.seerId]);
  for (const member of members)
    assert(known.has(member['state_key'] as string), 'The Room holds only the three Accounts');
  const seer = memberEvents(events, expected.seerId);
  const invite = seer.filter((event) => content(event)['membership'] === 'invite');
  assert.equal(invite.length, 1, 'The reader invited the seer exactly once');
  assert.equal(invite[0]!['sender'], expected.readerId, 'The seer invite is from the reader');
  for (const event of seer) {
    const name = content(event)['displayname'];
    assert(name === undefined || name === expected.seerName,
      'Every seer member event carries only the exact seer name');
  }
  const seerJoin = joinIndex(events, expected.seerId);
  assert.equal(content(events[seerJoin]!)['displayname'], expected.seerName,
    'The seer joined with the exact display name set before membership');
  assert(events.indexOf(invite[0]!) < seerJoin, 'The seer was invited before joining');
  const authorJoin = joinIndex(events, expected.authorId);
  const readerJoin = joinIndex(events, expected.readerId);
  const messageIndex = events.indexOf(message);
  assert(messageIndex > seerJoin && messageIndex > authorJoin && messageIndex > readerJoin,
    'The message follows every join');
  const name = (index: number): string => {
    const value = content(events[index]!)['displayname'];
    assert(typeof value === 'string' && value.length > 0, 'Each join carries a display name');
    return value;
  };
  return { authorName: name(authorJoin), readerName: name(readerJoin) };
}

/** Current `m.room.member` membership of reader, author and seer. */
export function assertJoined(
  memberships: Readonly<Record<'reader' | 'author' | 'seer', string | undefined>>,
): void {
  for (const role of ['reader', 'author', 'seer'] as const)
    assert.equal(memberships[role], 'join', `The ${role} is joined`);
}

export interface ReadReceipt {
  readonly eventId: string;
  readonly userId: string;
  readonly ts: unknown;
  readonly threadId: unknown;
}

/** Every `m.read` entry in the Room's `m.receipt` ephemeral events. */
export function authoritativeReadReceipts(events: unknown): readonly ReadReceipt[] {
  assert(Array.isArray(events), 'Receipt events are an array');
  const receipts: ReadReceipt[] = [];
  for (const [index, raw] of events.entries()) {
    const event = object(raw, `Ephemeral event ${index}`);
    if (event['type'] !== 'm.receipt') continue;
    for (const [eventId, rawTypes] of Object.entries(content(event))) {
      const types = object(rawTypes, 'Receipt types');
      const read = types['m.read'];
      if (read === undefined) continue;
      for (const [userId, rawReceipt] of Object.entries(object(read, 'Read receipts'))) {
        const receipt = object(rawReceipt, 'Read receipt');
        receipts.push({ eventId, userId, ts: receipt['ts'], threadId: receipt['thread_id'] });
      }
    }
  }
  return receipts;
}

/**
 * The seer's real, unthreaded `m.read` receipt points at exactly the author's
 * event, and the seer holds no `m.read` receipt anywhere else.
 */
export function assertSeerReceipt(
  receipts: readonly ReadReceipt[],
  expected: { readonly seerId: string; readonly eventId: string },
): ReadReceipt {
  const seer = receipts.filter((receipt) => receipt.userId === expected.seerId);
  assert.equal(seer.length, 1, 'The seer holds exactly one read receipt');
  const receipt = seer[0]!;
  assert.equal(receipt.eventId, expected.eventId, 'The seer read up to exactly the author event');
  assert(typeof receipt.ts === 'number' && Number.isFinite(receipt.ts) && receipt.ts > 0,
    'The receipt carries a server timestamp');
  assert.equal(receipt.threadId, undefined, 'The receipt is unthreaded');
  return receipt;
}
