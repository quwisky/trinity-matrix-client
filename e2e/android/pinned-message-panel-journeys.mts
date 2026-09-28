import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  HOLD_MS,
  HOLD_READS,
  PINNED_PANEL_ASSERTION_RECORDS,
  PINNED_PANEL_RUN_SUFFIX,
  PINNED_PANEL_STAGES,
  SETTLE_GAP_MS,
  assertHeaderHeightsEqual,
  assertHeaderNamesRoom,
  assertHeldAfterUnpin,
  assertItemCount,
  assertMeasured,
  assertOpenPinnedHidden,
  assertPanelVisible,
  assertPinOrder,
  assertPinnedArrangement,
  assertPinnedPanelReceiptName,
  assertPinnedPanelRecords,
  assertServerPins,
  assertTitleCentred,
  assertTitleInset,
  assertUnpinTarget,
  authoritativeRoomMessages,
  geometrySettled,
  keepBody,
  pinnedPanelAssertion,
  pinnedRoomName,
  unpinBody,
  type PinnedPanelAssertion,
  type PinnedPanelStage,
  type PinnedPanelStageId,
  type PinnedView,
} from './pinned-message-panel-contract.mts';
import {
  readAppliedProfile,
  readPinnedView,
  type PinnedTexts,
} from './pinned-message-panel-observer.mts';
import {
  markPinnedPanelDiagnosticsSafe,
  pinnedPanelSecrets,
  redactDiagnosticText,
  revokePinnedPanelPublicationOnAbort,
  runPinnedPanelStageCleanup,
  scanPinnedPanelArtifacts,
  scrubPinnedPanelArtifacts,
  type PinnedPanelPublicationSafety,
  type PinnedPanelSecretIds,
} from './pinned-message-panel-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';

// Polling bounds: each is at least the predecessor's own bound.
const ROOM_OPEN_MS = 30_000;   // line 113
const MENU_MS = 20_000;
const PANEL_MS = 30_000;       // line 119
const OBSERVE_MS = 20_000;     // Playwright's 5 s default, widened for host load
const UNPIN_MS = 30_000;       // line 155

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

/** The minimum a parity record or receipt needs; the guard drives it with a fake client. */
export interface RecordContext {
  readonly entry: PinnedPanelStage;
  readonly records: PinnedPanelAssertion[];
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

export interface PinnedPanelStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: AccountFixtures;
  readonly secrets: Record<string, string>;
  readonly safety: PinnedPanelPublicationSafety;
  readonly ledger: SecretLedger;
  readonly signal: AbortSignal;
  /** The stage's own artifact directory. */
  readonly directory: string;
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
  const identity = pinnedPanelAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Pinned-panel parity records stay in source order');
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
  assertPinnedPanelReceiptName(name);
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
  context: PinnedPanelStageContext,
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
  const ids: PinnedPanelSecretIds = {
    accounts: ledger.accounts.map(({ userId, username, password }) => ({ userId, username, password })),
    rooms: ledger.rooms,
    texts: ledger.texts,
    eventIds: ledger.eventIds,
    transactions: ledger.transactions,
  };
  Object.assign(context.secrets, pinnedPanelSecrets(context.entry.id, ids));
}

interface Arranged { readonly room: WorkspaceRoom; readonly unpinId: string; readonly keepId: string;
  readonly texts: PinnedTexts }

/** Lines 44–83 through real Synapse; every identifier is registered as it becomes known. */
async function arrange(context: PinnedPanelStageContext, pinner: NodeWorkspaceAccount): Promise<Arranged> {
  const { fixtures, ledger } = context;
  const texts = { roomName: pinnedRoomName(ledger.run), unpinBody: unpinBody(ledger.run), keepBody: keepBody(ledger.run) };
  protect(context, { rooms: [{ name: texts.roomName }], texts: [texts.unpinBody, texts.keepBody],
    transactions: [texts.unpinBody, texts.keepBody] });
  const room = await fixtures.createRoom(pinner, { name: texts.roomName, preset: 'private_chat' });
  protect(context, { rooms: [{ id: room.id }] });
  // Line 71: the transaction id is the body.
  const unpinId = await fixtures.sendMessage(pinner, room.id, texts.unpinBody, texts.unpinBody);
  protect(context, { eventIds: [unpinId] });
  const keepId = await fixtures.sendMessage(pinner, room.id, texts.keepBody, texts.keepBody);
  protect(context, { eventIds: [keepId] });
  await fixtures.setRoomState(pinner, room.id, 'm.room.pinned_events', { pinned: [unpinId, keepId] }, '');
  const events = authoritativeRoomMessages(await fixtures.roomMessages(pinner, room.id));
  const state = await fixtures.roomState(pinner, room.id, 'm.room.pinned_events', '');
  assertPinnedArrangement(events, state ?? {}, { pinnerId: pinner.userId, ...texts, unpinId, keepId });
  await receipt(context, 'arranged', { messages: 2, pins: ['unpin', 'keep'], roomDigest: digest(room.id) });
  return { room, unpinId, keepId, texts };
}

const view = (context: PinnedPanelStageContext, a: Arranged, accepts: (v: PinnedView) => boolean,
  timeoutMs: number, description: string): Promise<PinnedView> =>
  readPinnedView(context.client, a.texts, { accepts, timeoutMs, description });

/**
 * Poll toward `accepts`; on a genuine timeout, resolve with the last observed
 * reading instead of a raw poll-timeout error, so the caller's own assertion
 * (`assertPanelVisible`, `assertItemCount`) produces a precise diagnostic.
 */
async function settle(
  context: PinnedPanelStageContext, a: Arranged, accepts: (v: PinnedView) => boolean,
  timeoutMs: number, description: string,
): Promise<PinnedView> {
  let last: PinnedView | undefined;
  try {
    return await view(context, a, (v) => { last = v; return accepts(v); }, timeoutMs, description);
  } catch (error) {
    if (last && error instanceof Error && error.message.startsWith('Timed out waiting for')) return last;
    throw error;
  }
}

/** D5: two identical, non-animating reads ≥ 500 ms apart, within 20 s of record 2. */
async function settledGeometry(context: PinnedPanelStageContext, a: Arranged): Promise<PinnedView> {
  const deadline = Date.now() + OBSERVE_MS;
  let previous = { at: Date.now(), view: await readPinnedView(context.client, a.texts) };
  while (Date.now() < deadline) {
    await delay(SETTLE_GAP_MS, undefined, { signal: context.signal });
    const current = { at: Date.now(), view: await readPinnedView(context.client, a.texts) };
    if (geometrySettled(previous, current)) return current.view;
    previous = current;
  }
  throw new assert.AssertionError({ message: 'panel geometry did not settle' });
}

/** The one predicate the launch must satisfy: the applied profile is exactly Pixel 5. */
function isPixel5Profile(applied: Awaited<ReturnType<typeof readAppliedProfile>>): boolean {
  return applied.innerWidth === PIXEL_5_ACCOUNT_PROFILE.width
    && applied.innerHeight === PIXEL_5_ACCOUNT_PROFILE.height
    && Math.abs(applied.devicePixelRatio - PIXEL_5_ACCOUNT_PROFILE.deviceScaleFactor!) < 1e-6
    && applied.coarsePointer
    && applied.hoverNone
    && applied.platform === 'android';
}

/** The applied profile is read back after reset and must be exactly Pixel 5. */
async function assertProfile(
  context: PinnedPanelStageContext, launch: 'reset',
): Promise<Awaited<ReturnType<typeof readAppliedProfile>>> {
  const applied = await readAppliedProfile(context.client);
  await context.client.record(`profile-applied-${launch}`, { requested: PIXEL_5_ACCOUNT_PROFILE, ...applied });
  assert(isPixel5Profile(applied), 'The applied profile is Pixel 5');
  return applied;
}

/** Reset to the Pixel 5 phone profile and record the unsuffixed diagnostic baseline. */
async function startNative(context: PinnedPanelStageContext): Promise<void> {
  assert(!context.safety.unsafeSecrets,
    'Every stage identifier is registered before any UI step');
  const { client } = context;
  await client.reset(PIXEL_5_ACCOUNT_PROFILE);
  context.native = true;
  const applied = await assertProfile(context, 'reset');
  await client.record('profile-applied', {
    requested: PIXEL_5_ACCOUNT_PROFILE,
    digest: digest(JSON.stringify(PIXEL_5_ACCOUNT_PROFILE)),
    ...applied,
  });
}

export function pinnedPanelTeardown(
  client: Pick<AccountWorkspaceClient, 'close'>,
  device: { clearApplicationData(id: string): Promise<unknown> },
): readonly (() => Promise<void>)[] {
  return [
    () => client.close(),
    async () => { await device.clearApplicationData(APPLICATION_ID); },
  ];
}

// The one stage: D5/D4, listing the pins and unpinning one in place.

export async function runListUnpin(context: PinnedPanelStageContext): Promise<void> {
  const { client, fixtures } = context;
  const pinner = await fixtures.account('pinner');
  protect(context, { accounts: [pinner] });
  const a = await arrange(context, pinner);
  context.safety.unsafeSecrets = false;

  await startNative(context);
  await client.login(pinner);
  await client.hideKeyboard();

  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: a.texts.roomName }, ROOM_OPEN_MS);
  await client.tapCurrent('.channel', { text: a.texts.roomName });
  const composer = await client.visible('[data-testid="composer-input"]', {}, 15_000);
  const opened = await view(context, a, passes(assertHeaderNamesRoom), OBSERVE_MS, 'Room header names the Room');
  await receipt(context, 'room-open', { composerVisible: composer.visible, headers: opened.roomHeader.count });

  assertOpenPinnedHidden(opened);
  await receipt(context, 'toolbar-pin-hidden', { openPinned: opened.openPinned });
  await client.tapCurrent('[data-testid="room-actions-overflow"]');
  await client.visible('[data-testid="overflow-open-pinned"]', {}, MENU_MS);
  await client.tapCurrent('[data-testid="overflow-open-pinned"]');

  const shown = await settle(context, a, passes(assertPanelVisible), PANEL_MS, 'the pinned panel is visible');
  await record(context, 'panel-visible', () => assertPanelVisible(shown), { panel: shown.panel });
  // D4: record 2's 20 s window is anchored at the read that satisfied record 1,
  // not a single unconditional read; the second pin can render a beat later.
  const two = await settle(context, a, (v) => v.items.count === 2, OBSERVE_MS, 'two pinned items');
  await record(context, 'two-pinned-items', () => assertItemCount(two, 2), { count: two.items.count });
  assertPinOrder(two);
  await receipt(context, 'pin-order', { order: two.items.order });

  const g = await settledGeometry(context, a);
  const geometry = { roomHeader: g.roomHeader, panelHeader: g.panelHeader, panelTitle: g.panelTitle };
  await record(context, 'room-header-measured', () => assertMeasured(g.roomHeader.first, 'Room header'), geometry);
  await record(context, 'panel-header-measured', () => {
    assert.equal(g.panelHeader.count, 1, 'One panel header'); assertMeasured(g.panelHeader.box, 'Panel header');
  }, geometry);
  await record(context, 'panel-title-measured', () => {
    assert.equal(g.panelTitle.count, 1, 'One panel title'); assertMeasured(g.panelTitle.box, 'Panel title');
  }, geometry);
  await record(context, 'header-heights-equal', () => assertHeaderHeightsEqual(g), geometry);
  await record(context, 'title-inset', () => assertTitleInset(g), geometry);
  await record(context, 'title-centred', () => assertTitleCentred(g), geometry);

  const target = await readPinnedView(client, a.texts);
  assertUnpinTarget(target);
  await receipt(context, 'unpin-target', { rows: target.rows });
  await client.tapCurrent('[data-testid="pinned-unpin"]', { within: { selector: '.pin-item', text: a.texts.unpinBody } });
  // RF-1: every deadline below starts here, after the tap's proven activation.
  const tapped = Date.now();

  const one = await settle(context, a, (v) => v.items.count === 1, UNPIN_MS, 'one pinned item');
  await record(context, 'one-pinned-item', () => assertItemCount(one, 1), { count: one.items.count });

  const held: PinnedView[] = [];
  const holdStart = Date.now();
  while (held.length < HOLD_READS || Date.now() - holdStart < HOLD_MS) {
    const v = await readPinnedView(client, a.texts);
    assertHeldAfterUnpin(v);
    held.push(v);
    await delay(HOLD_MS / HOLD_READS, undefined, { signal: context.signal });
  }
  const summary = { reads: held.length, spanMs: Date.now() - holdStart };
  await record(context, 'panel-stays-open', () => held.forEach(assertPanelVisible), summary);
  await record(context, 'keep-remains', () => held.forEach((v) => assert(v.panel.containsKeep)), summary);
  await record(context, 'unpin-removed', () => held.forEach(assertHeldAfterUnpin), summary);

  const remaining = UNPIN_MS - (Date.now() - tapped);
  const pins = await waitForNativeShellState(
    () => fixtures.roomState(pinner, a.room.id, 'm.room.pinned_events', ''),
    passes((s) => assertServerPins(s ?? {}, a.keepId)),
    'server pinned state converged', context.signal, Math.max(remaining, 1));
  assertServerPins(pins ?? {}, a.keepId);
  await receipt(context, 'server-pins', { pins: ['keep'] });
}

const STAGE_RUNNERS: Readonly<Record<
  PinnedPanelStageId,
  (context: PinnedPanelStageContext) => Promise<void>
>> = {
  'list-unpin': runListUnpin,
};

interface StageReport {
  readonly id: PinnedPanelStageId;
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
  assertions: PinnedPanelAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 1;
  readonly expectedUniqueAssertions: 12;
  readonly expectedAssertionRecords: 12;
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
  return publicStageFailure(`Android pinned-message-panel ${stageId} failed`, failures,
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
  return new Error(`Pinned-message-panel cleanup failed: ${label} (${parts.join('; ')})`);
}

/** The run state a failed guarded cleanup marks before it rethrows. */
export interface GuardedCleanupState {
  readonly safety: PinnedPanelPublicationSafety;
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
export function guardPinnedPanelCleanup(
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
export async function runPinnedMessagePanelSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'pinned-message-panel');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(PINNED_PANEL_STAGES.length, 1, 'Pinned-message-panel runs one stage');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 1,
          expectedUniqueAssertions: 12,
          expectedAssertionRecords: 12,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokePinnedPanelPublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: PinnedPanelPublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardPinnedPanelCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan pinned-message-panel diagnostics', () =>
          report.status === 'passed'
            ? markPinnedPanelDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanPinnedPanelArtifacts(output, secrets));
        guardedCleanup('Scrub pinned-message-panel diagnostics', async () => {
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
          guardedCleanup('Pinned-message-panel Android device', () => device.close());
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
          for (const entry of PINNED_PANEL_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: PinnedPanelAssertion[] = [];
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
            console.info(`[pinned-message-panel] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: PinnedPanelStageContext = {
              entry,
              client,
              fixtures,
              secrets,
              safety,
              records,
              identities,
              receipts: 0,
              native: false,
              directory,
              signal,
              ledger: {
                run: `${resources.aliasLocalpart(`pinned-${entry.id}`)}${PINNED_PANEL_RUN_SUFFIX}`,
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
              assertPinnedPanelRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              try { if (context.native) await client.capture('failed'); }
              catch (captureError) { failures.push(captureError); }
            } finally {
              const stageFailures = failures.length;
              await runPinnedPanelStageCleanup(pinnedPanelTeardown(client, device), failures);
              if (failures.length > stageFailures) safety.cleanupFailed = true;
              stage.assertions = [...records];
              stage.assertionRecords = records.length;
              stage.receipts = context.receipts;
              stage.durationMs = performance.now() - started;
              stage.failureCount = failures.length;
              stage.status = failures.length ? 'failed' : 'passed';
              if (failures.length) stage.error = failures.map(describeFailure).join('\n');
              await save();
              console.info(`[pinned-message-panel] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, PINNED_PANEL_ASSERTION_RECORDS,
            'Every pinned-message-panel parity identity was emitted once');
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
  void test('Android pinned-message-panel journeys', { timeout: 900_000 }, runPinnedMessagePanelSuite);
}
