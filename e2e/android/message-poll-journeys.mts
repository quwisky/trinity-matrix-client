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
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import {
  FIELD_SENTINEL,
  MESSAGE_POLL_ASSERTION_RECORDS,
  MESSAGE_POLL_OPTIONS,
  MESSAGE_POLL_RUN_SUFFIX,
  MESSAGE_POLL_STAGES,
  assertFinalResults,
  assertInsertTray,
  assertMessagePollReceiptName,
  assertMessagePollRecords,
  assertNoInlinePoll,
  assertOneHundredPercent,
  assertOneVote,
  assertPollChain,
  assertPollDialogOpen,
  assertPollDraft,
  assertPollQuestion,
  assertPollVisible,
  assertRoomReady,
  assertServerEcho,
  assertVoteReady,
  assertZeroVotes,
  authoritativePollEvents,
  messagePollAssertion,
  messagePollQuestion,
  messagePollRoomName,
  samePoll,
  type MessagePollAssertion,
  type MessagePollStage,
  type MessagePollStageId,
  type PollChainStep,
  type TimelineObservation,
} from './message-poll-contract.mts';
import {
  readAppliedProfile,
  readComposer,
  readPollDialog,
  readTimeline,
} from './message-poll-observer.mts';
import {
  markMessagePollDiagnosticsSafe,
  messagePollSecrets,
  redactSecretText,
  revokeMessagePollPublicationOnAbort,
  runMessagePollStageCleanup,
  scanMessagePollArtifacts,
  scrubMessagePollArtifacts,
  type MessagePollPublicationSafety,
  type MessagePollSecretIds,
} from './message-poll-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const TRAY_SHEET = '[role="dialog"][aria-label="Add to message"]';
const QUESTION = '[data-testid="poll-question"]';
const OPTION_FIELDS = [
  '[data-testid="poll-option-0"]',
  '[data-testid="poll-option-1"]',
] as const;

// Polling bounds: each is at least the predecessor's own bound.
const ROOM_OPEN_MS = 30_000;
const TRAY_MS = 15_000;
const DIALOG_MS = 15_000;
const RENDER_MS = 20_000;
const ECHO_MS = 20_000;
const CHAIN_MS = 20_000;
const TALLY_MS = 20_000;

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

/** The minimum a parity record or receipt needs; the guard drives it with a fake client. */
export interface RecordContext {
  readonly entry: MessagePollStage;
  readonly records: MessagePollAssertion[];
  /** Suite-wide identities, so a duplicate can never be emitted twice. */
  readonly identities: Set<string>;
  receipts: number;
  readonly client: Pick<AccountWorkspaceClient, 'record'>;
}

/** Every identifier the stage creates, registered before any UI step. */
interface SecretLedger {
  readonly run: string;
  account?: MessagePollSecretIds['account'];
  room?: { id?: string; name?: string };
  readonly eventIds: string[];
}

export interface MessagePollStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: AccountFixtures;
  readonly secrets: Record<string, string>;
  readonly safety: MessagePollPublicationSafety;
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
  const identity = messagePollAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Message-poll parity records stay in source order');
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
  assertMessagePollReceiptName(name);
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
  context: MessagePollStageContext,
  patch: {
    readonly account?: NodeWorkspaceAccount;
    readonly room?: { readonly id?: string; readonly name?: string };
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
  ledger.eventIds.push(...(patch.eventIds ?? []));
  Object.assign(context.secrets, messagePollSecrets(context.entry.id, ledger));
}

/**
 * Arrange one fresh Account and private Room through real Synapse. The poll,
 * its vote and its end are never seeded; they are made natively below.
 */
async function arrangeStage(
  context: MessagePollStageContext,
): Promise<{ readonly account: NodeWorkspaceAccount; readonly room: WorkspaceRoom }> {
  const { fixtures, ledger } = context;
  const name = messagePollRoomName(ledger.run);
  protect(context, { room: { name } });
  const account = await fixtures.account(`poll-${context.entry.id}`);
  protect(context, { account });
  const room = await fixtures.createRoom(account, { name, preset: 'private_chat' });
  protect(context, { room: { id: room.id } });
  assert.equal(room.name, name, 'The Room carries the predecessor name template');
  context.safety.unsafeSecrets = false;
  return { account, room };
}

/** Reset to the Pixel 5 phone profile. */
async function startNative(context: MessagePollStageContext): Promise<void> {
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

/** Helper 14–22: tap the rail and the exact Room row, then prove its composer. */
async function openRoom(
  context: MessagePollStageContext,
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
 * Lines 62–69: open the `+` tray sheet and its Poll action natively, type the
 * exact question and options through native input, and tap Create.
 */
export async function createPollNatively(
  context: MessagePollStageContext,
  question: string,
): Promise<void> {
  const { client } = context;
  await client.tapCurrent('[data-testid="composer-insert"]');
  const sheets = await client.waitElements(TRAY_SHEET,
    (values) => values.length === 1 && values[0]!.visible,
    'Add to message tray sheet', {}, TRAY_MS);
  const action = await client.visible('[data-testid="insert-poll"]', {}, TRAY_MS);
  await receipt(context, 'tray-open', {
    sheets: sheets.length,
    pollActionVisible: action.visible,
  });
  await client.tapCurrent('[data-testid="insert-poll"]');
  const opened = await readPollDialog(client, {
    accepts: passes(assertPollDialogOpen),
    description: 'Create poll dialog with its question autofocused',
    timeoutMs: DIALOG_MS,
  });
  assertPollDialogOpen(opened);
  await receipt(context, 'poll-dialog-open', {
    dialogs: opened.count,
    questionFocused: opened.questionFocused,
    optionFields: opened.options.length,
  });
  // The product autofocuses the question; the fill proves that focus first.
  await client.fillFocused(QUESTION, question, FIELD_SENTINEL);
  for (const [index, field] of OPTION_FIELDS.entries()) {
    await client.focusCurrent(field);
    await client.fillFocused(field, MESSAGE_POLL_OPTIONS[index]!, FIELD_SENTINEL);
  }
  const draft = await readPollDialog(client, {
    accepts: passes((value) => assertPollDraft(value, question)),
    description: 'exact native question and options with Create enabled',
    timeoutMs: DIALOG_MS,
  });
  assertPollDraft(draft, question);
  await receipt(context, 'poll-draft', {
    exactQuestion: true,
    options: draft.options.length,
    createEnabled: draft.createDisabled === false,
  });
  await client.tapCurrent('[data-testid="poll-create"]');
  const closed = await client.waitElements('[role="dialog"]',
    (values) => values.length === 0, 'Create poll dialog and tray closed', {}, DIALOG_MS);
  await receipt(context, 'poll-created', { openDialogs: closed.length });
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

/**
 * Read the Room like the predecessor's server truth would: the exact poll chain
 * up to `step`, from real Synapse, within a finite bound.
 */
async function serverPollChain(
  context: MessagePollStageContext,
  account: NodeWorkspaceAccount,
  room: WorkspaceRoom,
  step: PollChainStep,
  poll: { readonly pollId: string; readonly question: string },
): Promise<{ readonly responseId?: string; readonly endId?: string }> {
  const expected = { roomId: room.id, sender: account.userId, ...poll };
  const events = await waitForNativeShellState(
    async () => authoritativePollEvents(await context.fixtures.roomMessages(account, room.id)),
    passes((value) => { assertPollChain(value, step, expected); }),
    `authoritative poll chain up to ${step}`,
    context.client.signal,
    CHAIN_MS,
  );
  const ids = assertPollChain(events, step, expected);
  protect(context, {
    eventIds: [ids.responseId, ids.endId].filter(
      (id): id is string => id !== undefined && !context.ledger.eventIds.includes(id)),
  });
  return ids;
}

// The one stage: create, vote and end (27–92).

export async function runCreateVoteEnd(context: MessagePollStageContext): Promise<void> {
  const { client } = context;
  const { account, room } = await arrangeStage(context);
  const question = messagePollQuestion(context.ledger.run);
  await startNative(context);
  await client.login(account);
  await client.hideKeyboard();
  await openRoom(context, room, account);

  // Lines 59–60: the phone composer's `+` tray, and no inline Poll control.
  const composer = await readComposer(client, {
    accepts: passes((value) => { assertInsertTray(value); assertNoInlinePoll(value); }),
    description: 'closed insert tray trigger without an inline Poll control',
    timeoutMs: TRAY_MS,
  });
  await record(context, 'insert-tray', () => assertInsertTray(composer), {
    insertVisible: composer.insertVisible,
    insertDisabled: composer.insertDisabled,
    hasPopup: composer.insertHasPopup,
  });
  await record(context, 'no-inline-poll', () => assertNoInlinePoll(composer), {
    inlinePollCount: composer.inlinePollCount,
    trayPollCount: composer.trayPollCount,
  });

  await createPollNatively(context, question);

  // Lines 72–75: the poll renders with its exact question and no votes.
  const rendered = await timeline(client, (value) => {
    assertPollQuestion(assertPollVisible(value), question);
    assertZeroVotes(assertPollVisible(value));
  }, 'one visible poll with the exact question and 0 votes', RENDER_MS);
  const poll = assertPollVisible(rendered);
  await record(context, 'poll-visible', () => assertPollVisible(rendered), {
    visible: poll.visible,
    polls: rendered.pollCount,
  });
  await record(context, 'poll-question', () => assertPollQuestion(poll, question), {
    exactQuestion: true,
    options: poll.options.length,
  });
  await record(context, 'zero-votes', () => assertZeroVotes(poll), {
    total: poll.total,
  });

  // Line 80, helper 177–179: the poll row is the reconciled server event.
  const ready = await timeline(client, (value) => assertVoteReady(assertServerEcho(value)),
    'poll row reconciled to a server event with enabled options', ECHO_MS);
  const echo = assertServerEcho(ready);
  const pollId = echo.rowId;
  protect(context, { eventIds: [pollId] });
  await record(context, 'server-echo', () => assertServerEcho(ready), {
    serverId: pollId.startsWith('$'),
    eventDigest: digest(pollId),
  });
  const chain = { pollId, question };
  await serverPollChain(context, account, room, 'start', chain);
  assertVoteReady(echo);
  await receipt(context, 'poll-start-event', {
    eventDigest: digest(pollId),
    exactQuestion: true,
    answers: MESSAGE_POLL_OPTIONS.length,
    noResponseOrEnd: true,
    optionsEnabled: true,
  });

  // Lines 85–87: a native vote for Apple, proved on the wire, then the tally.
  await client.tapCurrent('[data-testid="poll"] .poll__option', { text: MESSAGE_POLL_OPTIONS[0] });
  const { responseId } = await serverPollChain(context, account, room, 'response', chain);
  assert(responseId, 'The native vote produced a poll response');
  await receipt(context, 'poll-response-event', {
    eventDigest: digest(responseId),
    relatesToPoll: true,
    answer: 'a0',
  });
  const tallied = await timeline(client,
    (value) => assertOneHundredPercent(assertOneVote(value, pollId)),
    'the same poll counts one Apple vote', TALLY_MS);
  const voted = assertOneVote(tallied, pollId);
  await record(context, 'one-vote', () => assertOneVote(tallied, pollId), {
    total: voted.total,
    samePoll: true,
  });
  await record(context, 'one-hundred-percent', () => assertOneHundredPercent(voted), {
    apple: voted.options[0]?.count ?? null,
    pear: voted.options[1]?.count ?? null,
    applePressed: voted.options[0]?.pressed ?? null,
  });

  // Lines 90–91: a native End, proved on the wire, then final and closed.
  assert.equal(samePoll(tallied, pollId).endCount, 1, 'One End control before the end');
  await client.tapCurrent('[data-testid="poll-end"]');
  const { endId } = await serverPollChain(context, account, room, 'end', chain);
  assert(endId, 'The native End produced a poll end');
  await receipt(context, 'poll-end-event', {
    eventDigest: digest(endId),
    relatesToPoll: true,
  });
  const ended = await timeline(client, (value) => assertFinalResults(value, pollId),
    'the same poll shows Final results with voting closed', TALLY_MS);
  const final = assertFinalResults(ended, pollId);
  await record(context, 'final-results', () => assertFinalResults(ended, pollId), {
    total: final.total,
    optionsDisabled: final.options.every((option) => option.disabled),
    endControls: final.endCount,
  });
}

const STAGE_RUNNERS: Readonly<Record<
  MessagePollStageId,
  (context: MessagePollStageContext) => Promise<void>
>> = {
  'create-vote-end': runCreateVoteEnd,
};

interface StageReport {
  readonly id: MessagePollStageId;
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
  assertions: MessagePollAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 1;
  readonly expectedUniqueAssertions: 10;
  readonly expectedAssertionRecords: 10;
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
  return publicStageFailure(`Android message-poll ${stageId} failed`, failures,
    (text) => redactSecretText(text, secrets));
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
  return new Error(`Message-poll cleanup failed: ${label} (${parts.join('; ')})`);
}

/** The run state a failed guarded cleanup marks before it rethrows. */
export interface GuardedCleanupState {
  readonly safety: MessagePollPublicationSafety;
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
export function guardMessagePollCleanup(
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
export async function runMessagePollSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'message-poll');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(MESSAGE_POLL_STAGES.length, 1, 'Message-poll runs one stage');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 1,
          expectedUniqueAssertions: 10,
          expectedAssertionRecords: 10,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeMessagePollPublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: MessagePollPublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardMessagePollCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan message-poll diagnostics', () =>
          report.status === 'passed'
            ? markMessagePollDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanMessagePollArtifacts(output, secrets));
        guardedCleanup('Scrub message-poll diagnostics', async () => {
          try { await scrubMessagePollArtifacts(output, secrets); }
          catch (error) { safety.scrubFailed = true; throw error; }
        });
        try {
          const device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          guardedCleanup('Message-poll Android device', () => device.close());
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
          for (const entry of MESSAGE_POLL_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: MessagePollAssertion[] = [];
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
            console.info(`[message-poll] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: MessagePollStageContext = {
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
                run: `${resources.aliasLocalpart(`poll-${entry.id}`)}${MESSAGE_POLL_RUN_SUFFIX}`,
                eventIds: [],
              },
            };
            try {
              protect(context, {});
              await STAGE_RUNNERS[entry.id](context);
              assertMessagePollRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              try { if (context.native) await client.capture('failed'); }
              catch (captureError) { failures.push(captureError); }
            } finally {
              const stageFailures = failures.length;
              await runMessagePollStageCleanup([
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
              console.info(`[message-poll] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, MESSAGE_POLL_ASSERTION_RECORDS,
            'Every message-poll parity identity was emitted once');
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
  void test('Android message-poll journey', { timeout: 900_000 },
    runMessagePollSuite);
}
