import assert from 'node:assert/strict';

export const MESSAGE_POLL_SOURCE =
  'e2e/browser/journeys/conversations/message-poll.spec.mts';
export const MESSAGE_POLL_SOURCE_SHA256 =
  'e23c045d237ba9fde15eb5a39d24479dfc2019e07579142c9193a8dc05ea1674';
export const MESSAGE_POLL_SOURCE_LINES = 93;

export const MESSAGE_POLL_SHARED_SOURCE_SHA256 = {
  'e2e/support/app.mts':
    '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts':
    'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
} as const;

export const MESSAGE_POLL_STAGE_IDS = ['create-vote-end'] as const;

export type MessagePollStageId = (typeof MESSAGE_POLL_STAGE_IDS)[number];

export interface MessagePollSpan {
  readonly from: number;
  readonly to: number;
}

/** Owned predecessor spans: the local Room-opening helper and the one definition. */
export const MESSAGE_POLL_SPANS = {
  openRoom: { from: 14, to: 22 },
  definitions: {
    'create-vote-end': { from: 27, to: 92 },
  },
} as const satisfies {
  readonly openRoom: MessagePollSpan;
  readonly definitions: Readonly<Record<MessagePollStageId, MessagePollSpan>>;
};

/**
 * Helpers whose own `expect` lines an inherited site expands. `openRoom` is the
 * predecessor's module-local helper; `waitForSent` is the shared app helper.
 */
export const MESSAGE_POLL_HELPERS = {
  openRoom: {
    module: MESSAGE_POLL_SOURCE,
    expectLines: [19],
    role: 'room-readiness',
  },
  waitForSent: {
    module: 'e2e/support/app.mts',
    expectLines: [178],
    role: 'real-server-echo',
  },
} as const satisfies Readonly<Record<string, {
  readonly module: string;
  readonly expectLines: readonly number[];
  readonly role: string;
}>>;

export type MessagePollHelper = keyof typeof MESSAGE_POLL_HELPERS;

/**
 * One source-mapped parity site. `line` is the `expect` line. An inherited
 * site's `helper` owns that line and `call` is the definition-body call line.
 */
export type MessagePollSite =
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'direct';
    }
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'inherited';
      readonly helper: MessagePollHelper;
      readonly call: number;
    };

const createVoteEndSites = [
  { line: 19, suffix: 'room-ready', kind: 'inherited', helper: 'openRoom', call: 54 },
  { line: 59, suffix: 'insert-tray', kind: 'direct' },
  { line: 60, suffix: 'no-inline-poll', kind: 'direct' },
  { line: 73, suffix: 'poll-visible', kind: 'direct' },
  { line: 74, suffix: 'poll-question', kind: 'direct' },
  { line: 75, suffix: 'zero-votes', kind: 'direct' },
  { line: 178, suffix: 'server-echo', kind: 'inherited', helper: 'waitForSent', call: 80 },
  { line: 86, suffix: 'one-vote', kind: 'direct' },
  { line: 87, suffix: 'one-hundred-percent', kind: 'direct' },
  { line: 91, suffix: 'final-results', kind: 'direct' },
] as const satisfies readonly MessagePollSite[];

export type MessagePollAssertion = `message-poll.${MessagePollStageId}.${string}`;

export interface MessagePollStage {
  readonly id: MessagePollStageId;
  readonly source: string;
  readonly title: string;
  readonly sites: readonly MessagePollSite[];
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly MessagePollAssertion[];
}

function stage(
  id: MessagePollStageId,
  title: string,
  sites: readonly MessagePollSite[],
): MessagePollStage {
  const span = MESSAGE_POLL_SPANS.definitions[id];
  return {
    id,
    source: `${MESSAGE_POLL_SOURCE}:${span.from}-${span.to}`,
    title,
    sites,
    expectedAssertionRecords: sites.length,
    assertions: sites.map(
      ({ suffix }): MessagePollAssertion => `message-poll.${id}.${suffix}`,
    ),
  };
}

export const MESSAGE_POLL_STAGES: readonly MessagePollStage[] = [
  stage('create-vote-end', 'creates a poll, votes, and ends it', createVoteEndSites),
];

export const MESSAGE_POLL_ASSERTION_RECORDS = 10;
export const MESSAGE_POLL_DIRECT = 8;
export const MESSAGE_POLL_INHERITED = 2;
/** One Room readiness and one real-server echo. */
export const MESSAGE_POLL_HELPER_COUNTS = {
  openRoom: 1,
  waitForSent: 1,
} as const satisfies Readonly<Record<MessagePollHelper, number>>;

/** Direct sites order by line; a helper call runs before a later-line matcher. */
export function siteOrderKey(site: MessagePollSite): readonly [number, number] {
  return site.kind === 'direct' ? [site.line, 1] : [site.call, 0];
}

function after(
  left: readonly [number, number],
  right: readonly [number, number],
): boolean {
  return left[0] !== right[0] ? left[0] > right[0] : left[1] > right[1];
}

function within(line: number, span: MessagePollSpan): boolean {
  return Number.isInteger(line) && line >= span.from && line <= span.to;
}

function validateContract(): void {
  assert.deepEqual(MESSAGE_POLL_STAGES.map(({ id }) => id),
    [...MESSAGE_POLL_STAGE_IDS], 'Message-poll stages keep source order');
  const sites = MESSAGE_POLL_STAGES.flatMap((entry) => entry.sites);
  const identities = MESSAGE_POLL_STAGES.flatMap((entry) => entry.assertions);
  assert.equal(sites.length, MESSAGE_POLL_ASSERTION_RECORDS,
    'Message-poll owns exactly 10 records');
  assert.equal(sites.filter((site) => site.kind === 'direct').length,
    MESSAGE_POLL_DIRECT, 'Message-poll owns exactly 8 direct sites');
  assert.equal(sites.filter((site) => site.kind === 'inherited').length,
    MESSAGE_POLL_INHERITED, 'Message-poll owns exactly 2 inherited sites');
  assert.equal(new Set(identities).size, MESSAGE_POLL_ASSERTION_RECORDS,
    'Message-poll identities are unique');
  for (const [helper, expected] of Object.entries(MESSAGE_POLL_HELPER_COUNTS)) {
    assert.equal(sites.filter((site) =>
      site.kind === 'inherited' && site.helper === helper).length, expected,
    `${helper} expands exactly ${expected} time`);
  }
  for (const entry of MESSAGE_POLL_STAGES) {
    const span = MESSAGE_POLL_SPANS.definitions[entry.id];
    assert.equal(entry.expectedAssertionRecords, entry.sites.length,
      `${entry.id} expected records equal its sites`);
    for (const identity of entry.assertions) {
      assert.match(identity, new RegExp(
        `^message-poll\\.${entry.id}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`),
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
      const lines: readonly number[] = MESSAGE_POLL_HELPERS[site.helper].expectLines;
      assert(lines.includes(site.line),
        `${entry.id}.${site.suffix} expands one of ${site.helper}'s expect lines`);
      assert(within(site.call, span),
        `${entry.id}.${site.suffix} call lies inside its definition`);
    }
  }
  assert(within(MESSAGE_POLL_HELPERS.openRoom.expectLines[0], MESSAGE_POLL_SPANS.openRoom),
    'The Room-readiness site lies inside the local openRoom helper');
}

validateContract();

function entryFor(stageId: MessagePollStageId): MessagePollStage {
  const entry = MESSAGE_POLL_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown message-poll stage ${stageId}`);
  return entry;
}

export function messagePollStage(stageId: MessagePollStageId): MessagePollStage {
  return entryFor(stageId);
}

export function messagePollAssertion(
  stageId: MessagePollStageId,
  suffix: string,
): MessagePollAssertion {
  const entry = entryFor(stageId);
  const identity: MessagePollAssertion = `message-poll.${stageId}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertMessagePollRecords(
  stageId: MessagePollStageId,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stageId).assertions,
    `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for parity identities. */
export function assertMessagePollReceiptName(name: string): void {
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, `Receipt name ${name} is kebab-case`);
  assert(!name.startsWith('message-poll'), `Receipt ${name} is not a parity identity`);
}

// Predecessor poll fields: run suffix (28), Room name (42), question (65), options (67–68).

export const MESSAGE_POLL_RUN_SUFFIX = 'p';
export const messagePollRoomName = (run: string): string => `Poll E2E ${run}`;
export const messagePollQuestion = (run: string): string => `Best fruit ${run}?`;
export const MESSAGE_POLL_OPTIONS = ['Apple', 'Pear'] as const;
/** `pollStartContent` numbers answers in option order. */
export const MESSAGE_POLL_ANSWER_IDS = ['a0', 'a1'] as const;
export const MESSAGE_POLL_VOTE_ANSWER = 'a0';
export const MESSAGE_POLL_KIND = 'm.poll.disclosed';
export const POLL_START_TYPE = 'm.poll.start';
export const POLL_RESPONSE_TYPE = 'm.poll.response';
export const POLL_END_TYPE = 'm.poll.end';
/** Every namespace the renderer accepts; any of them counts toward the exact chain. */
export const POLL_EVENT_TYPES = [
  POLL_START_TYPE,
  'org.matrix.msc3381.poll.start',
  POLL_RESPONSE_TYPE,
  'org.matrix.msc3381.poll.response',
  POLL_END_TYPE,
  'org.matrix.msc3381.poll.end',
] as const;
/**
 * Typed before each field value, then removed by the focused fill. Every poll
 * value starts with a capital, so capitalization is not at stake; the sentinel
 * must only stay out of the first word. Gboard joins a letter or digit to it
 * and recases the word on the next space (`1Best fruit` became `1best fruit`,
 * `xBest` became `Xbest`), while an opening parenthesis separates it and
 * `Best`, `Apple` and `Pear` stay exact.
 */
export const FIELD_SENTINEL = '(';

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

// Composer and its insert tray.

/** Read-only composer, insert-trigger and Poll-control state. */
export interface ComposerObservation {
  readonly count: number;
  readonly visible: boolean;
  readonly placeholder: string | null;
  readonly href: string;
  readonly insertCount: number;
  readonly insertVisible: boolean;
  readonly insertDisabled: boolean | null;
  readonly insertHasPopup: string | null;
  readonly insertExpanded: string | null;
  readonly inlinePollCount: number;
  readonly trayPollCount: number;
}

export function parseComposer(value: unknown): ComposerObservation {
  const composer = object(value, 'Composer observation');
  return {
    count: countField(composer, 'count'),
    visible: booleanField(composer, 'visible'),
    placeholder: nullableStringField(composer, 'placeholder'),
    href: stringField(composer, 'href'),
    insertCount: countField(composer, 'insertCount'),
    insertVisible: booleanField(composer, 'insertVisible'),
    insertDisabled: nullableBooleanField(composer, 'insertDisabled'),
    insertHasPopup: nullableStringField(composer, 'insertHasPopup'),
    insertExpanded: nullableStringField(composer, 'insertExpanded'),
    inlinePollCount: countField(composer, 'inlinePollCount'),
    trayPollCount: countField(composer, 'trayPollCount'),
  };
}

export interface RoomIdentity {
  readonly name: string;
  readonly roomId: string;
  readonly userId: string;
}

/** Helper line 19: the composer of the exact Room is visible after native open. */
export function assertRoomReady(composer: ComposerObservation, room: RoomIdentity): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert(composer.visible, 'The composer is visible');
  assert.equal(composer.placeholder, `Message #${room.name}`,
    'The composer names the exact Room');
  assertRoomRoute(composer.href, room.roomId, room.userId);
}

/** Line 59: the phone composer's one `+` is the enabled mobile tray trigger. */
export function assertInsertTray(composer: ComposerObservation): void {
  assert.equal(composer.insertCount, 1, 'Exactly one composer insert trigger');
  assert(composer.insertVisible, 'The composer insert trigger is visible');
  assert.equal(composer.insertDisabled, false, 'The composer insert trigger is enabled');
  assert.equal(composer.insertHasPopup, 'dialog',
    'The insert trigger opens the mobile tray sheet');
  assert.equal(composer.insertExpanded, 'false', 'The tray starts closed');
}

/** Line 60: no obsolete inline Poll control; Poll lives only inside the tray. */
export function assertNoInlinePoll(composer: ComposerObservation): void {
  assert.equal(composer.inlinePollCount, 0, 'No inline composer-poll control');
  assert.equal(composer.trayPollCount, 0, 'The Poll action exists only in the open tray');
}

// Create poll dialog.

export interface PollDialogObservation {
  readonly count: number;
  readonly visible: boolean;
  readonly questionCount: number;
  readonly questionValue: string | null;
  readonly questionFocused: boolean;
  readonly options: readonly string[];
  readonly createCount: number;
  readonly createDisabled: boolean | null;
}

export function parsePollDialog(value: unknown): PollDialogObservation {
  const dialog = object(value, 'Poll dialog observation');
  const options = arrayField(dialog, 'options');
  assert(options.every((item) => typeof item === 'string'), 'Poll options are strings');
  return {
    count: countField(dialog, 'count'),
    visible: booleanField(dialog, 'visible'),
    questionCount: countField(dialog, 'questionCount'),
    questionValue: nullableStringField(dialog, 'questionValue'),
    questionFocused: booleanField(dialog, 'questionFocused'),
    options: options as string[],
    createCount: countField(dialog, 'createCount'),
    createDisabled: nullableBooleanField(dialog, 'createDisabled'),
  };
}

/** The Create poll dialog opened from the tray with its question autofocused. */
export function assertPollDialogOpen(dialog: PollDialogObservation): void {
  assert.equal(dialog.count, 1, 'Exactly one Create poll dialog');
  assert(dialog.visible, 'The Create poll dialog is visible');
  assert.equal(dialog.questionCount, 1, 'Exactly one question field');
  assert(dialog.questionFocused, 'The product autofocused the question');
  assert.equal(dialog.questionValue, '', 'The question starts empty');
  assert.deepEqual(dialog.options, ['', ''], 'Two empty option fields');
}

/** Every native value arrived exactly, and Create is enabled for it. */
export function assertPollDraft(dialog: PollDialogObservation, question: string): void {
  assert.equal(dialog.count, 1, 'Exactly one Create poll dialog');
  assert.equal(dialog.questionValue, question, 'The question is the exact native text');
  assert.deepEqual(dialog.options, [...MESSAGE_POLL_OPTIONS],
    'The options are exactly Apple and Pear');
  assert.equal(dialog.createCount, 1, 'Exactly one Create control');
  assert.equal(dialog.createDisabled, false, 'Create is enabled for the exact draft');
}

// Rendered polls.

export interface PollOptionObservation {
  readonly text: string;
  readonly count: string;
  readonly disabled: boolean;
  readonly pressed: string | null;
}

export interface PollObservation {
  readonly rowId: string;
  readonly visible: boolean;
  readonly question: string;
  readonly total: string;
  readonly text: string;
  readonly endCount: number;
  readonly endDisabled: boolean | null;
  readonly options: readonly PollOptionObservation[];
}

export interface TimelineObservation {
  readonly pollCount: number;
  readonly polls: readonly PollObservation[];
}

/** Reject incomplete CDP values before any source-mapped assertion is recorded. */
export function parseTimeline(value: unknown): TimelineObservation {
  const timeline = object(value, 'Timeline observation');
  return {
    pollCount: countField(timeline, 'pollCount'),
    polls: arrayField(timeline, 'polls').map((raw, index): PollObservation => {
      const poll = object(raw, `Poll ${index}`);
      return {
        rowId: stringField(poll, 'rowId'),
        visible: booleanField(poll, 'visible'),
        question: stringField(poll, 'question'),
        total: stringField(poll, 'total'),
        text: stringField(poll, 'text'),
        endCount: countField(poll, 'endCount'),
        endDisabled: nullableBooleanField(poll, 'endDisabled'),
        options: arrayField(poll, 'options').map((option, optionIndex) => {
          const item = object(option, `Poll ${index} option ${optionIndex}`);
          return {
            text: stringField(item, 'text'),
            count: stringField(item, 'count'),
            disabled: booleanField(item, 'disabled'),
            pressed: nullableStringField(item, 'pressed'),
          };
        }),
      };
    }),
  };
}

/** Line 73: exactly one poll renders in the timeline, and it is visible. */
export function assertPollVisible(timeline: TimelineObservation): PollObservation {
  assert.equal(timeline.pollCount, 1, 'Exactly one poll renders');
  assert.equal(timeline.polls.length, 1, 'The poll sits in one timeline row');
  assert(timeline.polls[0]!.visible, 'The poll is visible');
  return timeline.polls[0]!;
}

/** Line 74: the poll shows the exact native question with the exact answers. */
export function assertPollQuestion(poll: PollObservation, question: string): void {
  assert.equal(poll.question, question, 'The poll shows the exact question');
  assert(poll.text.includes(question), 'The poll text contains the exact question');
  assert.deepEqual(poll.options.map((option) => option.text), [...MESSAGE_POLL_OPTIONS],
    'The poll offers exactly Apple then Pear');
}

/** Line 75: nobody has voted. */
export function assertZeroVotes(poll: PollObservation): void {
  assert.equal(poll.total, '0 votes', 'The poll total reads 0 votes');
  assert.deepEqual(poll.options.map((option) => option.count), ['0 (0%)', '0 (0%)'],
    'Both options read 0 (0%)');
  assert(poll.options.every((option) => option.pressed === 'false'),
    'No option is chosen');
}

/** Helper line 178: the one poll row is the reconciled server event. */
export function assertServerEcho(timeline: TimelineObservation): PollObservation {
  const poll = assertPollVisible(timeline);
  assert(poll.rowId.startsWith('$'), 'The poll row carries the homeserver event id');
  return poll;
}

/** The server-ready poll offers an enabled Apple as its first option. */
export function assertVoteReady(poll: PollObservation): void {
  assert.equal(poll.options[0]?.text, MESSAGE_POLL_OPTIONS[0], 'Apple is the first option');
  assert(poll.options.every((option) => !option.disabled),
    'Every option is enabled once the poll is server-ready');
  assert.equal(poll.endCount, 1, 'The creator sees one End control');
  assert.equal(poll.endDisabled, false, 'The End control is enabled');
}

/** The exact poll row, identified by its reconciled event id. */
export function samePoll(timeline: TimelineObservation, pollId: string): PollObservation {
  const poll = assertPollVisible(timeline);
  assert.equal(poll.rowId, pollId, 'The observation reads the same poll row');
  return poll;
}

/** Line 86: exactly one counted vote on the same poll. */
export function assertOneVote(timeline: TimelineObservation, pollId: string): PollObservation {
  const poll = samePoll(timeline, pollId);
  assert.equal(poll.total, '1 vote', 'The poll total reads 1 vote');
  return poll;
}

/** Line 87: the vote is Apple's, the whole share, and the local choice. */
export function assertOneHundredPercent(poll: PollObservation): void {
  assert.equal(poll.options[0]?.count, '1 (100%)', 'Apple reads 1 (100%)');
  assert.equal(poll.options[0]?.pressed, 'true', 'Apple is the chosen option');
  assert.equal(poll.options[1]?.count, '0 (0%)', 'Pear reads 0 (0%)');
  assert.equal(poll.options[1]?.pressed, 'false', 'Pear is not chosen');
}

/** Line 91: the same poll is final, its vote kept, and voting is closed. */
export function assertFinalResults(timeline: TimelineObservation, pollId: string): PollObservation {
  const poll = samePoll(timeline, pollId);
  assert.equal(poll.total, '1 vote · Final results', 'The poll reads Final results');
  assert(poll.options.length === MESSAGE_POLL_OPTIONS.length &&
    poll.options.every((option) => option.disabled),
  'Every option is disabled after the end');
  assert.equal(poll.options[0]?.count, '1 (100%)', 'The final tally keeps Apple 1 (100%)');
  assert.equal(poll.endCount, 0, 'No End control remains');
  return poll;
}

// Authoritative MSC3381 events.

type MatrixEvent = Readonly<Record<string, unknown>>;

/** Every poll-namespace event in one `/messages?dir=b&limit=50` page, oldest first. */
export function authoritativePollEvents(response: unknown): readonly MatrixEvent[] {
  const page = object(response, 'Room messages page');
  const types: readonly string[] = POLL_EVENT_TYPES;
  return arrayField(page, 'chunk')
    .map((event, index) => object(event, `Room messages event ${index}`))
    .filter((event) => typeof event['type'] === 'string' && types.includes(event['type']))
    .reverse();
}

export interface PollEventExpectation {
  readonly roomId: string;
  readonly sender: string;
}

function content(event: MatrixEvent): Record<string, unknown> {
  return object(event['content'], 'Event content');
}

function eventId(event: MatrixEvent): string {
  const id = event['event_id'];
  assert(typeof id === 'string' && id.startsWith('$'), 'Poll event has a real Matrix event id');
  return id;
}

function assertEnvelope(event: MatrixEvent, type: string, expected: PollEventExpectation): string {
  const id = eventId(event);
  assert.equal(event['type'], type, `Event is ${type}`);
  assert.equal(event['room_id'], expected.roomId, 'Event belongs to the exact Room');
  assert.equal(event['sender'], expected.sender, 'Event has the active sender');
  return id;
}

function assertReference(event: MatrixEvent, pollId: string): void {
  const relation = object(content(event)['m.relates_to'], 'Poll relation');
  assert.equal(relation['rel_type'], 'm.reference', 'The relation is an m.reference');
  assert.equal(relation['event_id'], pollId, 'The relation targets the exact poll');
}

/** The one native poll start: exact row id, question, kind, selections and answers. */
export function assertPollStartEvent(
  event: MatrixEvent,
  expected: PollEventExpectation & { readonly pollId: string; readonly question: string },
): void {
  const id = assertEnvelope(event, POLL_START_TYPE, expected);
  assert.equal(id, expected.pollId, 'The start event is the reconciled poll row');
  const body = content(event);
  assert(!('m.relates_to' in body), 'The poll start is an original event');
  const start = object(body[POLL_START_TYPE], 'm.poll.start content');
  assert.equal(object(start['question'], 'Poll question')['m.text'], expected.question,
    'The start event carries the exact question');
  assert.equal(start['kind'], MESSAGE_POLL_KIND, 'The poll is disclosed');
  assert.equal(start['max_selections'], 1, 'The poll is single-select');
  const answers = arrayField(start, 'answers').map((answer, index) =>
    object(answer, `Poll answer ${index}`));
  assert.deepEqual(answers.map((answer) => [answer['id'], answer['m.text']]),
    MESSAGE_POLL_OPTIONS.map((text, index) => [MESSAGE_POLL_ANSWER_IDS[index], text]),
  'The start event carries exactly a0 Apple and a1 Pear');
}

/** The native vote: one Apple answer, related to the exact poll. */
export function assertPollResponseEvent(
  event: MatrixEvent,
  expected: PollEventExpectation & { readonly pollId: string },
): string {
  const id = assertEnvelope(event, POLL_RESPONSE_TYPE, expected);
  assertReference(event, expected.pollId);
  const response = object(content(event)[POLL_RESPONSE_TYPE], 'm.poll.response content');
  assert.deepEqual(response['answers'], [MESSAGE_POLL_VOTE_ANSWER],
    'The response selects exactly Apple (a0)');
  return id;
}

/** The native end: related to the exact poll. */
export function assertPollEndEvent(
  event: MatrixEvent,
  expected: PollEventExpectation & { readonly pollId: string },
): string {
  const id = assertEnvelope(event, POLL_END_TYPE, expected);
  assertReference(event, expected.pollId);
  object(content(event)[POLL_END_TYPE], 'm.poll.end content');
  return id;
}

export type PollChainStep = 'start' | 'response' | 'end';

/**
 * The Room holds exactly the native poll chain up to `step`, oldest first: no
 * earlier, duplicate or unrelated poll event, and no later one yet.
 */
export function assertPollChain(
  events: readonly MatrixEvent[],
  step: PollChainStep,
  expected: PollEventExpectation & { readonly pollId: string; readonly question: string },
): { readonly responseId?: string; readonly endId?: string } {
  const length = { start: 1, response: 2, end: 3 }[step];
  assert.equal(events.length, length, `The Room holds exactly the poll chain up to ${step}`);
  assertPollStartEvent(events[0]!, expected);
  if (step === 'start') return {};
  const responseId = assertPollResponseEvent(events[1]!, expected);
  if (step === 'response') return { responseId };
  return { responseId, endId: assertPollEndEvent(events[2]!, expected) };
}
