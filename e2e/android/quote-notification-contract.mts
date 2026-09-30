import assert from 'node:assert/strict';
import type { WorkspaceUnreadSync } from './account-workspace-fixtures.mts';
import type { ComposerObservation, SheetObservation } from './message-quote-contract.mts';

export const QUOTE_NOTIFICATION_SOURCE =
  'e2e/browser/journeys/conversations/quote-mentions.spec.mts';
/** The canonical bytes (ruled Q1): the dd0cb53c blob, equal to the working tree. */
export const QUOTE_NOTIFICATION_SOURCE_SHA256 =
  '5186fc3b45f12fd03e2ad71e79ae636a688fce41b96d05fb0e38f278f80266e5';
/** The issue's stale pin, before fe2c7c3e; provenance only. */
export const QUOTE_NOTIFICATION_ISSUE_SOURCE_SHA256 =
  '354f8f2ccd02e32b12bf74bea400abb4dec40bad31715fd80e03c4fd79fd49f8';
export const QUOTE_NOTIFICATION_SOURCE_LINES = 175;

export const QUOTE_NOTIFICATION_SHARED_SOURCE_SHA256 = {
  'e2e/support/app.mts': '60ea972bfcb1f4b75bd2db65be0f3c1481e9121ff96c97682d8fcb28478537e3',
  'e2e/support/account.mts': 'ac6ad399ec77fae180f06bf5e394cfb7154d0e8f4f3524f130b63c49b6460594',
  'e2e/support/message-composer.mts': '4b81585eea679d11dabd285449c9b004b6d70612ca777186ac34e44705c12d9d',
} as const;

export const QUOTE_NOTIFICATION_STAGE_IDS = ['quoted-display-name'] as const;

export type QuoteNotificationStageId = (typeof QUOTE_NOTIFICATION_STAGE_IDS)[number];

export interface QuoteNotificationSpan {
  readonly from: number;
  readonly to: number;
}

/** Owned predecessor spans: the display-name constant, the API-login helper, the definition and its two branches. */
export const QUOTE_NOTIFICATION_SPANS = {
  displayName: { from: 40, to: 59 },
  loginApi: { from: 43, to: 59 },
  definition: { from: 64, to: 174 },
  androidBranch: { from: 124, to: 126 },
  desktopBranch: { from: 127, to: 129 },
} as const satisfies Readonly<Record<string, QuoteNotificationSpan>>;

/** The two helpers whose `expect` lines the Android path inherits. */
export const QUOTE_NOTIFICATION_HELPERS = {
  openMessageActionSheet: { module: 'e2e/support/app.mts', expectLines: [220], role: 'action-sheet-readiness' },
  sendComposerDraft: { module: 'e2e/support/message-composer.mts', expectLines: [53], role: 'composer-send-readiness' },
} as const satisfies Readonly<Record<string, { readonly module: string; readonly expectLines: readonly number[]; readonly role: string }>>;

export type QuoteNotificationHelper = keyof typeof QUOTE_NOTIFICATION_HELPERS;

/** The desktop `else` branch's helper: reached only from 128, never expanded here. */
export const QUOTE_NOTIFICATION_EXCLUDED = [
  { helper: 'clickRowMenuItem', module: 'e2e/support/app.mts', line: 206, call: 128, reason: 'desktop else branch' },
] as const;

/**
 * One source-mapped parity site. `line` is the `expect` line. An inherited
 * site's `helper` owns that line and `call` is the definition-body call line.
 */
export type QuoteNotificationSite =
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'direct';
    }
  | {
      readonly line: number;
      readonly suffix: string;
      readonly kind: 'inherited';
      readonly helper: QuoteNotificationHelper;
      readonly call: number;
    };

const quotedDisplayNameSites = [
  { line: 118, suffix: 'composer-visible', kind: 'direct' },
  { line: 123, suffix: 'source-row-visible', kind: 'direct' },
  { line: 220, suffix: 'sheet-ready', kind: 'inherited', helper: 'openMessageActionSheet', call: 125 },
  { line: 132, suffix: 'composer-quote', kind: 'direct' },
  { line: 53, suffix: 'answer-send-enabled', kind: 'inherited', helper: 'sendComposerDraft', call: 135 },
  { line: 136, suffix: 'answer-visible', kind: 'direct' },
  { line: 153, suffix: 'notification-positive', kind: 'direct' },
  { line: 173, suffix: 'highlight-zero', kind: 'direct' },
] as const satisfies readonly QuoteNotificationSite[];

export type QuoteNotificationAssertion = `quote-notification.${QuoteNotificationStageId}.${string}`;

export interface QuoteNotificationStage {
  readonly id: QuoteNotificationStageId;
  readonly source: string;
  readonly title: string;
  readonly sites: readonly QuoteNotificationSite[];
  readonly expectedAssertionRecords: number;
  readonly assertions: readonly QuoteNotificationAssertion[];
}

function stage(
  id: QuoteNotificationStageId,
  title: string,
  sites: readonly QuoteNotificationSite[],
): QuoteNotificationStage {
  const span = QUOTE_NOTIFICATION_SPANS.definition;
  return {
    id,
    source: `${QUOTE_NOTIFICATION_SOURCE}:${span.from}-${span.to}`,
    title,
    sites,
    expectedAssertionRecords: sites.length,
    assertions: sites.map(
      ({ suffix }): QuoteNotificationAssertion => `quote-notification.${id}.${suffix}`,
    ),
  };
}

export const QUOTE_NOTIFICATION_STAGES: readonly QuoteNotificationStage[] = [
  stage('quoted-display-name', 'a quoted display name gives the reader no highlight', quotedDisplayNameSites),
];

export const QUOTE_NOTIFICATION_ASSERTION_RECORDS = 8;
export const QUOTE_NOTIFICATION_DIRECT = 6;
export const QUOTE_NOTIFICATION_INHERITED = 2;

/** Direct sites order by line; a helper call runs before a later-line matcher. */
function siteOrderKey(site: QuoteNotificationSite): readonly [number, number] {
  return site.kind === 'direct' ? [site.line, 1] : [site.call, 0];
}

function after(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left[0] !== right[0] ? left[0] > right[0] : left[1] > right[1];
}

function within(line: number, span: QuoteNotificationSpan): boolean {
  return Number.isInteger(line) && line >= span.from && line <= span.to;
}

function validateContract(): void {
  assert.deepEqual(QUOTE_NOTIFICATION_STAGES.map(({ id }) => id),
    [...QUOTE_NOTIFICATION_STAGE_IDS], 'Quote-notification stages keep source order');
  const sites = QUOTE_NOTIFICATION_STAGES.flatMap((entry) => entry.sites);
  const identities = QUOTE_NOTIFICATION_STAGES.flatMap((entry) => entry.assertions);
  assert.equal(sites.length, QUOTE_NOTIFICATION_ASSERTION_RECORDS,
    'Quote-notification owns exactly 8 records');
  assert.equal(sites.filter((site) => site.kind === 'direct').length,
    QUOTE_NOTIFICATION_DIRECT, 'Quote-notification owns exactly 6 direct sites');
  assert.equal(sites.filter((site) => site.kind === 'inherited').length,
    QUOTE_NOTIFICATION_INHERITED, 'Quote-notification owns exactly 2 inherited sites');
  assert.equal(new Set(identities).size, QUOTE_NOTIFICATION_ASSERTION_RECORDS,
    'Quote-notification identities are unique');
  const span = QUOTE_NOTIFICATION_SPANS.definition;
  for (const entry of QUOTE_NOTIFICATION_STAGES) {
    assert.equal(entry.expectedAssertionRecords, entry.sites.length,
      `${entry.id} expected records equal its sites`);
    for (const identity of entry.assertions) {
      assert.match(identity, new RegExp(
        `^quote-notification\\.${entry.id}\\.[a-z0-9]+(?:-[a-z0-9]+)*$`),
      `${identity} is a stage-local identity`);
    }
    let previous: readonly [number, number] = [0, 0];
    for (const site of entry.sites) {
      const key = siteOrderKey(site);
      assert(after(key, previous), `${entry.id}.${site.suffix} keeps source order`);
      previous = key;
      if (site.kind === 'direct') {
        assert(within(site.line, span), `${entry.id}.${site.suffix} lies inside its definition`);
        continue;
      }
      const lines: readonly number[] = QUOTE_NOTIFICATION_HELPERS[site.helper].expectLines;
      assert(lines.includes(site.line),
        `${entry.id}.${site.suffix} expands one of ${site.helper}'s expect lines`);
      if (site.helper === 'openMessageActionSheet')
        assert(within(site.call, QUOTE_NOTIFICATION_SPANS.androidBranch),
          `${entry.id}.${site.suffix} call lies in the Android branch`);
      else
        assert(within(site.call, span) && !within(site.call, QUOTE_NOTIFICATION_SPANS.desktopBranch),
          `${entry.id}.${site.suffix} call lies in the definition, outside the desktop branch`);
    }
  }
}

validateContract();

function entryFor(stageId: QuoteNotificationStageId): QuoteNotificationStage {
  const entry = QUOTE_NOTIFICATION_STAGES.find((item) => item.id === stageId);
  assert(entry, `Unknown quote-notification stage ${stageId}`);
  return entry;
}

export function quoteNotificationAssertion(
  stageId: QuoteNotificationStageId,
  suffix: string,
): QuoteNotificationAssertion {
  const entry = entryFor(stageId);
  const identity: QuoteNotificationAssertion = `quote-notification.${stageId}.${suffix}`;
  assert(entry.assertions.includes(identity), `Unexpected identity ${identity}`);
  return identity;
}

export function assertQuoteNotificationRecords(
  stageId: QuoteNotificationStageId,
  actual: readonly string[],
): void {
  assert.deepEqual(actual, entryFor(stageId).assertions,
    `${stageId} records equal the contract in source order`);
}

/** Receipt names are artifact-local and can never be mistaken for a parity suffix. */
export function assertQuoteNotificationReceiptName(name: string): void {
  assert.match(name, /^[a-z][a-z0-9-]*$/u, `Receipt name ${name} is kebab-case`);
  const suffixes = new Set(QUOTE_NOTIFICATION_STAGES.flatMap((entry) => entry.sites.map((site) => site.suffix)));
  assert(!suffixes.has(name), `Receipt ${name} is not a parity suffix`);
}

export const READER_DISPLAY_NAME = 'Zephyrine';
export const SOURCE_BODY = `${READER_DISPLAY_NAME}, can you look at this?`;
export const QUOTED_COMPOSER = `> ${SOURCE_BODY}\n\n`;
export const RUN_SUFFIX = 'qm';
export const WRITER_ROLE = 'qm-writer';
export const READER_ROLE = 'qm-reader';
export const quoteRoomName = (run: string): string => `Quote mentions ${run}`;
export const answerText = (run: string): string => `on it ${run}`;
export const probeText = (run: string): string => `poke ${run}`;
export const sourceTxn = (run: string): string => `${run}-src`;
export const probeTxn = (run: string): string => `${run}-probe`;

/** App 220 at 125: exactly one visible `Message actions` sheet. */
export function assertSheetVisible(sheet: SheetObservation): void {
  assert.equal(sheet.dialogs, 1, 'Exactly one Message actions sheet');
  assert(sheet.dialogVisible, 'The Message actions sheet is visible');
}

/** The Quote the native tap needs (126): exactly one, visible. */
export function assertQuoteOffered(sheet: SheetObservation): void {
  assertSheetVisible(sheet);
  assert.equal(sheet.quote.count, 1, 'Exactly one Quote action');
  assert(sheet.quote.visible, 'The Quote action is visible');
}

/** Quote ownership: nothing is in the composer before the native Quote. */
export function assertComposerEmpty(composer: ComposerObservation): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert.equal(composer.value, '', 'The composer is empty before the native Quote');
}

/** Line 132: exactly the quote block and its blank line. */
export function assertComposerQuote(composer: ComposerObservation): void {
  assert.equal(composer.count, 1, 'Exactly one composer is rendered');
  assert.equal(composer.value, QUOTED_COMPOSER,
    'The composer holds exactly the quote block and a blank line');
}

/** The native append's precondition: focus kept, caret collapsed at the end. */
export function assertQuoteCaret(composer: ComposerObservation): void {
  assertComposerQuote(composer);
  assert(composer.focused, 'The composer keeps native focus after Quote');
  assert.equal(composer.selectionStart, QUOTED_COMPOSER.length, 'The caret is at the end of the quote');
  assert.equal(composer.selectionEnd, QUOTED_COMPOSER.length, 'The caret selection is collapsed');
}

type MatrixEvent = Readonly<Record<string, unknown>>;
const contentOf = (event: MatrixEvent): Readonly<Record<string, unknown>> => Object(event['content']);

/** Spec D2: the whole history, the reader's own source, and the reader joined as Zephyrine. */
export function assertArrangement(events: readonly MatrixEvent[],
  e: { readonly writerId: string; readonly readerId: string; readonly sourceId: string }): void {
  assert(events.some((event) => event['type'] === 'm.room.create'), 'The /messages page reaches m.room.create');
  const messages = events.filter((event) => event['type'] === 'm.room.message');
  assert.equal(messages.length, 1, 'The Room holds exactly the arranged source message');
  const source = messages[0]!;
  assert.equal(source['event_id'], e.sourceId, 'The message is the arranged source event');
  assert.equal(source['sender'], e.readerId, 'The reader sent the source themselves');
  assert.equal(contentOf(source)['body'], SOURCE_BODY, 'The source body is exact');
  const members = (userId: string) => events.filter((event) =>
    event['type'] === 'm.room.member' && event['state_key'] === userId);
  const reader = members(e.readerId).at(-1);
  assert(reader, 'The reader has a membership event');
  assert.equal(contentOf(reader)['membership'], 'join', 'The reader joined the Room');
  assert.equal(contentOf(reader)['displayname'], READER_DISPLAY_NAME, 'The reader joined as Zephyrine');
  assert.equal(contentOf(members(e.writerId).at(-1) ?? {})['membership'], 'join', 'The writer is joined');
}

export interface AnswerEventSummary {
  readonly namesReader: boolean;
  /** Recorded, never asserted: the server's highlight count is the decision. */
  readonly mentionsKey: boolean;
  readonly relation: boolean;
}

/** Spec D5: the proved answer event is the writer's, with the exact quoted body. */
export function assertAnswerEvent(events: readonly MatrixEvent[],
  e: { readonly writerId: string; readonly answerId: string; readonly run: string }): AnswerEventSummary {
  const answer = events.find((event) => event['event_id'] === e.answerId);
  assert(answer, 'The answer event is on the server');
  assert.equal(answer['type'], 'm.room.message', 'The answer is a Room message');
  assert.equal(answer['sender'], e.writerId, 'The writer sent the answer');
  const content = contentOf(answer);
  assert.equal(content['body'], `${QUOTED_COMPOSER}${answerText(e.run)}`,
    'The answer body is the quote and the answer, exactly');
  assert(String(content['body']).includes(READER_DISPLAY_NAME),
    'The quoted display name is in the evaluated body');
  return { namesReader: true, mentionsKey: 'm.mentions' in content, relation: 'm.relates_to' in content };
}

/** Line 153: an incremental sync since the pre-probe token, carrying the probe, counts above zero. */
export function assertNotificationPositive(sync: WorkspaceUnreadSync,
  e: { readonly since: string; readonly probeId: string }): void {
  assert(e.since.length > 0 && sync.since === e.since,
    'The decision is an incremental sync since the pre-probe token');
  assert(sync.room, 'The incremental sync carries the Room');
  assert(sync.room.timelineEventIds.includes(e.probeId), 'The probe landed in this incremental sync');
  assert(sync.room.notificationCount > 0,
    'The ordinary probe gives the reader a positive notification count');
}

/** Line 173: the same response's highlight count is exactly zero. */
export function assertHighlightZero(sync: WorkspaceUnreadSync): void {
  assert(sync.room, 'The decision response carries the Room');
  assert.equal(sync.room.highlightCount, 0, 'The quoted display name gave the reader no highlight');
}
