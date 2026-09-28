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
import { createMessageUnreadFixtures } from './message-unread-fixture.mts';
import {
  MESSAGE_UNREAD_ASSERTION_RECORDS,
  MESSAGE_UNREAD_RUN_SUFFIX,
  MESSAGE_UNREAD_STAGES,
  SEEN_BODY,
  THREAD_ROOT_INDEX,
  UNREAD_COUNT,
  assertAtBottom,
  assertAutomaticOnly,
  assertConnectorAbove,
  assertConnectorBelow,
  assertDividerOffAbove,
  assertDividerStyled,
  assertDividerText,
  assertJumpHidden,
  assertJumpVisible,
  assertMessageUnreadReceiptName,
  assertMessageUnreadRecords,
  assertOneConnector,
  assertReducedMotionQuery,
  assertReducedScrolled,
  assertSmoothTrajectory,
  assertUnreadArrangement,
  authoritativeRoomMessages,
  classifyTrajectory,
  messageUnreadAssertion,
  parseTrajectory,
  transactionId,
  unreadBody,
  unreadRoomName,
  type MessageUnreadAssertion,
  type MessageUnreadStage,
  type MessageUnreadStageId,
  type TrajectorySample,
  type UnreadRoomKey,
  type UnreadView,
} from './message-unread-contract.mts';
import {
  readAppliedProfile,
  readSamplerExpression,
  readUnreadView,
  samplerKey,
  startSamplerExpression,
} from './message-unread-observer.mts';
import {
  markMessageUnreadDiagnosticsSafe,
  messageUnreadSecrets,
  redactDiagnosticText,
  revokeMessageUnreadPublicationOnAbort,
  runMessageUnreadStageCleanup,
  scanMessageUnreadArtifacts,
  scrubMessageUnreadArtifacts,
  type MessageUnreadPublicationSafety,
  type MessageUnreadSecretIds,
} from './message-unread-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { evaluateNative, waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const ANIMATOR = ['global', 'animator_duration_scale'] as const;

// Polling bounds: each is at least the predecessor's own bound.
const ROOM_OPEN_MS = 30_000;
const OBSERVE_MS = 20_000;
const REDUCED_MOTION_MS = 20_000;
const SAMPLER_MS = 50_000;

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type AccountFixtures = ReturnType<typeof createAccountFixtures>;
type UnreadFixtures = ReturnType<typeof createMessageUnreadFixtures>;

/** The minimum a parity record or receipt needs; the guard drives it with a fake client. */
export interface RecordContext {
  readonly entry: MessageUnreadStage;
  readonly records: MessageUnreadAssertion[];
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
  tokens: readonly string[];
}

export interface MessageUnreadStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: AccountFixtures;
  readonly unreadFixtures: UnreadFixtures;
  readonly secrets: Record<string, string>;
  readonly safety: MessageUnreadPublicationSafety;
  readonly ledger: SecretLedger;
  readonly signal: AbortSignal;
  /** The stage's own artifact directory, where `reduced-motion/feasibility.json` lands. */
  readonly directory: string;
  /** Set once `client.reset` has attached a WebView that can be captured. */
  native: boolean;
  /** Set before the `animator_duration_scale` write, so teardown always restores it. */
  animatorApplied: boolean;
  animatorPrior: string;
  /** Counts the passive samplers started, so every window key is used once. */
  samplers: number;
}

/** A parity identity is emitted only after its proof passed, in contract order. */
export async function record(
  context: RecordContext,
  suffix: string,
  assertion: () => void,
  observation: unknown,
): Promise<void> {
  const identity = messageUnreadAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Message-unread parity records stay in source order');
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
  assertMessageUnreadReceiptName(name);
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
  context: MessageUnreadStageContext,
  patch: {
    readonly accounts?: readonly NodeWorkspaceAccount[];
    readonly rooms?: readonly RoomLedgerEntry[];
    readonly texts?: readonly string[];
    readonly eventIds?: readonly string[];
    readonly transactions?: readonly string[];
    readonly tokens?: readonly string[];
  },
): void {
  const { ledger } = context;
  if (patch.accounts) ledger.accounts.push(...patch.accounts);
  if (patch.rooms) for (const room of patch.rooms) mergeRoom(ledger.rooms, room);
  ledger.texts.push(...(patch.texts ?? []));
  ledger.eventIds.push(...(patch.eventIds ?? []));
  ledger.transactions.push(...(patch.transactions ?? []));
  if (patch.tokens) ledger.tokens = patch.tokens;
  const ids: MessageUnreadSecretIds = {
    accounts: ledger.accounts.map(({ userId, username, password }) => ({ userId, username, password })),
    rooms: ledger.rooms,
    texts: ledger.texts,
    eventIds: ledger.eventIds,
    transactions: ledger.transactions,
    tokens: ledger.tokens,
  };
  Object.assign(context.secrets, messageUnreadSecrets(context.entry.id, ids));
}

interface ArrangedRoom {
  readonly room: WorkspaceRoom;
  readonly seen: string;
}

/**
 * Lines 97-154 through real Synapse, once per Room: `seen already`, both
 * reader markers on it, 14 unread messages and the thread reply rooted at
 * unread message 2.
 */
async function arrangeRoom(
  context: MessageUnreadStageContext,
  room: UnreadRoomKey,
  reader: NodeWorkspaceAccount,
  member: NodeWorkspaceAccount,
): Promise<ArrangedRoom> {
  const { fixtures, unreadFixtures, ledger } = context;
  const name = unreadRoomName(ledger.run, room);
  protect(context, { rooms: [{ name }] });
  const created = await fixtures.createRoom(reader, { name, invite: [member.userId] });
  protect(context, { rooms: [{ id: created.id }] });
  await fixtures.join(member, created.id);
  const txn = (part: string): string => {
    const id = transactionId(ledger.run, room, part);
    protect(context, { transactions: [id] });
    return id;
  };
  const seen = await fixtures.sendMessage(member, created.id, SEEN_BODY, txn('a'));
  protect(context, { eventIds: [seen] });
  await unreadFixtures.setReadMarkers(reader, created.id, seen);
  const unread: string[] = [];
  for (let i = 0; i < UNREAD_COUNT; i++) {
    const id = await fixtures.sendMessage(member, created.id, unreadBody(i), txn(`b${i}`));
    protect(context, { eventIds: [id] });
    unread.push(id);
  }
  const root = unread[THREAD_ROOT_INDEX]!;
  const thread = await unreadFixtures.sendThreadReply(reader, created.id, txn('thread'), root);
  protect(context, { eventIds: [thread], tokens: unreadFixtures.tokens() });
  const events = authoritativeRoomMessages(await fixtures.roomMessages(reader, created.id));
  assertUnreadArrangement(events, { readerId: reader.userId, memberId: member.userId, rootEventId: root });
  assert.equal(await unreadFixtures.fullyRead(reader, created.id), seen,
    'The reader has read up to the old message');
  await receipt(context, `arranged-${room}`, { events: 16, roomDigest: digest(created.id) });
  return { room: created, seen };
}

/** Before the stage: the emulator must already be in gesture navigation. */
async function assertGestureNavigation(context: MessageUnreadStageContext): Promise<void> {
  const mode = (await context.client.device.adb('shell', 'settings', 'get', 'secure', 'navigation_mode')).trim();
  await context.client.record('navigation-mode', { navigationMode: mode });
  assert.equal(mode, '2', 'The emulator uses gesture navigation mode 2');
}

/** The applied profile is read back after each launch and must be exactly Pixel 5. */
async function assertProfile(context: MessageUnreadStageContext, launch: 'reset' | 'relaunch'): Promise<void> {
  const applied = await readAppliedProfile(context.client);
  await context.client.record(`profile-applied-${launch}`, { requested: PIXEL_5_ACCOUNT_PROFILE, ...applied });
  assert(applied.innerWidth === PIXEL_5_ACCOUNT_PROFILE.width
    && applied.innerHeight === PIXEL_5_ACCOUNT_PROFILE.height
    && Math.abs(applied.devicePixelRatio - PIXEL_5_ACCOUNT_PROFILE.deviceScaleFactor!) < 1e-6
    && applied.coarsePointer,
  'The applied profile is Pixel 5');
}

/** Reset to the Pixel 5 phone profile and record the unsuffixed diagnostic baseline. */
async function startNative(context: MessageUnreadStageContext): Promise<void> {
  assert(!context.safety.unsafeSecrets,
    'Every stage identifier is registered before any UI step');
  const { client } = context;
  await client.reset(PIXEL_5_ACCOUNT_PROFILE);
  context.native = true;
  const applied = await readAppliedProfile(client);
  await client.record('profile-applied', {
    requested: PIXEL_5_ACCOUNT_PROFILE,
    digest: digest(JSON.stringify(PIXEL_5_ACCOUNT_PROFILE)),
    ...applied,
  });
  assert(applied.innerWidth === PIXEL_5_ACCOUNT_PROFILE.width
    && applied.innerHeight === PIXEL_5_ACCOUNT_PROFILE.height
    && Math.abs(applied.devicePixelRatio - PIXEL_5_ACCOUNT_PROFILE.deviceScaleFactor!) < 1e-6
    && applied.coarsePointer,
  'The applied profile is Pixel 5');
}

/** Restore `animator_duration_scale` to its exact prior value, then prove the readback. */
export async function restoreAnimatorDurationScale(
  client: Pick<AccountWorkspaceClient, 'device' | 'record'>, prior: string): Promise<void> {
  if (prior === 'null' || prior === '') await client.device.adb('shell', 'settings', 'delete', ...ANIMATOR);
  else await client.device.adb('shell', 'settings', 'put', ...ANIMATOR, prior);
  const now = (await client.device.adb('shell', 'settings', 'get', ...ANIMATOR)).trim();
  await client.record('animator-duration-scale-restored', { prior, now });
  assert.equal(now, prior === '' ? 'null' : prior, 'animator_duration_scale restored');
}

/**
 * D5: apply real reduced motion behind a hard feasibility gate. Returns the
 * prior `animator_duration_scale` value, for teardown.
 */
export async function applyReducedMotion(context: MessageUnreadStageContext): Promise<string> {
  const { client } = context;
  const prior = (await client.device.adb('shell', 'settings', 'get', ...ANIMATOR)).trim();
  context.animatorPrior = prior;
  context.animatorApplied = true;
  await client.device.adb('shell', 'settings', 'put', ...ANIMATOR, '0');
  await client.relaunch(PIXEL_5_ACCOUNT_PROFILE);
  await assertProfile(context, 'relaunch');
  await client.hideKeyboard();
  // D5: the live query must become true within the bound, or the gate fails
  // closed with a written marker. Whatever prevents the read (a genuine
  // timeout, an interrupted observation that exhausts its retries) leaves the
  // gate infeasible rather than surfacing a raw poll error.
  let reducedMotion = false;
  try {
    reducedMotion = await waitForNativeShellState(
      () => evaluateNative(client.webview, "matchMedia('(prefers-reduced-motion: reduce)').matches") as Promise<boolean>,
      (value) => value === true,
      'Android animator scale projected as reduced motion',
      context.signal,
      REDUCED_MOTION_MS,
    );
  } catch (error) {
    if (!(error instanceof Error && error.message.startsWith('Timed out waiting for'))) throw error;
  }
  const feasible = reducedMotion === true;
  await mkdir(join(context.directory, 'reduced-motion'), { recursive: true });
  await client.record('reduced-motion/feasibility', { feasible, prior, applied: '0', reducedMotion });
  assert(feasible, 'The reduced-motion feasibility gate is feasible');
  await record(context, 'reduced-motion-query', () => assertReducedMotionQuery(reducedMotion), { reducedMotion });
  return prior;
}

/** The divider lies inside the scroller's own box: the opposite of off-screen above. */
function assertDividerInView(view: UnreadView): void {
  assert(view.scroller, 'The scroller is measured');
  assert(view.divider, 'A divider is rendered');
  assert(view.divider.box.top + view.divider.box.height > view.scroller.box.top,
    'The divider is in view, not off-screen above');
}

/** Helper 18-26 (Task equivalent 59-67): tap the rail and the exact Room row. */
async function openRoom(
  context: MessageUnreadStageContext,
  arranged: ArrangedRoom,
  recordReady: boolean,
): Promise<void> {
  const { client } = context;
  const { room } = arranged;
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: room.name }, ROOM_OPEN_MS);
  await client.tapCurrent('.channel', { text: room.name });
  const composer = await client.visible('[data-testid="composer-input"]', {}, 15_000);
  const observation = { composerVisible: composer.visible, roomDigest: digest(room.id) };
  if (recordReady) {
    await record(context, 'room-ready',
      () => assert(composer.visible, 'The Room composer is visible after the native open'),
      observation);
  } else {
    await receipt(context, 'room-ready-reduced', observation);
  }
}

/** D4: start a fresh, never-reused sampler, tap natively, then wait for it to finish. */
async function sampleJump(
  context: MessageUnreadStageContext,
  selector: string,
): Promise<{ readonly samples: readonly TrajectorySample[] }> {
  const key = samplerKey(++context.samplers);
  assert.equal(await evaluateNative(context.client.webview, startSamplerExpression(key)), true,
    'The passive scroll sampler started');
  await context.client.tapCurrent(selector);
  const finished = await waitForNativeShellState(
    () => evaluateNative(context.client.webview, readSamplerExpression(key)),
    (value) => !!value && typeof value === 'object' && (value as { done?: unknown }).done === true,
    'sampler did not finish', context.signal, SAMPLER_MS);
  return { samples: parseTrajectory((finished as { samples: unknown }).samples) };
}

// The one stage: D6, the unread divider and jump-to-unread across two Rooms.

export async function runDividerJump(context: MessageUnreadStageContext): Promise<void> {
  const { client, fixtures, unreadFixtures } = context;

  const reader = await fixtures.account('unread-reader');
  protect(context, { accounts: [reader] });
  const member = await fixtures.account('unread-member');
  protect(context, { accounts: [member] });
  const roomA = await arrangeRoom(context, 'motion', reader, member);
  const roomB = await arrangeRoom(context, 'reduced', reader, member);
  context.safety.unsafeSecrets = false;

  await assertGestureNavigation(context);
  await startNative(context);
  await client.login(reader);
  await client.hideKeyboard();

  // Room A, default motion.
  await openRoom(context, roomA, true);
  const view = await readUnreadView(client);
  await record(context, 'divider-text', () => assertDividerText(view), {
    count: view.divider?.count, textContent: view.divider?.textContent,
  });
  await record(context, 'one-thread-connector', () => assertOneConnector(view), {
    connectorCount: view.divider?.connectorCount,
  });
  await record(context, 'connector-above', () => assertConnectorAbove(view), { above: view.divider?.above });
  await record(context, 'connector-below', () => assertConnectorBelow(view), { below: view.divider?.below });
  await record(context, 'divider-styled', () => assertDividerStyled(view), {
    display: view.divider?.display, alignItems: view.divider?.alignItems,
    fontWeight: view.divider?.fontWeight, ruleFlexGrow: view.divider?.ruleFlexGrow,
  });

  // Baseline: the reduced-motion query is false before the stage ever applies it.
  const baseline = await readUnreadView(client);
  assert.equal(baseline.reducedMotion, false, 'Baseline Android motion is not reduced');
  await receipt(context, 'reduced-motion-baseline', { reducedMotion: baseline.reducedMotion });

  const jumpView = await readUnreadView(client, {
    accepts: passes(assertJumpVisible), description: 'jump-to-unread pill visible', timeoutMs: OBSERVE_MS,
  });
  await record(context, 'jump-visible', () => assertJumpVisible(jumpView), {
    count: jumpView.jump.count, visible: jumpView.jump.visible,
  });

  const defaultJump = await sampleJump(context, '[data-testid="jump-to-unread"]');
  await client.record('trajectory-default', defaultJump.samples);
  const hiddenView = await readUnreadView(client, {
    accepts: passes(assertJumpHidden),
    description: 'jump-to-unread pill hidden after the native tap',
    timeoutMs: OBSERVE_MS,
  });
  await record(context, 'jump-hidden', () => assertJumpHidden(hiddenView), {
    count: hiddenView.jump.count, visible: hiddenView.jump.visible,
  });
  const defaultClass = classifyTrajectory(defaultJump.samples);
  await record(context, 'smooth-trajectory', () => assertSmoothTrajectory(defaultClass), {
    kind: defaultClass.kind, longestRun: defaultClass.longestRun, movements: defaultClass.movements,
  });

  const assertRoomBUnread = async (moment: string): Promise<void> => {
    assert.equal(await unreadFixtures.fullyRead(reader, roomB.room.id), roomB.seen,
      `Room B was read before the reduced-motion relaunch (${moment})`);
  };

  // Reduced motion.
  await assertRoomBUnread('before the reduced-motion relaunch');
  await applyReducedMotion(context);

  // Room B, reduced motion.
  await assertRoomBUnread('right before opening Room B');
  await openRoom(context, roomB, false);
  const roomBReady = await readUnreadView(client, {
    accepts: passes((value) => { assertJumpVisible(value); assertDividerOffAbove(value); }),
    description: 'Room B jump pill visible and divider off-screen above',
    timeoutMs: OBSERVE_MS,
  });
  await receipt(context, 'room-b-ready', {
    jumpVisible: roomBReady.jump.visible, dividerOffAbove: true,
  });

  const reducedFirst = await sampleJump(context, '[data-testid="jump-to-unread"]');
  await client.record('trajectory-reduced-first', reducedFirst.samples);
  const roomBHidden = await readUnreadView(client, {
    accepts: passes((value) => { assertJumpHidden(value); assertDividerInView(value); }),
    description: 'jump-to-unread pill hidden and the divider in view',
    timeoutMs: OBSERVE_MS,
  });
  await receipt(context, 'room-b-jump-hidden', {
    jumpHidden: roomBHidden.jump.count === 0 || !roomBHidden.jump.visible, dividerInView: true,
  });

  await client.tapCurrent('[data-testid="jump-to-latest"]');
  const bottomView = await readUnreadView(client, {
    accepts: passes(assertAtBottom), description: 'scroller at its bottom after jump-to-latest', timeoutMs: OBSERVE_MS,
  });
  await receipt(context, 'jump-to-latest-bottom', {
    atBottom: true, latestHidden: bottomView.latest.count === 0 || !bottomView.latest.visible,
  });

  const atLatestView = await readUnreadView(client, {
    accepts: passes(assertJumpVisible),
    description: 'jump-to-unread pill visible at the newest message',
    timeoutMs: OBSERVE_MS,
  });
  await record(context, 'jump-visible-at-latest', () => assertJumpVisible(atLatestView), {
    count: atLatestView.jump.count, visible: atLatestView.jump.visible,
  });

  const reducedJump = await sampleJump(context, '[data-testid="jump-to-unread"]');
  await client.record('trajectory-reduced', reducedJump.samples);
  const reducedHiddenView = await readUnreadView(client, {
    accepts: passes(assertJumpHidden),
    description: 'jump-to-unread pill hidden after the reduced-motion tap',
    timeoutMs: OBSERVE_MS,
  });
  await record(context, 'reduced-jump-hidden', () => assertJumpHidden(reducedHiddenView), {
    count: reducedHiddenView.jump.count, visible: reducedHiddenView.jump.visible,
  });
  const reducedClass = classifyTrajectory(reducedJump.samples);
  await record(context, 'reduced-scrolled', () => assertReducedScrolled(reducedClass), {
    movements: reducedClass.movements,
  });
  await record(context, 'automatic-only', () => assertAutomaticOnly(reducedClass), {
    kind: reducedClass.kind, longestRun: reducedClass.longestRun,
  });
}

const STAGE_RUNNERS: Readonly<Record<
  MessageUnreadStageId,
  (context: MessageUnreadStageContext) => Promise<void>
>> = {
  'divider-jump': runDividerJump,
};

interface StageReport {
  readonly id: MessageUnreadStageId;
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
  assertions: MessageUnreadAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 1;
  readonly expectedUniqueAssertions: 14;
  readonly expectedAssertionRecords: 14;
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
  return publicStageFailure(`Android message-unread ${stageId} failed`, failures,
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
  return new Error(`Message-unread cleanup failed: ${label} (${parts.join('; ')})`);
}

/** The run state a failed guarded cleanup marks before it rethrows. */
export interface GuardedCleanupState {
  readonly safety: MessageUnreadPublicationSafety;
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
export function guardMessageUnreadCleanup(
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
export async function runMessageUnreadSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'message-unread');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(MESSAGE_UNREAD_STAGES.length, 1, 'Message-unread runs one stage');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 1,
          expectedUniqueAssertions: 14,
          expectedAssertionRecords: 14,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeMessageUnreadPublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: MessageUnreadPublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardMessageUnreadCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan message-unread diagnostics', () =>
          report.status === 'passed'
            ? markMessageUnreadDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanMessageUnreadArtifacts(output, secrets));
        guardedCleanup('Scrub message-unread diagnostics', async () => {
          try { await scrubMessageUnreadArtifacts(output, secrets); }
          catch (error) { safety.scrubFailed = true; throw error; }
        });
        try {
          const device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          guardedCleanup('Message-unread Android device', () => device.close());
          // Fixture cleanups register after the device, so they retire first.
          const resources = new MatrixTestResources(matrixResources.namespace);
          resources.cleanup = guardedCleanup;
          const fixtures = createAccountFixtures(resources, signal);
          const unreadFixtures = createMessageUnreadFixtures(resources, signal);
          await installWithAndroidRuntimeProvenance({
            device,
            applicationId: APPLICATION_ID,
            apk: join(session.workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk'),
            rendererManifest: join(session.workspaceRoot, 'dist/web-bundle-manifest.json'),
            profile: PIXEL_5_ACCOUNT_PROFILE,
            output: join(output, 'runtime-provenance.json'),
          });
          const identities = new Set<string>();
          for (const entry of MESSAGE_UNREAD_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: MessageUnreadAssertion[] = [];
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
            console.info(`[message-unread] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: MessageUnreadStageContext = {
              entry,
              client,
              fixtures,
              unreadFixtures,
              secrets,
              safety,
              records,
              identities,
              receipts: 0,
              native: false,
              animatorApplied: false,
              animatorPrior: 'null',
              samplers: 0,
              directory,
              signal,
              ledger: {
                run: `${resources.aliasLocalpart(`unread-${entry.id}`)}${MESSAGE_UNREAD_RUN_SUFFIX}`,
                accounts: [],
                rooms: [],
                texts: [],
                eventIds: [],
                transactions: [],
                tokens: [],
              },
            };
            try {
              protect(context, {});
              await STAGE_RUNNERS[entry.id](context);
              assertMessageUnreadRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              try { if (context.native) await client.capture('failed'); }
              catch (captureError) { failures.push(captureError); }
            } finally {
              const stageFailures = failures.length;
              await runMessageUnreadStageCleanup([
                async () => { if (context.animatorApplied) await restoreAnimatorDurationScale(client, context.animatorPrior); },
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
              console.info(`[message-unread] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, MESSAGE_UNREAD_ASSERTION_RECORDS,
            'Every message-unread parity identity was emitted once');
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
  void test('Android message-unread journeys', { timeout: 900_000 }, runMessageUnreadSuite);
}
