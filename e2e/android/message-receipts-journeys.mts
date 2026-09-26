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
  MESSAGE_RECEIPTS_ASSERTION_RECORDS,
  MESSAGE_RECEIPTS_RUN_SUFFIX,
  MESSAGE_RECEIPTS_STAGES,
  assertClusterVisible,
  assertJoined,
  assertMessageReceiptsReceiptName,
  assertMessageReceiptsRecords,
  assertReceiptRoom,
  assertRoomReady,
  assertSeerNamed,
  assertSeerReceipt,
  assertTextClear,
  authoritativeReadReceipts,
  authoritativeTimeline,
  messageReceiptsAssertion,
  receiptsAccountRole,
  receiptsBody,
  receiptsRoomName,
  receiptsSeerName,
  receiptsTransaction,
  type MessageReceiptsAssertion,
  type MessageReceiptsRole,
  type MessageReceiptsStage,
  type MessageReceiptsStageId,
  type ReceiptsViewObservation,
} from './message-receipts-contract.mts';
import {
  readAppliedProfile,
  readComposer,
  readReceipts,
} from './message-receipts-observer.mts';
import {
  markMessageReceiptsDiagnosticsSafe,
  messageReceiptsSecrets,
  redactSecretText,
  revokeMessageReceiptsPublicationOnAbort,
  runMessageReceiptsStageCleanup,
  scanMessageReceiptsArtifacts,
  scrubMessageReceiptsArtifacts,
  type MessageReceiptsPublicationSafety,
  type MessageReceiptsSecretIds,
} from './message-receipts-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';

// Polling bounds: each is at least the predecessor's own bound.
const ROOM_OPEN_MS = 30_000;
const CLUSTER_MS = 20_000;
const MATRIX_MS = 20_000;

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

/** The minimum a parity record or receipt needs; the guard drives it with a fake client. */
export interface RecordContext {
  readonly entry: MessageReceiptsStage;
  readonly records: MessageReceiptsAssertion[];
  /** Suite-wide identities, so a duplicate can never be emitted twice. */
  readonly identities: Set<string>;
  receipts: number;
  readonly client: Pick<AccountWorkspaceClient, 'record'>;
}

/** Every identifier a stage creates, registered before any UI step. */
interface SecretLedger {
  readonly run: string;
  accounts: NonNullable<MessageReceiptsSecretIds['accounts']>;
  room?: { id?: string; name?: string };
  readonly texts: string[];
  readonly eventIds: string[];
}

export interface MessageReceiptsStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: AccountFixtures;
  readonly secrets: Record<string, string>;
  readonly safety: MessageReceiptsPublicationSafety;
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
  const identity = messageReceiptsAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Message-receipts parity records stay in source order');
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
  assertMessageReceiptsReceiptName(name);
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
  context: MessageReceiptsStageContext,
  patch: {
    readonly account?: { readonly role: MessageReceiptsRole; readonly value: NodeWorkspaceAccount };
    readonly room?: { readonly id?: string; readonly name?: string };
    readonly texts?: readonly string[];
    readonly eventIds?: readonly string[];
  },
): void {
  const { ledger } = context;
  if (patch.account) {
    const { role, value } = patch.account;
    ledger.accounts = {
      ...ledger.accounts,
      [role]: { userId: value.userId, username: value.username, password: value.password },
    };
  }
  if (patch.room) ledger.room = { ...ledger.room, ...patch.room };
  ledger.texts.push(...(patch.texts ?? []));
  ledger.eventIds.push(...(patch.eventIds ?? []));
  Object.assign(context.secrets, messageReceiptsSecrets(context.entry.id, ledger));
}

interface ArrangedReceipt {
  readonly reader: NodeWorkspaceAccount;
  readonly author: NodeWorkspaceAccount;
  readonly seer: NodeWorkspaceAccount;
  readonly room: WorkspaceRoom;
  readonly seerName: string;
  readonly body: string;
  readonly eventId: string;
}

/**
 * Lines 57–110 through real Synapse: three fresh Accounts, the seer's exact
 * display name before any membership, the reader's Room with author and seer
 * joined, one author message and the seer's real `m.read` receipt for it.
 */
export async function arrangeReceipt(
  context: MessageReceiptsStageContext,
): Promise<ArrangedReceipt> {
  const { fixtures, ledger } = context;
  const { run } = ledger;
  const seerName = receiptsSeerName(run);
  const name = receiptsRoomName(run);
  const body = receiptsBody(run);
  protect(context, { room: { name }, texts: [seerName, body, receiptsTransaction(run)] });
  const reader = await fixtures.account(receiptsAccountRole('reader'));
  protect(context, { account: { role: 'reader', value: reader } });
  const author = await fixtures.account(receiptsAccountRole('author'));
  protect(context, { account: { role: 'author', value: author } });
  const seer = await fixtures.account(receiptsAccountRole('seer'));
  protect(context, { account: { role: 'seer', value: seer } });
  // Lines 77–81: the seer's name is set before the Room exists.
  await fixtures.setDisplayName(seer, seerName);
  const room = await fixtures.createRoom(reader, {
    name,
    invite: [author.userId, seer.userId],
  });
  protect(context, { room: { id: room.id } });
  assert.equal(room.name, name, 'The Room carries the predecessor name template');
  await fixtures.join(author, room.id);
  await fixtures.join(seer, room.id);
  const eventId = await fixtures.sendMessage(author, room.id, body, receiptsTransaction(run));
  protect(context, { eventIds: [eventId] });
  await fixtures.sendReadReceipt(seer, room.id, eventId);
  return { reader, author, seer, room, seerName, body, eventId };
}

/** Wait, within a finite bound, until one REST observation passes its check. */
async function matrixState<T>(
  context: MessageReceiptsStageContext,
  read: () => Promise<T>,
  check: (value: T) => void,
  description: string,
): Promise<T> {
  const value = await waitForNativeShellState(
    read, passes(check), description, context.client.signal, MATRIX_MS);
  check(value);
  return value;
}

/**
 * The seer's authoritative receipt relation, read independently as the reader:
 * exactly one unthreaded `m.read` receipt, on exactly the author event.
 */
async function seerReceipt(
  context: MessageReceiptsStageContext,
  arranged: ArrangedReceipt,
  description: string,
): Promise<ReturnType<typeof assertSeerReceipt>> {
  const expected = { seerId: arranged.seer.userId, eventId: arranged.eventId };
  const receipts = await matrixState(context,
    async () => authoritativeReadReceipts(
      await context.fixtures.roomReceipts(arranged.reader, arranged.room.id)),
    (value) => assertSeerReceipt(value, expected), description);
  return assertSeerReceipt(receipts, expected);
}

/**
 * D3: before any UI step, the Room timeline, current membership and receipt
 * relation are proved independently on real Synapse.
 */
export async function proveMatrixState(
  context: MessageReceiptsStageContext,
  arranged: ArrangedReceipt,
): Promise<{ readonly authorName: string; readonly readerName: string }> {
  const { fixtures } = context;
  const { reader, author, seer, room } = arranged;
  const expected = {
    roomId: room.id,
    readerId: reader.userId,
    authorId: author.userId,
    seerId: seer.userId,
    seerName: arranged.seerName,
    body: arranged.body,
    eventId: arranged.eventId,
  };
  const timeline = await matrixState(context,
    async () => authoritativeTimeline(await fixtures.roomMessages(reader, room.id)),
    (events) => { assertReceiptRoom(events, expected); },
    'authoritative receipt Room timeline');
  const names = assertReceiptRoom(timeline, expected);
  await receipt(context, 'message-event', {
    eventDigest: digest(arranged.eventId),
    fromAuthor: true,
    exactBody: true,
    original: true,
    messages: 1,
  });
  const memberships = await matrixState(context,
    async () => ({
      reader: await fixtures.roomMembership(reader, room.id, reader),
      author: await fixtures.roomMembership(reader, room.id, author),
      seer: await fixtures.roomMembership(reader, room.id, seer),
    }),
    assertJoined, 'authoritative receipt Room membership');
  assertJoined(memberships);
  await receipt(context, 'seer-membership', {
    roomDigest: digest(room.id),
    joined: ['reader', 'author', 'seer'],
    seerNamedBeforeJoin: true,
    seerJoins: 1,
  });
  const relation = await seerReceipt(context, arranged, 'authoritative seer read receipt');
  await receipt(context, 'receipt-relation', {
    eventDigest: digest(relation.eventId),
    type: 'm.read',
    unthreaded: true,
    seerReceipts: 1,
  });
  return names;
}

/** Reset to the predecessor's wide desktop profile. */
async function startNative(context: MessageReceiptsStageContext): Promise<void> {
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

/** Helper 40–48: tap the rail and the exact Room row, then prove its composer. */
async function openRoom(
  context: MessageReceiptsStageContext,
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

// Stage: the seer's avatar on the message they read (53–165).

export async function runSeenBy(context: MessageReceiptsStageContext): Promise<void> {
  const { client } = context;
  const arranged = await arrangeReceipt(context);
  context.safety.unsafeSecrets = false;
  const { reader, room, body, eventId, seerName } = arranged;
  const names = await proveMatrixState(context, arranged);
  const expectedName = {
    seerName,
    memberNames: [names.authorName, seerName],
    readerName: names.readerName,
  };

  // Lines 112–118: native login as the reader, then the exact Room.
  await startNative(context);
  await client.login(reader);
  await client.hideKeyboard();
  await openRoom(context, room, reader);

  // Lines 121–122: the Room's first receipt cluster, on the exact message row.
  const shown = await readReceipts(client, {
    accepts: passes((value: ReceiptsViewObservation) => {
      assertClusterVisible(value, body, eventId);
    }),
    description: 'the exact message row renders a visible receipt cluster',
    timeoutMs: CLUSTER_MS,
  });
  const visible = assertClusterVisible(shown, body, eventId);
  await record(context, 'cluster-visible', () => assertClusterVisible(shown, body, eventId), {
    visible: visible.visible,
    eventDigest: digest(eventId),
    roomFirstCluster: visible.firstInDocument,
    clusters: shown.clusters,
    avatars: visible.avatars,
  });

  // Lines 123–126: the same cluster's accessible name names the exact seer.
  const view = await readReceipts(client, {
    accepts: passes((value: ReceiptsViewObservation) => {
      assertSeerNamed(assertClusterVisible(value, body, eventId), expectedName);
    }),
    description: 'the exact message row cluster names the seer',
    timeoutMs: CLUSTER_MS,
  });
  const cluster = assertClusterVisible(view, body, eventId);
  const listed = assertSeerNamed(cluster, expectedName);
  await record(context, 'seer-named',
    () => assertSeerNamed(assertClusterVisible(view, body, eventId), expectedName), {
      seerListed: true,
      names: listed.length,
      avatars: cluster.avatars,
      readerListed: false,
    });

  // Lines 143–164: measured cluster and message-text boxes do not intersect.
  const clear = assertTextClear(cluster, body, eventId);
  await record(context, 'text-clear', () => assertTextClear(cluster, body, eventId), {
    intersects: clear.intersects,
    separatedBy: clear.separatedBy,
    cluster: cluster.box,
    text: cluster.text?.box ?? null,
  });

  // The rendering was proved against a relation that still holds.
  const retained = await seerReceipt(context, arranged, 'retained seer read receipt');
  await receipt(context, 'relation-retained', {
    eventDigest: digest(retained.eventId),
    seerReceipts: 1,
  });
}

const STAGE_RUNNERS: Readonly<Record<
  MessageReceiptsStageId,
  (context: MessageReceiptsStageContext) => Promise<void>
>> = {
  'seen-by': runSeenBy,
};

interface StageReport {
  readonly id: MessageReceiptsStageId;
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
  assertions: MessageReceiptsAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 1;
  readonly expectedUniqueAssertions: 4;
  readonly expectedAssertionRecords: 4;
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
  return publicStageFailure(`Android message-receipts ${stageId} failed`, failures,
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
  return new Error(`Message-receipts cleanup failed: ${label} (${parts.join('; ')})`);
}

/** The run state a failed guarded cleanup marks before it rethrows. */
export interface GuardedCleanupState {
  readonly safety: MessageReceiptsPublicationSafety;
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
export function guardMessageReceiptsCleanup(
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
export async function runMessageReceiptsSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'message-receipts');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(MESSAGE_RECEIPTS_STAGES.length, 1, 'Message-receipts runs one stage');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 1,
          expectedUniqueAssertions: 4,
          expectedAssertionRecords: 4,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeMessageReceiptsPublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: MessageReceiptsPublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardMessageReceiptsCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan message-receipts diagnostics', () =>
          report.status === 'passed'
            ? markMessageReceiptsDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanMessageReceiptsArtifacts(output, secrets));
        guardedCleanup('Scrub message-receipts diagnostics', async () => {
          try { await scrubMessageReceiptsArtifacts(output, secrets); }
          catch (error) { safety.scrubFailed = true; throw error; }
        });
        try {
          const device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          guardedCleanup('Message-receipts Android device', () => device.close());
          // Fixture cleanups register after the device, so they retire first.
          const resources = new MatrixTestResources(matrixResources.namespace);
          resources.cleanup = guardedCleanup;
          const fixtures = createAccountFixtures(resources, signal);
          await installWithAndroidRuntimeProvenance({
            device,
            applicationId: APPLICATION_ID,
            apk: join(session.workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk'),
            rendererManifest: join(session.workspaceRoot, 'dist/web-bundle-manifest.json'),
            profile: DESKTOP_ACCOUNT_PROFILE,
            output: join(output, 'runtime-provenance.json'),
          });
          const identities = new Set<string>();
          for (const entry of MESSAGE_RECEIPTS_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: MessageReceiptsAssertion[] = [];
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
            console.info(`[message-receipts] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: MessageReceiptsStageContext = {
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
                run: `${resources.aliasLocalpart(`receipts-${entry.id}`)}${MESSAGE_RECEIPTS_RUN_SUFFIX}`,
                accounts: {},
                texts: [],
                eventIds: [],
              },
            };
            try {
              protect(context, {});
              await STAGE_RUNNERS[entry.id](context);
              assertMessageReceiptsRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              try { if (context.native) await client.capture('failed'); }
              catch (captureError) { failures.push(captureError); }
            } finally {
              const stageFailures = failures.length;
              await runMessageReceiptsStageCleanup([
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
              console.info(`[message-receipts] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, MESSAGE_RECEIPTS_ASSERTION_RECORDS,
            'Every message-receipts parity identity was emitted once');
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
  void test('Android message-receipts journeys', { timeout: 600_000 },
    runMessageReceiptsSuite);
}
