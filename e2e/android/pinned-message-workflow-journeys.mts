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
  FILLER_COUNT,
  FILLER_GROUP,
  OTHER_BODY,
  PIN_BODY,
  PIN_RUN_SUFFIX,
  PINNED_WORKFLOW_ASSERTION_RECORDS,
  PINNED_WORKFLOW_STAGES,
  REPEAT_PIN_BODY,
  REPEAT_RUN_SUFFIX,
  assertBadgeCleared,
  assertBadgeOne,
  assertCloseControl,
  assertEmptyCopy,
  assertFillers,
  assertHeadingHidden,
  assertHeadingVisible,
  assertJumpFlash,
  assertJumpLatestReady,
  assertLastFillerInViewport,
  assertLastFillerRendered,
  assertMotionFull,
  assertOpenPinnedHidden,
  assertPinArrangement,
  assertPinRowBody,
  assertPinRowVisible,
  assertPinnedWorkflowRecords,
  assertRepeatArrangement,
  assertServerPins,
  assertSheetPinReachable,
  assertSheetReady,
  assertTargetInViewport,
  assertTargetOffscreen,
  assertTargetRendered,
  assertTimelineVisible,
  assertUnpinTarget,
  fillerBody,
  fillerTxn,
  flashWindowComplete,
  pinOtherTxn,
  pinRoomName,
  pinTargetTxn,
  pinnedWorkflowAssertion,
  repeatLeadTxn,
  repeatRoomName,
  repeatTargetTxn,
  type PinnedWorkflowAssertion,
  type PinnedWorkflowStage,
  type PinnedWorkflowStageId,
  type SheetView,
  type WorkflowView,
} from './pinned-message-workflow-contract.mts';
import {
  armFlashRecorder,
  flashRecorderKey,
  readFlashRecorder,
  readSheetView,
  readWorkflowView,
  type WorkflowTexts,
} from './pinned-message-workflow-observer.mts';
import { readAppliedProfile } from './pinned-message-panel-observer.mts';
import {
  markPinnedWorkflowDiagnosticsSafe,
  pinnedWorkflowSecrets,
  revokePinnedWorkflowPublicationOnAbort,
  type PinnedWorkflowPublicationSafety,
  type PinnedWorkflowSecretIds,
} from './pinned-message-workflow-artifacts.mts';
import {
  redactDiagnosticText,
  runPinnedPanelStageCleanup,
  scanPinnedPanelArtifacts,
  scrubPinnedPanelArtifacts,
} from './pinned-message-panel-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';

// Bounds (spec D4): at least the predecessor's own; 10/15 s become 20 s under host load.
const ROOM_ROW_MS = 30_000;   // 208, 318
const UI_MS = 20_000;
const PIN_MS = 30_000;        // 237
const EMPTY_MS = 30_000;      // 284
const CLEARED_MS = 30_000;    // 289
const FLOOD_MS = 30_000;      // 354
const SERVER_MS = 30_000;

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

/** The minimum a parity record or receipt needs; the guard drives it with a fake client. */
export interface RecordContext {
  readonly entry: PinnedWorkflowStage;
  readonly records: PinnedWorkflowAssertion[];
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

export interface PinnedWorkflowStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: AccountFixtures;
  readonly secrets: Record<string, string>;
  readonly safety: PinnedWorkflowPublicationSafety;
  readonly ledger: SecretLedger;
  readonly signal: AbortSignal;
  /** The stage's own artifact directory. */
  readonly directory: string;
  /** Set once `client.reset` has attached a WebView that can be captured. */
  native: boolean;
  /** Suite-wide: never reused across jumps, never reset between stages. */
  flashWindows: number;
}

/** A parity identity is emitted only after its proof passed, in contract order. */
export async function record(
  context: RecordContext,
  suffix: string,
  assertion: () => void,
  observation: unknown,
): Promise<void> {
  const identity = pinnedWorkflowAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Pinned-workflow parity records stay in source order');
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
  context: PinnedWorkflowStageContext,
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
  const ids: PinnedWorkflowSecretIds = {
    accounts: ledger.accounts.map(({ userId, username, password }) => ({ userId, username, password })),
    rooms: ledger.rooms,
    texts: ledger.texts,
    eventIds: ledger.eventIds,
    transactions: ledger.transactions,
  };
  Object.assign(context.secrets, pinnedWorkflowSecrets(context.entry.id, ids));
}

function historyOf(page: unknown): readonly Readonly<Record<string, unknown>>[] {
  const object = page as { chunk: readonly Readonly<Record<string, unknown>>[] };
  return [...object.chunk].reverse();
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
  context: PinnedWorkflowStageContext,
): Promise<Awaited<ReturnType<typeof readAppliedProfile>>> {
  const applied = await readAppliedProfile(context.client);
  assert(isPixel5Profile(applied), 'The applied profile is Pixel 5');
  return applied;
}

/** Reset to the Pixel 5 phone profile, verify motion is full, and record the diagnostic baseline. */
async function startNative(context: PinnedWorkflowStageContext, texts: WorkflowTexts): Promise<void> {
  assert(!context.safety.unsafeSecrets,
    'Every stage identifier is registered before any UI step');
  const { client } = context;
  await client.reset(PIXEL_5_ACCOUNT_PROFILE);
  context.native = true;
  const applied = await assertProfile(context);
  await client.record('profile-applied', {
    requested: PIXEL_5_ACCOUNT_PROFILE,
    digest: digest(JSON.stringify(PIXEL_5_ACCOUNT_PROFILE)),
    ...applied,
  });
  // Q7: fail before any tap if reduced motion is on.
  const motion = await readWorkflowView(client, texts);
  assertMotionFull(motion);
}

export function pinnedWorkflowTeardown(
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
export async function finishPinnedWorkflowStage(
  client: Pick<AccountWorkspaceClient, 'close'>,
  device: { clearApplicationData(id: string): Promise<unknown> },
  failures: unknown[],
): Promise<boolean> {
  const before = failures.length;
  await runPinnedPanelStageCleanup(pinnedWorkflowTeardown(client, device), failures);
  return failures.length > before;
}

/** Time left of `boundMs` since `since`, never below 1 ms. A spent bound fails closed: on the real clock the wait may make no read and time out with its generic message. */
function left(boundMs: number, since: number): number {
  return Math.max(boundMs - (Date.now() - since), 1);
}

/** Poll the view until `check` passes; on timeout rethrow `check`'s own failure on the last read. */
async function until(context: PinnedWorkflowStageContext, texts: WorkflowTexts,
  check: (v: WorkflowView) => void, timeoutMs: number, description: string): Promise<WorkflowView> {
  let last: WorkflowView | undefined;
  try {
    return await readWorkflowView(context.client, texts,
      { accepts: (v) => { last = v; return passes(check)(v); }, timeoutMs, description });
  } catch (error) {
    if (last && error instanceof Error && error.message.startsWith('Timed out waiting for')) { check(last); }
    throw error;
  }
}

/** A native tap whose return time anchors every following window. */
async function tap(context: PinnedWorkflowStageContext, selector: string,
  filter: AccountElementFilter = {}): Promise<number> {
  await context.client.tapCurrent(selector, filter);
  return Date.now();
}

/** Poll Synapse until `check` passes, within `bound` measured from `anchor` (never a fresh bound). */
async function server<T>(context: PinnedWorkflowStageContext, read: () => Promise<T>,
  check: (value: T) => void, anchor: number, description: string): Promise<T> {
  const value = await waitForNativeShellState(read, passes(check), description, context.signal, left(SERVER_MS, anchor));
  check(value);
  return value;
}

async function openPanel(context: PinnedWorkflowStageContext): Promise<number> {
  await tap(context, '[data-testid="room-actions-overflow"]');
  await context.client.visible('[data-testid="overflow-open-pinned"]', {}, UI_MS);
  return tap(context, '[data-testid="overflow-open-pinned"]');
}

/** Spec D5: arm a never-reused window, tap the item, then judge the window, close and viewport. */
async function jump(context: PinnedWorkflowStageContext, texts: WorkflowTexts,
  suffixes: readonly [flash: string, closed: string, inView: string], requireOffscreenAtClick: boolean): Promise<void> {
  const key = flashRecorderKey(++context.flashWindows);
  await armFlashRecorder(context.client, key, texts.targetBody);
  const tapped = await tap(context, '[data-testid="pinned-item"]', { text: texts.targetBody });
  const window = await readFlashRecorder(context.client, key,
    { accepts: flashWindowComplete, timeoutMs: left(UI_MS, tapped), description: 'flash window complete' })
    .catch(async (error: unknown) => {
      const last = await readFlashRecorder(context.client, key);
      assertJumpFlash(last, { requireOffscreenAtClick });
      throw error;
    });
  await record(context, suffixes[0], () => assertJumpFlash(window, { requireOffscreenAtClick }),
    assertJumpFlash(window, { requireOffscreenAtClick }));
  const closed = await until(context, texts, assertHeadingHidden, left(UI_MS, tapped), 'panel closed by the jump');
  await record(context, suffixes[1], () => assertHeadingHidden(closed), { headings: closed.heading.count });
  const shown = await until(context, texts, assertTargetInViewport, left(UI_MS, tapped), 'target in the viewport');
  await record(context, suffixes[2], () => assertTargetInViewport(shown), { inViewport: true });
}

// Stage 1: pin, jump to it, then unpin it.

export async function runPinJumpUnpin(context: PinnedWorkflowStageContext): Promise<void> {
  const { client, fixtures, ledger } = context;
  const reader = await fixtures.account('pin-reader');
  const roomName = pinRoomName(ledger.run);
  protect(context, { accounts: [reader], rooms: [{ name: roomName }],
    transactions: [pinOtherTxn(ledger.run), pinTargetTxn(ledger.run)] });
  const room = await fixtures.createRoom(reader, { name: roomName, preset: 'private_chat' });
  protect(context, { rooms: [{ id: room.id }] });
  const otherId = await fixtures.sendMessage(reader, room.id, OTHER_BODY, pinOtherTxn(ledger.run));
  protect(context, { eventIds: [otherId] });
  const targetId = await fixtures.sendMessage(reader, room.id, PIN_BODY, pinTargetTxn(ledger.run));
  protect(context, { eventIds: [targetId] });
  const page = await fixtures.roomMessages(reader, room.id);
  assertPinArrangement(historyOf(page), await fixtures.roomState(reader, room.id, 'm.room.pinned_events', ''),
    { readerId: reader.userId, otherId, targetId });
  await receipt(context, 'arranged', { messages: 2, pins: 0, roomDigest: digest(room.id) });
  context.safety.unsafeSecrets = false;
  const texts: WorkflowTexts = { roomName, targetBody: PIN_BODY, lastFillerBody: null };

  await startNative(context, texts);                 // reset, profile, assertMotionFull
  await client.login(reader);
  await client.hideKeyboard();
  await tap(context, '[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomName }, ROOM_ROW_MS);
  await tap(context, '.channel', { text: roomName });
  const timeline = await until(context, texts, assertTimelineVisible, UI_MS, 'timeline visible');
  await record(context, 'timeline-visible', () => assertTimelineVisible(timeline), { scrolls: timeline.scroll.count });
  await until(context, texts, assertTargetRendered, UI_MS, 'target row rendered');     // 217 waitFor

  await client.longPressCurrent('.scroll .msg[data-mid^="$"]', { text: PIN_BODY });
  const pressed = Date.now();
  let lastSheet: SheetView | undefined;
  const sheet = await readSheetView(client, { accepts: (v) => { lastSheet = v; return passes(assertSheetReady)(v); },
    timeoutMs: left(UI_MS, pressed), description: 'Android message-action sheet' })
    .catch((error: unknown) => {
      if (lastSheet && error instanceof Error && error.message.startsWith('Timed out waiting for')) assertSheetReady(lastSheet);
      throw error;
    });
  await record(context, 'sheet-ready', () => assertSheetReady(sheet), { dialogs: sheet.dialogs, pins: sheet.pin.count });
  assertSheetPinReachable(sheet);
  await receipt(context, 'sheet-pin-reachable', { unobstructed: sheet.pin.unobstructed });
  const pinned = await tap(context, '[data-testid="sheet-pin"]');
  const badge = await until(context, texts, assertBadgeOne, left(PIN_MS, pinned), 'badge reads 1');
  await record(context, 'badge-one', () => assertBadgeOne(badge), { badges: badge.badges });
  await server(context, () => fixtures.roomState(reader, room.id, 'm.room.pinned_events', ''),
    (s) => assertServerPins(s, [targetId]), pinned, 'server pinned state converged to the target');
  await receipt(context, 'server-pinned', { pins: 1 });

  assertOpenPinnedHidden(badge);
  await receipt(context, 'toolbar-pin-hidden', { openPinned: badge.openPinned });
  const shownAt = await openPanel(context);
  const heading = await until(context, texts, assertHeadingVisible, left(UI_MS, shownAt), 'panel heading visible');
  await record(context, 'panel-heading-visible', () => assertHeadingVisible(heading), { headings: heading.heading.count });
  const row = await until(context, texts, assertPinRowVisible, UI_MS, 'pin row visible');
  await record(context, 'pin-row-visible', () => assertPinRowVisible(row), { rows: row.pinRow.count });
  const body = await until(context, texts, assertPinRowBody, UI_MS, 'pin row body');
  await record(context, 'pin-row-body', () => assertPinRowBody(body), { bodyIncludes: true });

  await jump(context, texts, ['jump-flash', 'panel-closed-by-jump', 'target-in-viewport'], false);

  const reopenedAt = await openPanel(context);
  const reopened = await until(context, texts, assertHeadingVisible, left(UI_MS, reopenedAt), 'panel reopened');
  await record(context, 'panel-reopened', () => assertHeadingVisible(reopened), { headings: reopened.heading.count });
  const target = await until(context, texts, assertUnpinTarget, UI_MS, 'one unpin control in the target row');
  await receipt(context, 'unpin-target', { unpinCount: target.pinRow.unpinCount, inside: true, unobstructed: true });
  const unpinned = await tap(context, '[data-testid="pinned-unpin"]', { within: { selector: '.pin-item', text: PIN_BODY } });
  const empty = await until(context, texts, assertEmptyCopy, left(EMPTY_MS, unpinned), 'empty panel copy');
  await record(context, 'empty-copy-visible', () => assertEmptyCopy(empty), { exact: true });
  await server(context, () => fixtures.roomState(reader, room.id, 'm.room.pinned_events', ''),
    (s) => assertServerPins(s, []), unpinned, 'server pinned state converged to empty');
  await receipt(context, 'server-unpinned', { pins: 0 });

  assertCloseControl(empty);
  await receipt(context, 'close-control', { label: empty.close.label });
  const closedAt = await tap(context, '[data-testid="pinned-close"]');
  const cleared = await until(context, texts, assertBadgeCleared, left(CLEARED_MS, closedAt), 'badge cleared');
  await record(context, 'badge-cleared', () => assertBadgeCleared(cleared), { badges: cleared.badges.length });
}

// Stage 2: re-jumping to the same pinned message a second time still scrolls it into view.

export async function runRepeatJump(context: PinnedWorkflowStageContext): Promise<void> {
  const { client, fixtures, ledger } = context;
  const { run } = ledger;
  const reader = await fixtures.account('pin-repeat-reader');
  const roomName = repeatRoomName(run);
  const fillers = Array.from({ length: FILLER_COUNT }, (_, i) => ({ body: fillerBody(run, i), txn: fillerTxn(run, i) }));
  protect(context, { accounts: [reader], rooms: [{ name: roomName }],
    texts: fillers.map((f) => f.body),
    transactions: [repeatLeadTxn(run), repeatTargetTxn(run), ...fillers.map((f) => f.txn)] });
  const room = await fixtures.createRoom(reader, { name: roomName, preset: 'private_chat' });
  protect(context, { rooms: [{ id: room.id }] });
  const leadId = await fixtures.sendMessage(reader, room.id, OTHER_BODY, repeatLeadTxn(run));
  const targetId = await fixtures.sendMessage(reader, room.id, REPEAT_PIN_BODY, repeatTargetTxn(run));
  protect(context, { eventIds: [leadId, targetId] });
  await fixtures.setRoomState(reader, room.id, 'm.room.pinned_events', { pinned: [targetId] }, '');
  assertRepeatArrangement(historyOf(await fixtures.roomMessages(reader, room.id)),
    await fixtures.roomState(reader, room.id, 'm.room.pinned_events', ''), { readerId: reader.userId, leadId, targetId });
  await receipt(context, 'arranged', { messages: 2, pins: 1, roomDigest: digest(room.id) });
  context.safety.unsafeSecrets = false;
  const texts: WorkflowTexts = { roomName, targetBody: REPEAT_PIN_BODY, lastFillerBody: fillers.at(-1)!.body };

  await startNative(context, texts);
  await client.login(reader);
  await client.hideKeyboard();
  await tap(context, '[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomName }, ROOM_ROW_MS);
  await tap(context, '.channel', { text: roomName });
  const timeline = await until(context, texts, assertTimelineVisible, UI_MS, 'timeline visible');
  await record(context, 'timeline-visible', () => assertTimelineVisible(timeline), { scrolls: timeline.scroll.count });
  const before = await until(context, texts, assertTargetRendered, UI_MS, 'target row rendered');   // 328 waitFor
  assert.equal(before.lastFiller.count, 0, 'No filler exists before the flood');
  await receipt(context, 'pre-flood', { targetRendered: true, fillers: 0 });

  // 334–346: live fillers, sequential and awaited, after the Room is open.
  // D2 amendment: paced in FILLER_GROUP groups, so no incremental /sync batch
  // exceeds Synapse's default timeline limit and resets the live timeline.
  const fillerIds: string[] = [];
  for (const [i, filler] of fillers.entries()) {
    const id = await fixtures.sendMessage(reader, room.id, filler.body, filler.txn);
    fillerIds.push(id);
    protect(context, { eventIds: [id] });
    if ((i + 1) % FILLER_GROUP === 0 && i + 1 < FILLER_COUNT)   // anchored at this send's return
      await until(context, { ...texts, lastFillerBody: filler.body }, assertLastFillerRendered, FLOOD_MS, 'filler group rendered');
  }
  const sent = Date.now();
  await server(context, async () => historyOf(await fixtures.roomMessages(reader, room.id)),
    (events) => assertFillers(events, { readerId: reader.userId, run, leadId, targetId, fillerIds }), sent,
    'Exactly 32 fillers after the target');
  await receipt(context, 'fillers-sent', { fillers: FILLER_COUNT, ordered: true });
  const flooded = await until(context, texts, assertLastFillerInViewport, left(FLOOD_MS, sent), 'last filler in view');
  await record(context, 'last-filler-in-viewport', () => assertLastFillerInViewport(flooded), { inViewport: true });
  const away = await until(context, texts, assertTargetOffscreen, UI_MS, 'target offscreen after the flood');
  await record(context, 'target-offscreen', () => assertTargetOffscreen(away), { rendered: away.target.count, inViewport: false });

  assertOpenPinnedHidden(away);
  await receipt(context, 'toolbar-pin-hidden', { openPinned: away.openPinned });
  const firstAt = await openPanel(context);
  const h1 = await until(context, texts, assertHeadingVisible, left(UI_MS, firstAt), 'first heading');
  await record(context, 'first-heading-visible', () => assertHeadingVisible(h1), { headings: h1.heading.count });
  const r1 = await until(context, texts, assertPinRowVisible, UI_MS, 'first pin row');
  await record(context, 'first-pin-row-visible', () => assertPinRowVisible(r1), { rows: r1.pinRow.count });
  await jump(context, texts, ['first-flash', 'first-panel-closed', 'first-target-in-viewport'], true);

  // 381–383: the production jump-to-latest pill replaces renderer scrollTo.
  const pill = await until(context, texts, assertJumpLatestReady, UI_MS, 'jump-to-latest did not appear; revisit D3');
  await receipt(context, 'jump-to-latest-ready', { visible: pill.jumpLatest.visible, unobstructed: pill.jumpLatest.unobstructed });
  const latestAt = await tap(context, '[data-testid="jump-to-latest"]');
  const atLatest = await until(context, texts, assertTargetOffscreen, left(UI_MS, latestAt), 'target offscreen at latest');
  await record(context, 'target-offscreen-at-latest', () => assertTargetOffscreen(atLatest),
    { rendered: atLatest.target.count, inViewport: false });
  const newest = await until(context, texts, assertLastFillerInViewport, UI_MS, 'last filler in view at latest');
  await receipt(context, 'at-latest', { lastFillerInViewport: newest.lastFiller.inViewport });

  const secondAt = await openPanel(context);
  const h2 = await until(context, texts, assertHeadingVisible, left(UI_MS, secondAt), 'second heading');
  await record(context, 'second-heading-visible', () => assertHeadingVisible(h2), { headings: h2.heading.count });
  const r2 = await until(context, texts, assertPinRowVisible, UI_MS, 'second pin row');
  await record(context, 'second-pin-row-visible', () => assertPinRowVisible(r2), { rows: r2.pinRow.count });
  // The regression boundary: window 3 alone proves the second same-event jump.
  await jump(context, texts, ['second-flash', 'second-panel-closed', 'second-target-in-viewport'], true);
}

const STAGE_RUNNERS: Readonly<Record<
  PinnedWorkflowStageId,
  (context: PinnedWorkflowStageContext) => Promise<void>
>> = {
  'pin-jump-unpin': runPinJumpUnpin,
  'repeat-jump': runRepeatJump,
};

interface StageReport {
  readonly id: PinnedWorkflowStageId;
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
  assertions: PinnedWorkflowAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 2;
  readonly expectedUniqueAssertions: 26;
  readonly expectedAssertionRecords: 26;
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
  return publicStageFailure(`Android pinned-message-workflow ${stageId} failed`, failures,
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
  return new Error(`Pinned-message-workflow cleanup failed: ${label} (${parts.join('; ')})`);
}

/** The run state a failed guarded cleanup marks before it rethrows. */
export interface GuardedCleanupState {
  readonly safety: PinnedWorkflowPublicationSafety;
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
export function guardPinnedWorkflowCleanup(
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

/** Single-attempt, two-stage run with post-cleanup publication safety. */
export async function runPinnedMessageWorkflowSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'pinned-message-workflow');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(PINNED_WORKFLOW_STAGES.length, 2, 'Pinned-message-workflow runs two stages');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 2,
          expectedUniqueAssertions: 26,
          expectedAssertionRecords: 26,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokePinnedWorkflowPublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: PinnedWorkflowPublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardPinnedWorkflowCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan pinned-message-workflow diagnostics', () =>
          report.status === 'passed'
            ? markPinnedWorkflowDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanPinnedPanelArtifacts(output, secrets));
        guardedCleanup('Scrub pinned-message-workflow diagnostics', async () => {
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
          guardedCleanup('Pinned-message-workflow Android device', () => device.close());
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
          let flashWindows = 0;
          for (const entry of PINNED_WORKFLOW_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: PinnedWorkflowAssertion[] = [];
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
            console.info(`[pinned-message-workflow] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: PinnedWorkflowStageContext = {
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
              flashWindows,
              ledger: {
                run: `${resources.aliasLocalpart(`pinned-${entry.id}`)}${entry.id === 'pin-jump-unpin' ? PIN_RUN_SUFFIX : REPEAT_RUN_SUFFIX}`,
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
              assertPinnedWorkflowRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              try { if (context.native) await client.capture('failed'); }
              catch (captureError) { failures.push(captureError); }
            } finally {
              flashWindows = context.flashWindows;
              if (await finishPinnedWorkflowStage(client, device, failures)) safety.cleanupFailed = true;
              stage.assertions = [...records];
              stage.assertionRecords = records.length;
              stage.receipts = context.receipts;
              stage.durationMs = performance.now() - started;
              stage.failureCount = failures.length;
              stage.status = failures.length ? 'failed' : 'passed';
              if (failures.length) stage.error = failures.map(describeFailure).join('\n');
              await save();
              console.info(`[pinned-message-workflow] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, PINNED_WORKFLOW_ASSERTION_RECORDS,
            'Every pinned-message-workflow parity identity was emitted once');
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
  void test('Android pinned-message-workflow journeys', { timeout: 900_000 }, runPinnedMessageWorkflowSuite);
}
