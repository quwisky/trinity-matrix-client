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
  DESKTOP_ACCOUNT_PROFILE,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import {
  MESSAGE_SPOILER_ASSERTION_RECORDS,
  MESSAGE_SPOILER_RUN_SUFFIX,
  MESSAGE_SPOILER_STAGES,
  assertBlackBar,
  assertCaptureScope,
  assertConcealedCapture,
  assertInitialTransparent,
  assertInitialUnrevealed,
  assertMessageSpoilerReceiptName,
  assertMessageSpoilerRecords,
  assertRevealed,
  assertRevealedCapture,
  assertRevealedPainted,
  assertRoomReady,
  assertSpoilerRoom,
  assertSpoilerVisible,
  authoritativeRoomMessages,
  messageSpoilerAssertion,
  spoilerContent,
  spoilerRoomName,
  spoilerSecret,
  spoilerTransaction,
  type MessageSpoilerAssertion,
  type MessageSpoilerStage,
  type MessageSpoilerStageId,
  type SpoilerExpectation,
  type SpoilerObservation,
} from './message-spoiler-contract.mts';
import { createMessageSpoilerFixtures } from './message-spoiler-fixture.mts';
import {
  readAppliedProfile,
  readComposer,
  readSpoiler,
} from './message-spoiler-observer.mts';
import {
  captureSpoilerLeaf,
  markMessageSpoilerDiagnosticsSafe,
  messageSpoilerSecrets,
  redactDiagnosticText,
  revokeMessageSpoilerPublicationOnAbort,
  runMessageSpoilerStageCleanup,
  scanMessageSpoilerArtifacts,
  scrubMessageSpoilerArtifacts,
  type MessageSpoilerPublicationSafety,
  type MessageSpoilerSecretIds,
} from './message-spoiler-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
/** Rendered spoiler leaves of reconciled rows; the exact-text filter picks one and is never logged. */
const SPOILER = '.scroll .msg[data-mid^="$"] .mx-spoiler';

// Polling bounds: each is at least the predecessor's own bound.
const ROOM_OPEN_MS = 30_000;
const EVENTS_MS = 20_000;
const LEAF_MS = 20_000;
const PAINT_MS = 10_000;
const FAILURE_CAPTURE_MS = 5_000;

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type AccountFixtures = ReturnType<typeof createAccountFixtures>;
type SpoilerFixtures = ReturnType<typeof createMessageSpoilerFixtures>;

/** The minimum a parity record or receipt needs; the guard drives it with a fake client. */
export interface RecordContext {
  readonly entry: MessageSpoilerStage;
  readonly records: MessageSpoilerAssertion[];
  /** Suite-wide identities, so a duplicate can never be emitted twice. */
  readonly identities: Set<string>;
  receipts: number;
  readonly client: Pick<AccountWorkspaceClient, 'record'>;
}

/** Every identifier the stage creates, registered before any UI step. */
interface SecretLedger {
  readonly run: string;
  account?: MessageSpoilerSecretIds['account'];
  room?: { id?: string; name?: string };
  readonly texts: string[];
  readonly eventIds: string[];
}

export interface MessageSpoilerStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: AccountFixtures;
  readonly spoilers: SpoilerFixtures;
  readonly secrets: Record<string, string>;
  readonly safety: MessageSpoilerPublicationSafety;
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
  const identity = messageSpoilerAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Message-spoiler parity records stay in source order');
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
  assertMessageSpoilerReceiptName(name);
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
  context: MessageSpoilerStageContext,
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
  Object.assign(context.secrets, messageSpoilerSecrets(context.entry.id, ledger));
}

interface ArrangedSpoiler {
  readonly account: NodeWorkspaceAccount;
  readonly room: WorkspaceRoom;
  readonly expected: SpoilerExpectation;
}

/**
 * Lines 20–69 through real Synapse: one fresh Account, its Room (no preset, as
 * line 46 sends none) and exactly one formatted spoiler message.
 */
async function arrangeSpoiler(context: MessageSpoilerStageContext): Promise<ArrangedSpoiler> {
  const { fixtures, spoilers, ledger } = context;
  const name = spoilerRoomName(ledger.run);
  const secret = spoilerSecret(ledger.run);
  const content = spoilerContent(secret);
  const transaction = spoilerTransaction(ledger.run);
  protect(context, { room: { name }, texts: [content.body, secret, transaction] });
  const account = await fixtures.account('spoiler-reveal');
  protect(context, { account });
  const room = await fixtures.createRoom(account, { name });
  protect(context, { room: { id: room.id } });
  assert.equal(room.name, name, 'The Room carries the predecessor name template');
  const eventId = await spoilers.sendSpoiler(account, room.id, transaction, content);
  protect(context, { eventIds: [eventId] });
  return { account, room, expected: { eventId, roomId: room.id, sender: account.userId, secret } };
}

/** Read the Room from real Synapse until it holds exactly the arranged spoiler event. */
async function proveSpoilerEvent(
  context: MessageSpoilerStageContext,
  arranged: ArrangedSpoiler,
): Promise<void> {
  const { account, room, expected } = arranged;
  const events = await waitForNativeShellState(
    async () => authoritativeRoomMessages(await context.fixtures.roomMessages(account, room.id)),
    passes((value) => { assertSpoilerRoom(value, expected); }),
    'authoritative spoiler message event',
    context.client.signal,
    EVENTS_MS,
  );
  assertSpoilerRoom(events, expected);
  await receipt(context, 'spoiler-event', {
    eventDigest: digest(expected.eventId),
    roomDigest: digest(room.id),
    onlyMessage: true,
    exactContent: true,
    spoilerSpans: 1,
    original: true,
  });
}

/** Reset to the predecessor's wide desktop profile. */
async function startNative(context: MessageSpoilerStageContext): Promise<void> {
  assert(!context.safety.unsafeSecrets,
    'Every stage identifier is registered before any UI step');
  const { client } = context;
  await client.reset(DESKTOP_ACCOUNT_PROFILE);
  context.native = true;
  const applied = await readAppliedProfile(client);
  await client.record('profile-applied', {
    profile: 'desktop',
    requested: DESKTOP_ACCOUNT_PROFILE,
    digest: digest(JSON.stringify(DESKTOP_ACCOUNT_PROFILE)),
    ...applied,
  });
}

/** Helper 71–79: tap the rail and the exact Room row, then prove its composer. */
async function openRoom(
  context: MessageSpoilerStageContext,
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

async function leaf(
  client: AccountWorkspaceClient,
  check: (value: SpoilerObservation) => unknown,
  description: string,
  timeoutMs: number,
): Promise<SpoilerObservation> {
  return readSpoiler(client, {
    accepts: passes((value) => { check(value); }),
    description,
    timeoutMs,
  });
}

/** An id-free summary of the one measured leaf for a record. */
function leafEvidence(view: SpoilerObservation, eventId: string): Record<string, unknown> {
  const [first] = view.leaves;
  return {
    leaves: view.leaves.length,
    eventDigest: digest(eventId),
    exactSecret: true,
    revealed: first?.revealed ?? null,
    visible: first?.visible ?? null,
    width: first?.box.width ?? null,
    height: first?.box.height ?? null,
  };
}

// The one stage: conceals a spoiler and reveals it on click (84–110).

export async function runConcealReveal(context: MessageSpoilerStageContext): Promise<void> {
  const { client } = context;
  const arranged = await arrangeSpoiler(context);
  context.safety.unsafeSecrets = false;
  const { account, room, expected } = arranged;
  await proveSpoilerEvent(context, arranged);

  // Lines 95–96: native login, then the exact Room.
  await startNative(context);
  await client.login(account);
  await client.hideKeyboard();
  await openRoom(context, room, account);

  // Lines 100–104: the one rendered leaf begins concealed and painted transparent.
  const shown = await leaf(client, (value) => assertSpoilerVisible(value, expected),
    'one visible rendered spoiler leaf', LEAF_MS);
  await record(context, 'spoiler-visible', () => assertSpoilerVisible(shown, expected),
    leafEvidence(shown, expected.eventId));
  const unrevealed = await leaf(client, (value) => assertInitialUnrevealed(value, expected),
    'the leaf begins without the revealed state', PAINT_MS);
  await record(context, 'initial-unrevealed', () => assertInitialUnrevealed(unrevealed, expected),
    leafEvidence(unrevealed, expected.eventId));
  const concealed = await leaf(client, (value) => assertInitialTransparent(value, expected),
    'the unrevealed leaf paints transparent text', PAINT_MS);
  await record(context, 'initial-transparent', () => { assertInitialTransparent(concealed, expected); }, {
    color: concealed.leaves[0]!.color,
    alpha: assertInitialTransparent(concealed, expected),
  });
  const barred = await leaf(client, (value) => assertConcealedCapture(value, expected),
    'the settled concealed leaf in capture scope', PAINT_MS);
  await receipt(context, 'black-bar', {
    backgroundColor: barred.leaves[0]!.backgroundColor,
    alpha: assertBlackBar(barred, expected),
  });
  const concealedClip = assertConcealedCapture(barred, expected);
  const concealedCapture = await captureSpoilerLeaf(client, 'concealed', concealedClip,
    barred.leaves[0]!);
  await receipt(context, 'concealed-capture', {
    sha256: concealedCapture.sha256,
    width: concealedCapture.width,
    height: concealedCapture.height,
    scope: concealedCapture.scope,
    meanLuminance: concealedCapture.meanLuminance,
  });

  // Line 106: native activation of the exact leaf.
  await client.tapCurrent(SPOILER, { exactText: expected.secret });
  await receipt(context, 'native-tap', { trustedClickInsideLeaf: true });

  // Lines 108–109: the same leaf gains the revealed state and paints its text.
  const revealed = await leaf(client, (value) => assertRevealed(value, expected),
    'the same leaf gains the revealed state', PAINT_MS);
  await record(context, 'revealed', () => assertRevealed(revealed, expected),
    leafEvidence(revealed, expected.eventId));
  const painted = await leaf(client, (value) => assertRevealedPainted(value, expected),
    'the revealed leaf paints its text', PAINT_MS);
  await record(context, 'revealed-painted', () => { assertRevealedPainted(painted, expected); }, {
    color: painted.leaves[0]!.color,
    alpha: assertRevealedPainted(painted, expected),
  });
  const settled = await leaf(client, (value) => assertRevealedCapture(value, expected),
    'the settled revealed leaf in capture scope', PAINT_MS);
  const revealedClip = assertRevealedCapture(settled, expected);
  const revealedCapture = await captureSpoilerLeaf(client, 'revealed', revealedClip,
    settled.leaves[0]!);
  await receipt(context, 'revealed-capture', {
    sha256: revealedCapture.sha256,
    width: revealedCapture.width,
    height: revealedCapture.height,
    scope: revealedCapture.scope,
    meanLuminance: revealedCapture.meanLuminance,
  });
}

/**
 * The failure capture: the one leaf, only when it is still in capture scope.
 * Otherwise an id-free record says why no scoped raster exists.
 */
export async function captureFailedLeaf(context: MessageSpoilerStageContext): Promise<void> {
  const { client } = context;
  const view = await readSpoiler(client, {
    description: 'the spoiler leaf for the failure capture',
    timeoutMs: FAILURE_CAPTURE_MS,
  });
  let clip;
  try {
    clip = assertCaptureScope(view);
  } catch {
    await client.record('spoiler-failed-capture', { captured: false, leaves: view.leaves.length });
    return;
  }
  const captured = await captureSpoilerLeaf(client, 'failed', clip,
    view.leaves[0]!);
  await client.record('spoiler-failed-capture', {
    captured: true,
    revealed: view.leaves[0]!.revealed,
    sha256: captured.sha256,
  });
}

const STAGE_RUNNERS: Readonly<Record<
  MessageSpoilerStageId,
  (context: MessageSpoilerStageContext) => Promise<void>
>> = {
  'conceal-reveal': runConcealReveal,
};

interface StageReport {
  readonly id: MessageSpoilerStageId;
  readonly source: string;
  readonly title: string;
  readonly profile: 'desktop';
  status: 'running' | 'passed' | 'failed';
  durationMs: number;
  readonly artifact: string;
  readonly attempt: 1;
  readonly retries: 0;
  readonly expectedAssertionRecords: number;
  assertionRecords: number;
  assertions: MessageSpoilerAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 1;
  readonly expectedUniqueAssertions: 6;
  readonly expectedAssertionRecords: 6;
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
  return publicStageFailure(`Android message-spoiler ${stageId} failed`, failures,
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
  return new Error(`Message-spoiler cleanup failed: ${label} (${parts.join('; ')})`);
}

/** The run state a failed guarded cleanup marks before it rethrows. */
export interface GuardedCleanupState {
  readonly safety: MessageSpoilerPublicationSafety;
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
export function guardMessageSpoilerCleanup(
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
export async function runMessageSpoilerSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'message-spoiler');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(MESSAGE_SPOILER_STAGES.length, 1, 'Message-spoiler runs one stage');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 1,
          expectedUniqueAssertions: 6,
          expectedAssertionRecords: 6,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeMessageSpoilerPublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: MessageSpoilerPublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardMessageSpoilerCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan message-spoiler diagnostics', () =>
          report.status === 'passed'
            ? markMessageSpoilerDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanMessageSpoilerArtifacts(output, secrets));
        guardedCleanup('Scrub message-spoiler diagnostics', async () => {
          try { await scrubMessageSpoilerArtifacts(output, secrets); }
          catch (error) { safety.scrubFailed = true; throw error; }
        });
        try {
          const device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          guardedCleanup('Message-spoiler Android device', () => device.close());
          // Fixture cleanups register after the device, so they retire first.
          const resources = new MatrixTestResources(matrixResources.namespace);
          resources.cleanup = guardedCleanup;
          const fixtures = createAccountFixtures(resources, signal);
          // The spoiler session registers last, so it logs out before the Room leave.
          const spoilers = createMessageSpoilerFixtures(resources, signal);
          await installWithAndroidRuntimeProvenance({
            device,
            applicationId: APPLICATION_ID,
            apk: join(session.workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk'),
            rendererManifest: join(session.workspaceRoot, 'dist/web-bundle-manifest.json'),
            profile: DESKTOP_ACCOUNT_PROFILE,
            output: join(output, 'runtime-provenance.json'),
          });
          const identities = new Set<string>();
          for (const entry of MESSAGE_SPOILER_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: MessageSpoilerAssertion[] = [];
            const stage: StageReport = {
              id: entry.id,
              source: entry.source,
              title: entry.title,
              profile: 'desktop',
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
            console.info(`[message-spoiler] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: MessageSpoilerStageContext = {
              entry,
              client,
              fixtures,
              spoilers,
              secrets,
              safety,
              records,
              identities,
              receipts: 0,
              native: false,
              ledger: {
                run: `${resources.aliasLocalpart('spoiler-reveal')}${MESSAGE_SPOILER_RUN_SUFFIX}`,
                texts: [],
                eventIds: [],
              },
            };
            try {
              protect(context, {});
              await STAGE_RUNNERS[entry.id](context);
              assertMessageSpoilerRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              if (context.native) {
                try { await captureFailedLeaf(context); }
                catch (captureError) { failures.push(captureError); }
                try { await client.capture('failed'); }
                catch (captureError) { failures.push(captureError); }
              }
            } finally {
              const stageFailures = failures.length;
              await runMessageSpoilerStageCleanup([
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
              console.info(`[message-spoiler] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, MESSAGE_SPOILER_ASSERTION_RECORDS,
            'Every message-spoiler parity identity was emitted once');
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
  void test('Android message-spoiler journeys', { timeout: 600_000 },
    runMessageSpoilerSuite);
}
