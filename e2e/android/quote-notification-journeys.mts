import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { publicStageFailure } from '../support/public-failure.mts';
import { readSession } from '../support/session.mts';
import { MatrixTestResources } from '../support/test-resources.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountElementFilter,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';
import {
  QUOTE_NOTIFICATION_ASSERTION_RECORDS,
  QUOTE_NOTIFICATION_STAGES,
  READER_DISPLAY_NAME,
  READER_ROLE,
  RUN_SUFFIX,
  QUOTED_COMPOSER,
  SOURCE_BODY,
  WRITER_ROLE,
  answerText,
  assertAnswerEvent,
  assertArrangement,
  assertComposerEmpty,
  assertComposerQuote,
  assertHighlightZero,
  assertNotificationPositive,
  assertQuoteCaret,
  assertQuoteNotificationReceiptName,
  assertQuoteNotificationRecords,
  assertQuoteOffered,
  assertSheetVisible,
  probeText,
  probeTxn,
  quoteNotificationAssertion,
  quoteRoomName,
  sourceTxn,
  type QuoteNotificationAssertion,
  type QuoteNotificationStage,
  type QuoteNotificationStageId,
} from './quote-notification-contract.mts';
import {
  assertDraftSent,
  assertRoomReady,
  assertSameRow,
  assertSendEnabled,
  assertServerEcho,
  assertSheetClosed,
} from './message-quote-contract.mts';
import {
  readAppliedProfile,
  readComposer,
  readSheet,
  readTimeline,
  type ObservationOptions,
} from './message-quote-observer.mts';
import { appendNativeLine } from './message-quote-journeys.mts';
import {
  markQuoteNotificationDiagnosticsSafe,
  quoteNotificationSecrets,
  revokeQuoteNotificationPublicationOnAbort,
  type QuoteNotificationPublicationSafety,
  type QuoteNotificationSecretIds,
} from './quote-notification-artifacts.mts';
import {
  redactDiagnosticText,
  runPinnedPanelStageCleanup,
  scanPinnedPanelArtifacts,
  scrubPinnedPanelArtifacts,
} from './pinned-message-panel-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

/** The minimum a parity record or receipt needs; the guard drives it with a fake client. */
export interface RecordContext {
  readonly entry: QuoteNotificationStage;
  readonly records: QuoteNotificationAssertion[];
  /** Suite-wide identities, so a duplicate can never be emitted twice. */
  readonly identities: Set<string>;
  receipts: number;
  readonly client: Pick<AccountWorkspaceClient, 'record'>;
}

/** One Room's ledger entry, filled in as its name then its id become known. */
interface RoomLedgerEntry {
  id?: string;
  name?: string;
}

/** Every identifier the stage creates, registered before any UI step. */
interface SecretLedger {
  readonly run: string;
  readonly accounts: NodeWorkspaceAccount[];
  readonly rooms: RoomLedgerEntry[];
  readonly texts: string[];
  readonly eventIds: string[];
  readonly transactions: string[];
}

export interface QuoteNotificationStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: AccountFixtures;
  readonly secrets: Record<string, string>;
  readonly safety: QuoteNotificationPublicationSafety;
  readonly ledger: SecretLedger;
  readonly signal: AbortSignal;
  /** Set once `client.reset` has attached a WebView that can be captured. */
  native: boolean;
}

/** A parity identity is emitted only after its proof passed, in contract order. */
export async function record(
  context: RecordContext,
  suffix: string,
  assertion: () => void,
  observation: unknown,
): Promise<void> {
  const identity = quoteNotificationAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Quote-notification parity records stay in source order');
  assert(!context.identities.has(identity), 'No duplicate suite assertion identity');
  assertion();
  await context.client.record(identity, { assertion: identity, observation });
  context.records.push(identity);
  context.identities.add(identity);
}

/** A numbered, artifact-local proof that is never a parity identity. */
export async function receipt(
  context: Pick<RecordContext, 'client' | 'receipts'>,
  name: string,
  value: unknown,
): Promise<void> {
  assertQuoteNotificationReceiptName(name);
  context.receipts++;
  await context.client.record(
    `receipt-${String(context.receipts).padStart(2, '0')}-${name}`, value);
}

function passes<T>(check: (value: T) => void): (value: T) => boolean {
  return (value) => {
    try {
      check(value);
      return true;
    } catch {
      return false;
    }
  };
}

/** Merge one Room's partial update into the entry still missing that field. */
function mergeRoom(rooms: RoomLedgerEntry[], patch: RoomLedgerEntry): void {
  const open = rooms.find((room) =>
    (patch.id !== undefined && room.id === undefined) ||
    (patch.name !== undefined && room.name === undefined));
  if (open) {
    Object.assign(open, patch);
    return;
  }
  rooms.push({ ...patch });
}

/** Merge identifiers into the stage ledger and register every form as a secret. */
function protect(
  context: QuoteNotificationStageContext,
  patch: {
    readonly accounts?: readonly NodeWorkspaceAccount[];
    readonly rooms?: readonly RoomLedgerEntry[];
    readonly texts?: readonly string[];
    readonly eventIds?: readonly string[];
    readonly transactions?: readonly string[];
  },
): void {
  const { ledger } = context;
  if (patch.accounts) ledger.accounts.push(...patch.accounts);
  if (patch.rooms) for (const room of patch.rooms) mergeRoom(ledger.rooms, room);
  ledger.texts.push(...(patch.texts ?? []));
  ledger.eventIds.push(...(patch.eventIds ?? []));
  ledger.transactions.push(...(patch.transactions ?? []));
  const ids: QuoteNotificationSecretIds = {
    accounts: ledger.accounts.map(({ userId, username, password }) => ({ userId, username, password })),
    rooms: ledger.rooms,
    texts: ledger.texts,
    eventIds: ledger.eventIds,
    transactions: ledger.transactions,
  };
  Object.assign(context.secrets, quoteNotificationSecrets(context.entry.id, ids));
}

export function quoteNotificationTeardown(
  client: Pick<AccountWorkspaceClient, 'close'>,
  device: { clearApplicationData(id: string): Promise<unknown> },
): readonly (() => Promise<void>)[] {
  return [
    () => client.close(),
    async () => { await device.clearApplicationData(APPLICATION_ID); },
  ];
}

/**
 * RF-5: the stage's own teardown, run from `finally` so every step executes
 * even after the stage failed. Extracted so a guard can drive it with fakes
 * and catch a dropped or truncated call, which the runner's `finally` body
 * could not otherwise expose.
 */
export async function finishQuoteNotificationStage(
  client: Pick<AccountWorkspaceClient, 'close'>,
  device: { clearApplicationData(id: string): Promise<unknown> },
  failures: unknown[],
): Promise<boolean> {
  const before = failures.length;
  await runPinnedPanelStageCleanup(quoteNotificationTeardown(client, device), failures);
  return failures.length > before;
}

const APPLICATION_ID = 'eu.qwky.trinity';
const RAIL = '[data-testid="rail-rooms"]';
const QUOTE = '[data-testid="sheet-quote"]';
const SEND = '[data-testid="composer-send"]';
/** Reconciled message rows; the text filter picks one and is never logged. */
const READY_ROW = '.scroll .msg[data-mid^="$"]';
// Bounds (spec D4): at least the predecessor's own; 10/15 s become 20 s under host load.
const ROOM_ROW_MS = 30_000;     // 116 waitFor
const UI_MS = 20_000;           // 118, 220, 132
const SOURCE_ROW_MS = 30_000;   // 123
const SEND_READY_MS = 20_000;   // composer 53 (record 5)
const ANSWER_MS = 30_000;       // 138
const SERVER_MS = 30_000;       // answer event (receipt)
const NOTIFY_MS = 30_000;       // 167

/** Time left of `boundMs` since `since`, never below 1 ms. */
function left(boundMs: number, since: number): number {
  return Math.max(boundMs - (Date.now() - since), 1);
}

/** Poll a renderer read until `check` passes; on timeout rethrow `check`'s own failure on the last read. */
async function until<T>(
  read: (client: AccountWorkspaceClient, options: ObservationOptions<T>) => Promise<T>,
  context: QuoteNotificationStageContext, check: (value: T) => void, timeoutMs: number, description: string,
): Promise<T> {
  let last: T | undefined;
  try {
    return await read(context.client, { accepts: (v) => { last = v; return passes(check)(v); }, timeoutMs, description });
  } catch (error) {
    if (last !== undefined && error instanceof Error && error.message.startsWith('Timed out waiting for')) check(last);
    throw error;
  }
}

/** A native tap whose return time anchors every following window. */
async function tap(context: QuoteNotificationStageContext, selector: string,
  filter: AccountElementFilter = {}): Promise<number> {
  await context.client.tapCurrent(selector, filter);
  return Date.now();
}

/**
 * Poll Synapse until `check` passes within `bound` measured from `anchor`
 * (never a fresh bound). The accepted value is returned, so a caller that
 * decides two records on it decides both on one response.
 */
async function server<T>(context: QuoteNotificationStageContext, read: () => Promise<T>,
  check: (value: T) => void, anchor: number, description: string, bound = SERVER_MS): Promise<T> {
  let last: T | undefined;
  try {
    const value = await waitForNativeShellState(read, (v) => { last = v; return passes(check)(v); },
      description, context.signal, left(bound, anchor));
    check(value);
    return value;
  } catch (error) {
    if (last !== undefined && error instanceof Error && error.message.startsWith('Timed out waiting for')) check(last);
    throw error;
  }
}

function historyOf(page: unknown): readonly Readonly<Record<string, unknown>>[] {
  return [...(page as { chunk: readonly Readonly<Record<string, unknown>>[] }).chunk].reverse();
}

function isPixel5Profile(applied: Awaited<ReturnType<typeof readAppliedProfile>>): boolean {
  return applied.innerWidth === PIXEL_5_ACCOUNT_PROFILE.width
    && applied.innerHeight === PIXEL_5_ACCOUNT_PROFILE.height
    && Math.abs(applied.devicePixelRatio - PIXEL_5_ACCOUNT_PROFILE.deviceScaleFactor!) < 1e-6
    && applied.coarsePointer && applied.hoverNone && applied.platform === 'android';
}

async function startNative(context: QuoteNotificationStageContext): Promise<void> {
  assert(!context.safety.unsafeSecrets, 'Every stage identifier is registered before any UI step');
  await context.client.reset(PIXEL_5_ACCOUNT_PROFILE);
  context.native = true;
  const applied = await readAppliedProfile(context.client);
  assert(isPixel5Profile(applied), 'The applied profile is Pixel 5');
  await context.client.record('profile-applied', {
    requested: PIXEL_5_ACCOUNT_PROFILE, digest: digest(JSON.stringify(PIXEL_5_ACCOUNT_PROFILE)), ...applied,
  });
}

export async function runQuotedDisplayName(context: QuoteNotificationStageContext): Promise<void> {
  const { client, fixtures, ledger } = context;
  const { run } = ledger;
  const roomName = quoteRoomName(run);
  const answer = answerText(run);
  const probe = probeText(run);
  protect(context, { rooms: [{ name: roomName }], texts: [answer, probe],
    transactions: [sourceTxn(run), probeTxn(run)] });
  const writer = await fixtures.account(WRITER_ROLE);
  const reader = await fixtures.account(READER_ROLE);
  protect(context, { accounts: [writer, reader] });

  // 83–105: the name first, so the invite and join carry it; the reader sends the source.
  await fixtures.setDisplayName(reader, READER_DISPLAY_NAME);
  const room = await fixtures.createRoom(writer, { name: roomName, preset: 'private_chat', invite: [reader.userId] });
  protect(context, { rooms: [{ id: room.id }] });
  await fixtures.join(reader, room.id);
  const sourceId = await fixtures.sendMessage(reader, room.id, SOURCE_BODY, sourceTxn(run));
  protect(context, { eventIds: [sourceId] });
  assertArrangement(historyOf(await fixtures.roomMessages(writer, room.id)),
    { writerId: writer.userId, readerId: reader.userId, sourceId });
  await receipt(context, 'arranged', { messages: 1, readerJoined: true, displayName: true, roomDigest: digest(room.id) });
  context.safety.unsafeSecrets = false;

  // 107–120: the writer signs in and opens the Room natively.
  await startNative(context);
  await client.login(writer);
  await client.hideKeyboard();
  const railAt = await tap(context, RAIL);
  await client.visible('.channel', { text: roomName }, left(ROOM_ROW_MS, railAt));
  const openedAt = await tap(context, '.channel', { text: roomName });
  const identity = { name: roomName, roomId: room.id, userId: writer.userId };
  const opened = await until(readComposer, context, (c) => assertRoomReady(c, identity),
    left(UI_MS, openedAt), 'composer of the exact Room');
  await record(context, 'composer-visible', () => assertRoomReady(opened, identity),
    { composerVisible: true, exactPlaceholder: true, exactRoute: true, roomDigest: digest(room.id) });
  assertComposerEmpty(opened);
  await receipt(context, 'composer-empty', { empty: true });

  // 122–123: the arranged source row.
  const readyAt = Date.now();
  const source = await until(readTimeline, context, (t) => { assertSameRow(t, SOURCE_BODY, sourceId); },
    left(SOURCE_ROW_MS, readyAt), 'the arranged source row');
  await record(context, 'source-row-visible', () => { assertSameRow(source, SOURCE_BODY, sourceId); },
    { visible: true, eventDigest: digest(sourceId) });

  // 124–126 (220@125): a native long press opens the sheet; Quote natively.
  await client.hideKeyboard();
  await client.longPressCurrent(READY_ROW, { text: SOURCE_BODY });
  const pressedAt = Date.now();
  const sheet = await until(readSheet, context, assertSheetVisible, left(UI_MS, pressedAt),
    'Android message-action sheet');
  await record(context, 'sheet-ready', () => assertSheetVisible(sheet), { dialogs: sheet.dialogs, visible: true });
  assertQuoteOffered(sheet);
  await receipt(context, 'quote-offered', { quotes: sheet.quote.count, visible: sheet.quote.visible });
  const quotedAt = await tap(context, QUOTE);
  const closed = await until(readSheet, context, assertSheetClosed, left(UI_MS, quotedAt), 'sheet closed by Quote');
  await receipt(context, 'quote-picked', { openSheets: closed.dialogs });

  // 132: exactly the quote block and its blank line.
  const quoted = await until(readComposer, context, assertComposerQuote, left(UI_MS, quotedAt),
    'exact quote block in the composer');
  await record(context, 'composer-quote', () => assertComposerQuote(quoted), { exactValue: true, blankLine: true });
  assertQuoteCaret(quoted);
  await receipt(context, 'quote-caret', { focused: true, caret: quoted.selectionStart });

  // 133–135: the answer, appended natively, then sendComposerDraft's mobile path (53@135, then Send).
  await appendNativeLine(client, QUOTED_COMPOSER, answer);
  await receipt(context, 'answer-native-draft', { keys: ['append'], exactValue: true });
  const draft = `${QUOTED_COMPOSER}${answer}`;
  await client.hideKeyboard();
  const hiddenAt = Date.now();
  const enabled = await until(readComposer, context, (c) => assertSendEnabled(c, draft),
    left(SEND_READY_MS, hiddenAt), 'Send enabled for the exact draft');
  await record(context, 'answer-send-enabled', () => assertSendEnabled(enabled, draft),
    { exactDraft: true, sendEnabled: enabled.sendDisabled === false });
  const sentAt = await tap(context, SEND);
  await until(readComposer, context, assertDraftSent, left(UI_MS, sentAt), 'composer cleared by the native send');
  await receipt(context, 'answer-sent', { cleared: true });

  // 136–138: the proved answer event, then its one visible row.
  const echo = await until(readTimeline, context, (t) => { assertServerEcho(t, answer); },
    left(ANSWER_MS, sentAt), 'answer row reconciled to a server event');
  const answerId = assertServerEcho(echo, answer).id;
  protect(context, { eventIds: [answerId] });
  const expected = { writerId: writer.userId, answerId, run };
  const events = await server(context, async () => historyOf(await fixtures.roomMessages(writer, room.id)),
    (e) => { assertAnswerEvent(e, expected); }, sentAt, 'answer event on the server');
  await receipt(context, 'answer-event', { eventDigest: digest(answerId), exactBody: true, ...assertAnswerEvent(events, expected) });
  await record(context, 'answer-visible', () => { assertSameRow(echo, answer, answerId); },
    { visible: true, eventDigest: digest(answerId) });

  // 143–150: the reader's token, then the writer's plain probe.
  const token = await fixtures.roomUnreadSync(reader, room.id);
  const since = token.nextBatch;
  await receipt(context, 'sync-token', { established: since.length > 0,
    baseline: token.room ? { notificationCount: token.room.notificationCount, highlightCount: token.room.highlightCount } : null });
  const probeId = await fixtures.sendMessage(writer, room.id, probe, probeTxn(run));
  const probeSentAt = Date.now();
  protect(context, { eventIds: [probeId] });
  await receipt(context, 'probe-sent', { eventDigest: digest(probeId) });

  // 152–173: poll only after the probe returned (spec D6); the first accepted response decides both records.
  const decided = await server(context, () => fixtures.roomUnreadSync(reader, room.id, since),
    (s) => assertNotificationPositive(s, { since, probeId }), probeSentAt,
    'the probe in the reader incremental sync with a positive count', NOTIFY_MS);
  await record(context, 'notification-positive', () => assertNotificationPositive(decided, { since, probeId }),
    { notificationCount: decided.room!.notificationCount, probeInSync: true });
  await record(context, 'highlight-zero', () => assertHighlightZero(decided),
    { highlightCount: 0, notificationCount: decided.room!.notificationCount, sameResponse: true });
}

const STAGE_RUNNERS: Readonly<Record<
  QuoteNotificationStageId,
  (context: QuoteNotificationStageContext) => Promise<void>
>> = {
  'quoted-display-name': runQuotedDisplayName,
};

interface StageReport {
  readonly id: QuoteNotificationStageId;
  readonly source: string;
  readonly title: string;
  readonly profile: 'pixel-5';
  status: 'running' | 'passed' | 'failed';
  durationMs: number;
  readonly artifact: string;
  readonly attempt: 1;
  readonly retries: 0;
  readonly expectedAssertionRecords: number;
  assertionRecords: number;
  assertions: QuoteNotificationAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 1;
  readonly expectedUniqueAssertions: 8;
  readonly expectedAssertionRecords: 8;
  readonly attempt: 1;
  readonly retries: 0;
  readonly applications: readonly string[];
  readonly stages: StageReport[];
  /** Cleanup failures that happened before any stage started. */
  cleanupErrors?: string[];
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

/**
 * The error rethrown to the test reporter after a failed stage. The reporter
 * prints thrown errors to the ungated job log, and Node appends an assertion's
 * actual/expected values to its message, so the shared public rethrow keeps
 * only names and first message lines, with every registered secret and every
 * Matrix Room and event-id shape redacted. The complete text stays in the
 * scrubbed journeys.json.
 */
export function redactStageFailure(
  stageId: string,
  failures: readonly unknown[],
  secrets: Readonly<Record<string, string>>,
): Error {
  return publicStageFailure(`Android quote-notification ${stageId} failed`, failures,
    (text) => redactDiagnosticText(text, secrets));
}

/** An id-free account of a cleanup failure for process output, which reaches ungated CI logs. */
export function redactCleanupFailure(label: string, error: unknown): Error {
  const parts: string[] = [];
  const visit = (value: unknown): void => {
    if (value instanceof AggregateError) {
      for (const nested of value.errors) visit(nested);
    } else if (value instanceof Error) {
      const status: unknown = Reflect.get(value, 'status');
      parts.push(typeof status === 'number' ? `${value.name} HTTP ${status}` : value.name);
    } else {
      parts.push(typeof value);
    }
  };
  visit(error);
  return new Error(`Quote-notification cleanup failed: ${label} (${parts.join('; ')})`);
}

/** The run state a failed guarded cleanup marks before it rethrows. */
export interface GuardedCleanupState {
  readonly safety: QuoteNotificationPublicationSafety;
  readonly report: {
    status: 'running' | 'passed' | 'failed';
    readonly stages: readonly {
      status: 'running' | 'passed' | 'failed';
      failureCount: number;
      error?: string;
    }[];
    cleanupErrors?: string[];
  };
  save(): Promise<void>;
}

/**
 * Register cleanups that block publication when they fail. The full failure goes to
 * `journeys.json`, which the scrub redacts; only an id-free error is rethrown.
 */
export function guardQuoteNotificationCleanup(
  register: (label: string, action: () => Promise<void>) => void,
  state: GuardedCleanupState,
): (label: string, action: () => Promise<void>) => void {
  return (label, action) => register(label, async () => {
    try { await action(); }
    catch (error) {
      state.safety.cleanupFailed = true;
      state.report.status = 'failed';
      const failure = `Cleanup failed: ${label}\n${describeFailure(error)}`;
      const stage = state.report.stages.at(-1);
      if (stage) {
        stage.status = 'failed';
        stage.failureCount++;
        stage.error = stage.error ? `${stage.error}\n${failure}` : failure;
      } else {
        state.report.cleanupErrors = [...state.report.cleanupErrors ?? [], failure];
      }
      await state.save();
      throw redactCleanupFailure(label, error);
    }
  });
}

/** Single-attempt, one-stage run with post-cleanup publication safety. */
export async function runQuoteNotificationSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'quote-notification');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(QUOTE_NOTIFICATION_STAGES.length, 1, 'Quote-notification runs one stage');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 1,
          expectedUniqueAssertions: 8,
          expectedAssertionRecords: 8,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeQuoteNotificationPublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: QuoteNotificationPublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardQuoteNotificationCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan quote-notification diagnostics', () =>
          report.status === 'passed'
            ? markQuoteNotificationDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanPinnedPanelArtifacts(output, secrets));
        guardedCleanup('Scrub quote-notification diagnostics', async () => {
          try { await scrubPinnedPanelArtifacts(output, secrets); }
          catch (error) { safety.scrubFailed = true; throw error; }
        });
        try {
          const device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          guardedCleanup('Quote-notification Android device', () => device.close());
          // Fixture cleanups register after the device, so they retire first.
          const resources = new MatrixTestResources(matrixResources.namespace);
          resources.cleanup = guardedCleanup;
          const fixtures = createAccountFixtures(resources, signal);
          await installWithAndroidRuntimeProvenance({
            device,
            applicationId: APPLICATION_ID,
            apk: join(session.workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk'),
            rendererManifest: join(session.workspaceRoot, 'dist/web-bundle-manifest.json'),
            profile: PIXEL_5_ACCOUNT_PROFILE,
            output: join(output, 'runtime-provenance.json'),
          });
          const identities = new Set<string>();
          for (const entry of QUOTE_NOTIFICATION_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: QuoteNotificationAssertion[] = [];
            const stage: StageReport = {
              id: entry.id,
              source: entry.source,
              title: entry.title,
              profile: 'pixel-5',
              status: 'running',
              durationMs: 0,
              artifact: `${entry.id}/**`,
              attempt: 1,
              retries: 0,
              expectedAssertionRecords: entry.expectedAssertionRecords,
              assertionRecords: 0,
              assertions: [],
              receipts: 0,
              failureCount: 0,
            };
            stages.push(stage);
            await save();
            const started = performance.now();
            const failures: unknown[] = [];
            console.info(`[quote-notification] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: QuoteNotificationStageContext = {
              entry,
              client,
              fixtures,
              secrets,
              safety,
              records,
              identities,
              receipts: 0,
              native: false,
              signal,
              ledger: {
                run: `${resources.aliasLocalpart('quote-notification')}${RUN_SUFFIX}`,
                accounts: [],
                rooms: [],
                texts: [],
                eventIds: [],
                transactions: [],
              },
            };
            try {
              protect(context, {});
              await STAGE_RUNNERS[entry.id](context);
              assertQuoteNotificationRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              try { if (context.native) await client.capture('failed'); }
              catch (captureError) { failures.push(captureError); }
            } finally {
              if (await finishQuoteNotificationStage(client, device, failures)) safety.cleanupFailed = true;
              stage.assertions = [...records];
              stage.assertionRecords = records.length;
              stage.receipts = context.receipts;
              stage.durationMs = performance.now() - started;
              stage.failureCount = failures.length;
              stage.status = failures.length ? 'failed' : 'passed';
              if (failures.length) stage.error = failures.map(describeFailure).join('\n');
              await save();
              console.info(`[quote-notification] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, QUOTE_NOTIFICATION_ASSERTION_RECORDS,
            'Every quote-notification parity identity was emitted once');
          signal.throwIfAborted();
          report.status = 'passed';
          await save();
        } catch (error) {
          report.status = 'failed';
          await save();
          throw error;
        }
      });
  } finally {
    if (effectiveSignal.aborted) await revokeOnAbort?.();
  }
}

// Vitest imports the helpers without launching an emulator.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void test('Android quote-notification journeys', { timeout: 900_000 }, runQuoteNotificationSuite);
}
