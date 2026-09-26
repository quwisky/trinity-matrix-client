import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import { MatrixTestResources } from '../support/test-resources.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import {
  BODY_SENTINEL,
  MESSAGE_SOURCE_ASSERTION_RECORDS,
  MESSAGE_SOURCE_RUN_SUFFIX,
  MESSAGE_SOURCE_STAGES,
  assertDialogVisible,
  assertDraftSent,
  assertJsonBody,
  assertJsonEvent,
  assertMessageSourceReceiptName,
  assertMessageSourceRecords,
  assertNativeComposerValue,
  assertNativeSheetReady,
  assertRoomReady,
  assertRowVisible,
  assertSameRow,
  assertSendEnabled,
  assertServerEcho,
  assertSheetClosed,
  assertSourceRoom,
  assertSurfaceBorder,
  assertSurfaceOpaque,
  assertSurfaceOverConversation,
  assertSurfaceShadow,
  authoritativeRoomMessages,
  messageSourceAssertion,
  sourceBody,
  sourceRoomName,
  type MessageSourceAssertion,
  type MessageSourceStage,
  type MessageSourceStageId,
  type SheetObservation,
  type SourceDialogObservation,
  type SourceEventExpectation,
  type TimelineObservation,
} from './message-source-contract.mts';
import {
  readAppliedProfile,
  readComposer,
  readSheet,
  readSourceDialog,
  readTimeline,
} from './message-source-observer.mts';
import {
  markMessageSourceDiagnosticsSafe,
  messageSourceSecrets,
  redactDiagnosticText,
  revokeMessageSourcePublicationOnAbort,
  runMessageSourceStageCleanup,
  scanMessageSourceArtifacts,
  scrubMessageSourceArtifacts,
  type MessageSourcePublicationSafety,
  type MessageSourceSecretIds,
} from './message-source-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const SEND = '[data-testid="composer-send"]';
const SHEET = '[role="dialog"][aria-label="Message actions"]';
const SHEET_SCROLL = `${SHEET} [data-testid="action-sheet-surface"] .overflow-y-auto`;
const VIEW_SOURCE = '[data-testid="sheet-view-source"]';
/** Reconciled message rows; the text filter picks one and is never logged. */
const READY_ROW = '.scroll .msg[data-mid^="$"]';

// Polling bounds: each is at least the predecessor's own bound.
const ROOM_OPEN_MS = 30_000;
const DRAFT_MS = 15_000;
const SEND_READY_MS = 20_000;
const RENDER_MS = 20_000;
const ECHO_MS = 20_000;
const EVENTS_MS = 20_000;
const SHEET_MS = 15_000;
const DIALOG_MS = 10_000;
/** Native in-sheet swipes allowed before View source must be reachable. */
const SHEET_SWIPES = 8;

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

/** The minimum a parity record or receipt needs; the guard drives it with a fake client. */
export interface RecordContext {
  readonly entry: MessageSourceStage;
  readonly records: MessageSourceAssertion[];
  /** Suite-wide identities, so a duplicate can never be emitted twice. */
  readonly identities: Set<string>;
  receipts: number;
  readonly client: Pick<AccountWorkspaceClient, 'record'>;
}

/** Every identifier the stage creates, registered before any UI step. */
interface SecretLedger {
  readonly run: string;
  account?: MessageSourceSecretIds['account'];
  room?: { id?: string; name?: string };
  readonly texts: string[];
  readonly eventIds: string[];
}

export interface MessageSourceStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: AccountFixtures;
  readonly secrets: Record<string, string>;
  readonly safety: MessageSourcePublicationSafety;
  readonly ledger: SecretLedger;
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
  const identity = messageSourceAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Message-source parity records stay in source order');
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
  assertMessageSourceReceiptName(name);
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

/** Merge identifiers into the stage ledger and register every form as a secret. */
function protect(
  context: MessageSourceStageContext,
  patch: {
    readonly account?: NodeWorkspaceAccount;
    readonly room?: { readonly id?: string; readonly name?: string };
    readonly texts?: readonly string[];
    readonly eventIds?: readonly string[];
  },
): void {
  const { ledger } = context;
  if (patch.account) {
    ledger.account = {
      userId: patch.account.userId,
      username: patch.account.username,
      password: patch.account.password,
    };
  }
  if (patch.room) ledger.room = { ...ledger.room, ...patch.room };
  ledger.texts.push(...(patch.texts ?? []));
  ledger.eventIds.push(...(patch.eventIds ?? []));
  Object.assign(context.secrets, messageSourceSecrets(context.entry.id, ledger));
}

/**
 * Lines 42–56 through real Synapse: one fresh Account and a private Room. The
 * message under test is never seeded; it is typed and sent natively below.
 */
async function arrangeSource(
  context: MessageSourceStageContext,
): Promise<{ readonly account: NodeWorkspaceAccount; readonly room: WorkspaceRoom }> {
  const { fixtures, ledger } = context;
  const name = sourceRoomName(ledger.run);
  protect(context, { room: { name }, texts: [sourceBody(ledger.run)] });
  const account = await fixtures.account('source-view-source');
  protect(context, { account });
  const room = await fixtures.createRoom(account, { name, preset: 'private_chat' });
  protect(context, { room: { id: room.id } });
  assert.equal(room.name, name, 'The Room carries the predecessor name template');
  return { account, room };
}

/** Reset to the Pixel 5 phone profile. */
async function startNative(context: MessageSourceStageContext): Promise<void> {
  assert(!context.safety.unsafeSecrets,
    'Every stage identifier is registered before any UI step');
  const { client } = context;
  await client.reset(PIXEL_5_ACCOUNT_PROFILE);
  context.native = true;
  const applied = await readAppliedProfile(client);
  await client.record('profile-applied', {
    profile: 'pixel-5',
    requested: PIXEL_5_ACCOUNT_PROFILE,
    digest: digest(JSON.stringify(PIXEL_5_ACCOUNT_PROFILE)),
    ...applied,
  });
}

/** Helper 18–26: tap the rail and the exact Room row, then prove its composer. */
async function openRoom(
  context: MessageSourceStageContext,
  room: WorkspaceRoom,
  account: NodeWorkspaceAccount,
): Promise<void> {
  const { client } = context;
  const identity = { name: room.name, roomId: room.id, userId: account.userId };
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: room.name }, ROOM_OPEN_MS);
  await client.tapCurrent('.channel', { text: room.name });
  await client.visible(COMPOSER, {}, ROOM_OPEN_MS);
  const composer = await readComposer(client, {
    accepts: passes((value) => assertRoomReady(value, identity)),
    description: 'exact Room composer and route after native open',
    timeoutMs: ROOM_OPEN_MS,
  });
  await record(context, 'room-ready', () => assertRoomReady(composer, identity), {
    composerVisible: composer.visible,
    exactPlaceholder: true,
    exactRoute: true,
    roomDigest: digest(room.id),
  });
}

/**
 * Lines 61–63 on a mobile device: a native tap focuses the composer, the
 * focused fill types the body behind the digit sentinel and the exact value is
 * read back; with the keyboard dismissed the composer's Send button is enabled
 * for the exact draft (helper line 53), then a native tap sends.
 */
export async function sendBodyNatively(
  context: MessageSourceStageContext,
  body: string,
): Promise<void> {
  const { client } = context;
  await client.focusCurrent(COMPOSER);
  await client.fillFocused(COMPOSER, body, BODY_SENTINEL);
  const typed = await readComposer(client, {
    accepts: passes((value) => assertNativeComposerValue(value, body)),
    description: 'exact native body in the composer',
    timeoutMs: DRAFT_MS,
  });
  assertNativeComposerValue(typed, body);
  await receipt(context, 'native-draft', { keys: ['fill'], exactValue: true });
  await client.hideKeyboard();
  const enabled = await readComposer(client, {
    accepts: passes((value) => assertSendEnabled(value, body)),
    description: 'Send button enabled with the keyboard dismissed',
    timeoutMs: SEND_READY_MS,
  });
  await record(context, 'send-enabled', () => assertSendEnabled(enabled, body), {
    exactDraft: true,
    sendEnabled: enabled.sendDisabled === false,
  });
  await client.tapCurrent(SEND);
  const cleared = await readComposer(client, {
    accepts: passes(assertDraftSent),
    description: 'composer cleared by the native send',
    timeoutMs: SEND_READY_MS,
  });
  assertDraftSent(cleared);
  await receipt(context, 'native-sent', { cleared: true });
}

async function timeline(
  client: AccountWorkspaceClient,
  check: (value: TimelineObservation) => unknown,
  description: string,
  timeoutMs: number,
): Promise<TimelineObservation> {
  return readTimeline(client, {
    accepts: passes((value) => { check(value); }),
    description,
    timeoutMs,
  });
}

async function sheet(
  client: AccountWorkspaceClient,
  check: (value: SheetObservation) => void,
  description: string,
): Promise<SheetObservation> {
  return readSheet(client, { accepts: passes(check), description, timeoutMs: SHEET_MS });
}

async function dialog(
  client: AccountWorkspaceClient,
  check: (value: SourceDialogObservation) => unknown,
  description: string,
): Promise<SourceDialogObservation> {
  return readSourceDialog(client, {
    accepts: passes((value) => { check(value); }),
    description,
    timeoutMs: DIALOG_MS,
  });
}

/** Read the Room from real Synapse until the one native send is exactly the expected event. */
async function serverEvent(
  context: MessageSourceStageContext,
  account: NodeWorkspaceAccount,
  room: WorkspaceRoom,
  expected: SourceEventExpectation,
): Promise<Readonly<Record<string, unknown>>> {
  const events = await waitForNativeShellState(
    async () => authoritativeRoomMessages(await context.fixtures.roomMessages(account, room.id)),
    passes((value) => { assertSourceRoom(value, expected); }),
    'authoritative native message event',
    context.client.signal,
    EVENTS_MS,
  );
  return assertSourceRoom(events, expected);
}

/** Reach View source through bounded native in-sheet swipes. */
async function reachViewSource(client: AccountWorkspaceClient): Promise<number> {
  for (let swipe = 0; swipe <= SHEET_SWIPES; swipe++) {
    const [action] = await client.waitElements(VIEW_SOURCE,
      (values) => values.length === 1, 'one View source action in the sheet',
      {}, SHEET_MS);
    const scroller = await client.visible(SHEET_SCROLL, {}, SHEET_MS);
    if (action!.visible && action!.unobstructedCenter &&
        action!.rect.y >= scroller.rect.y - 1 &&
        action!.rect.bottom <= scroller.rect.bottom + 1) return swipe;
    assert(swipe < SHEET_SWIPES, 'View source is reachable within the native swipe bound');
    await client.swipeCurrent(SHEET_SCROLL, { direction: 'increase-scroll-top' });
  }
  throw new Error('Native sheet scroll did not expose View source');
}

// The one stage: shows an event's raw JSON in the view-source dialog (31–105).

export async function runViewSource(context: MessageSourceStageContext): Promise<void> {
  const { client, ledger } = context;
  const { run } = ledger;
  const { account, room } = await arrangeSource(context);
  context.safety.unsafeSecrets = false;
  const body = sourceBody(run);
  await startNative(context);
  await client.login(account);
  await client.hideKeyboard();
  await openRoom(context, room, account);

  // Lines 61–63: the exact body, typed and sent natively.
  await sendBodyNatively(context, body);

  // Lines 64–66: the row, then its reconciled server event.
  const rowView = await timeline(client, (value) => assertRowVisible(value, body),
    'visible message row', RENDER_MS);
  const row = assertRowVisible(rowView, body);
  await record(context, 'row-visible', () => assertRowVisible(rowView, body), {
    visible: row.visible,
  });
  const echo = await timeline(client, (value) => assertServerEcho(value, body),
    'row reconciled to a server event', ECHO_MS);
  const eventId = assertServerEcho(echo, body).id;
  protect(context, { eventIds: [eventId] });
  await record(context, 'server-echo', () => assertServerEcho(echo, body), {
    serverId: eventId.startsWith('$'),
    eventDigest: digest(eventId),
  });
  const expected = { eventId, roomId: room.id, sender: account.userId, body };
  const authoritative = await serverEvent(context, account, room, expected);
  await receipt(context, 'message-event', {
    eventDigest: digest(eventId),
    roomDigest: digest(room.id),
    senderDigest: digest(account.userId),
    onlyMessage: true,
    exactBody: true,
    original: true,
  });

  // Lines 69–71: a native long press on the exact ready row, then View source.
  const target = await timeline(client, (value) => assertSameRow(value, body, eventId),
    'the one message row is the proved server event', RENDER_MS);
  assertSameRow(target, body, eventId);
  await client.hideKeyboard();
  await client.longPressCurrent(READY_ROW, { text: body });
  const opened = await sheet(client, assertNativeSheetReady, 'Android message-action sheet');
  await record(context, 'sheet-ready', () => assertNativeSheetReady(opened), {
    oneNativeSheet: opened.dialogs === 1,
    oneForwardAction: opened.forward.count === 1,
    oneViewSourceAction: opened.viewSource.count === 1,
  });
  const swipes = await reachViewSource(client);
  await client.tapCurrent(VIEW_SOURCE);
  const closed = await sheet(client, assertSheetClosed, 'sheet closed by View source');
  await receipt(context, 'view-source-picked', { openSheets: closed.dialogs, swipes });

  // Lines 77–81: one dialog whose strictly parsed JSON is the authoritative event.
  const shown = await dialog(client, assertDialogVisible, 'one visible message-source dialog');
  await record(context, 'dialog-visible', () => assertDialogVisible(shown), {
    dialogs: shown.dialogs,
    surfaces: shown.surfaces,
    visible: shown.surfaceVisible,
    jsonBlocks: shown.jsonElements,
  });
  const parsed = await dialog(client,
    (value) => assertJsonBody(value, authoritative, expected),
    'dialog JSON is exactly the authoritative event');
  await record(context, 'json-event', () => assertJsonEvent(parsed, authoritative, expected), {
    parsedObject: true,
    eventDigest: digest(eventId),
    roomDigest: digest(room.id),
    senderDigest: digest(account.userId),
    type: 'm.room.message',
    exactFields: ['event_id', 'type', 'sender', 'room_id'],
  });
  await record(context, 'json-body', () => assertJsonBody(parsed, authoritative, expected), {
    exactBody: true,
    exactContent: true,
  });

  // Lines 87–104: the measured surface paints a card of its own over the conversation.
  const painted = await dialog(client, assertSurfaceOverConversation,
    'measured message-source surface over the conversation');
  const { box, paint } = assertSurfaceOverConversation(painted);
  await receipt(context, 'surface-over-conversation', {
    width: box.width,
    height: box.height,
    intersectsConversation: true,
    topmostAtCenter: painted.centerInside,
  });
  await record(context, 'surface-opaque', () => { assertSurfaceOpaque(painted); }, {
    backgroundColor: paint.backgroundColor,
    alpha: assertSurfaceOpaque(painted),
  });
  await record(context, 'surface-border', () => { assertSurfaceBorder(painted); }, {
    borderTopWidth: paint.borderTopWidth,
    borderTopStyle: paint.borderTopStyle,
  });
  await record(context, 'surface-shadow', () => { assertSurfaceShadow(painted); }, {
    boxShadow: paint.boxShadow,
    visibleLayers: assertSurfaceShadow(painted),
  });
}

const STAGE_RUNNERS: Readonly<Record<
  MessageSourceStageId,
  (context: MessageSourceStageContext) => Promise<void>
>> = {
  'view-source': runViewSource,
};

interface StageReport {
  readonly id: MessageSourceStageId;
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
  assertions: MessageSourceAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 1;
  readonly expectedUniqueAssertions: 11;
  readonly expectedAssertionRecords: 11;
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
 * An error's message for the job log. Node appends an assertion's actual and
 * expected values to its message even when a custom message is given, and a
 * parsed dialog value may be an identifier that was never registered, so an
 * assertion keeps only its first line, or its operator when Node generated the
 * whole message.
 */
function jobLogMessage(error: Error): string {
  if (Reflect.get(error, 'code') !== 'ERR_ASSERTION') return error.message;
  if (Reflect.get(error, 'generatedMessage') === true)
    return `${String(Reflect.get(error, 'operator'))} assertion failed`;
  return error.message.split('\n')[0] ?? '';
}

/**
 * The error rethrown to the test reporter after a failed stage. The reporter
 * prints thrown errors, including assertion actual/expected values, to the
 * ungated job log, so rethrow only names and messages without appended values,
 * with every registered secret and event-id shape redacted. The complete text
 * stays in the scrubbed journeys.json.
 */
export function redactStageFailure(
  stageId: string,
  failures: readonly unknown[],
  secrets: Readonly<Record<string, string>>,
): Error {
  const lines: string[] = [];
  const visit = (value: unknown): void => {
    if (value instanceof AggregateError) {
      lines.push(`${value.name}: ${value.message}`);
      for (const nested of value.errors) visit(nested);
    } else if (value instanceof Error) {
      lines.push(`${value.name}: ${jobLogMessage(value)}`);
    } else {
      lines.push(typeof value);
    }
  };
  for (const failure of failures) visit(failure);
  return new Error(
    redactDiagnosticText(`Android message-source ${stageId} failed\n${lines.join('\n')}`, secrets),
  );
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
  return new Error(`Message-source cleanup failed: ${label} (${parts.join('; ')})`);
}

/** The run state a failed guarded cleanup marks before it rethrows. */
export interface GuardedCleanupState {
  readonly safety: MessageSourcePublicationSafety;
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
export function guardMessageSourceCleanup(
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
export async function runMessageSourceSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'message-source');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(MESSAGE_SOURCE_STAGES.length, 1, 'Message-source runs one stage');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 1,
          expectedUniqueAssertions: 11,
          expectedAssertionRecords: 11,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeMessageSourcePublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: MessageSourcePublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardMessageSourceCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan message-source diagnostics', () =>
          report.status === 'passed'
            ? markMessageSourceDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanMessageSourceArtifacts(output, secrets));
        guardedCleanup('Scrub message-source diagnostics', async () => {
          try { await scrubMessageSourceArtifacts(output, secrets); }
          catch (error) { safety.scrubFailed = true; throw error; }
        });
        try {
          const device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          guardedCleanup('Message-source Android device', () => device.close());
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
          for (const entry of MESSAGE_SOURCE_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: MessageSourceAssertion[] = [];
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
            console.info(`[message-source] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: MessageSourceStageContext = {
              entry,
              client,
              fixtures,
              secrets,
              safety,
              records,
              identities,
              receipts: 0,
              native: false,
              ledger: {
                run: `${resources.aliasLocalpart(`source-${entry.id}`)}${MESSAGE_SOURCE_RUN_SUFFIX}`,
                texts: [],
                eventIds: [],
              },
            };
            try {
              protect(context, {});
              await STAGE_RUNNERS[entry.id](context);
              assertMessageSourceRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              try { if (context.native) await client.capture('failed'); }
              catch (captureError) { failures.push(captureError); }
            } finally {
              const stageFailures = failures.length;
              await runMessageSourceStageCleanup([
                () => client.close(),
                () => device.clearApplicationData(APPLICATION_ID),
              ], failures);
              if (failures.length > stageFailures) safety.cleanupFailed = true;
              stage.assertions = [...records];
              stage.assertionRecords = records.length;
              stage.receipts = context.receipts;
              stage.durationMs = performance.now() - started;
              stage.failureCount = failures.length;
              stage.status = failures.length ? 'failed' : 'passed';
              if (failures.length) stage.error = failures.map(describeFailure).join('\n');
              await save();
              console.info(`[message-source] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, MESSAGE_SOURCE_ASSERTION_RECORDS,
            'Every message-source parity identity was emitted once');
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
  void test('Android message-source journeys', { timeout: 600_000 },
    runMessageSourceSuite);
}
