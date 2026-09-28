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
  SharedStageAccount,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import {
  DRAWER_OPEN_FROM_RIGHT_PX,
  LONG_ROOM_FILLER,
  MESSAGE_SWIPE_ASSERTION_RECORDS,
  MESSAGE_SWIPE_STAGES,
  assertAccountRooms,
  assertAffordanceAction,
  assertAffordanceLive,
  assertAffordanceVisible,
  assertAppliedProfile,
  assertArmedOpacityOne,
  assertColourChanged,
  assertDrawerHidden,
  assertDrawerVisible,
  assertEditing,
  assertEncryptionBanner,
  assertHeldDrag,
  assertHeldPartial,
  assertHistoryLoaded,
  assertIconInsideOriginal,
  assertIconPastRowEnd,
  assertMessageSwipeReceiptName,
  assertMessageSwipeRecords,
  assertNativeGesture,
  assertNoAffordance,
  assertNoBanner,
  assertNoDragStyle,
  assertNoSettingsPath,
  assertPartialOpacityBelowOne,
  assertPartialOpacityPositive,
  assertReplying,
  assertRoomReady,
  assertRowSettled,
  assertSameDocument,
  assertScaleChanged,
  assertSectionUnwound,
  assertSeededPreference,
  assertSettingsDetached,
  assertSettingsDetail,
  assertSettingsDialogHidden,
  assertSettingsSections,
  assertTargetRows,
  assertTimelineMoved,
  fillerBody,
  fillerTransaction,
  messageSwipeAssertion,
  otherBody,
  otherTransaction,
  ownBody,
  ownTransaction,
  rowFor,
  swipeRoomName,
  type Box,
  type GestureEnding,
  type GesturePlan,
  type MessageSwipeAssertion,
  type MessageSwipeStage,
  type MessageSwipeStageId,
  type SwipeViewObservation,
  type TrustedPointerEvent,
} from './message-swipe-contract.mts';
import {
  installPointerRecorder,
  readAppliedProfile,
  readPointerEvents,
  readSwipeView,
  type RowTarget,
} from './message-swipe-observer.mts';
import {
  measureDeviceMap,
  NativeTouch,
  type CssPoint,
} from './message-swipe-motion.mts';
import {
  readNativeSwipePreference,
  seedNativeSwipePreference,
} from './message-swipe-preference.mts';
import {
  markMessageSwipeDiagnosticsSafe,
  messageSwipeSecrets,
  redactDiagnosticText,
  revokeMessageSwipePublicationOnAbort,
  runMessageSwipeStageCleanup,
  scanMessageSwipeArtifacts,
  scrubMessageSwipeArtifacts,
  type MessageSwipePublicationSafety,
  type MessageSwipeSecretIds,
} from './message-swipe-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';

// Polling bounds: each is at least the predecessor's own bound.
const ROOM_OPEN_MS = 30_000;
const COMPOSER_MS = 20_000;
const EVENTS_MS = 20_000;
const BANNER_MS = 10_000;
const HISTORY_MS = 30_000;
const DRAWER_MS = 10_000;
const SCROLL_MS = 5_000;
const SETTINGS_MS = 20_000;
const AFFORDANCE_MS = 20_000;
const STYLE_MS = 5_000;
/** A negative claim is observed for this long before it is recorded. */
const SETTLE_MS = 2_000;
/** Native vertical drags allowed to reach the older rows of a long Room. */
const HISTORY_DRAGS = 12;
/** Native vertical drags allowed to place a row inside a band of the timeline. */
const PLACEMENT_DRAGS = 6;

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

/** The minimum a parity record or receipt needs; the guard drives it with a fake client. */
export interface RecordContext {
  readonly entry: MessageSwipeStage;
  readonly records: MessageSwipeAssertion[];
  /** Suite-wide identities, so a duplicate can never be emitted twice. */
  readonly identities: Set<string>;
  receipts: number;
  readonly client: Pick<AccountWorkspaceClient, 'record'>;
}

interface SecretLedger {
  readonly run: string;
  account?: MessageSwipeSecretIds['account'];
  friend?: MessageSwipeSecretIds['friend'];
  room?: { id?: string; name?: string };
  readonly texts: string[];
  readonly eventIds: string[];
}

/** Suite-wide state that outlives one stage: the shared signed-in Account. */
export interface SuiteState {
  readonly shared: SharedStageAccount;
  signedIn: boolean;
}

export interface MessageSwipeStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: AccountFixtures;
  readonly secrets: Record<string, string>;
  readonly safety: MessageSwipePublicationSafety;
  readonly ledger: SecretLedger;
  readonly suite: SuiteState;
  /** Set once a WebView is attached that can be captured. */
  native: boolean;
  /** The held native pointer, if any; teardown cancels it. */
  touch: NativeTouch | null;
  /** Set while the device runs three-button navigation; teardown restores it. */
  navigationRestore: (() => Promise<void>) | null;
}

/** A parity identity is emitted only after its proof passed, in contract order. */
export async function record(
  context: RecordContext,
  suffix: string,
  assertion: () => void,
  observation: unknown,
): Promise<void> {
  const identity = messageSwipeAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Message-swipe parity records stay in source order');
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
  assertMessageSwipeReceiptName(name);
  context.receipts++;
  await context.client.record(
    `receipt-${String(context.receipts).padStart(2, '0')}-${name}`, value);
}

function passes<T>(check: (value: T) => unknown): (value: T) => boolean {
  return (value) => {
    try {
      check(value);
      return true;
    } catch {
      return false;
    }
  };
}

function protect(
  context: MessageSwipeStageContext,
  patch: {
    readonly account?: NodeWorkspaceAccount;
    readonly friend?: NodeWorkspaceAccount;
    readonly room?: { readonly id?: string; readonly name?: string };
    readonly texts?: readonly string[];
    readonly eventIds?: readonly string[];
  },
): void {
  const { ledger } = context;
  const ids = (account: NodeWorkspaceAccount) =>
    ({ userId: account.userId, username: account.username, password: account.password });
  if (patch.account) ledger.account = ids(patch.account);
  if (patch.friend) ledger.friend = ids(patch.friend);
  if (patch.room) ledger.room = { ...ledger.room, ...patch.room };
  ledger.texts.push(...(patch.texts ?? []));
  ledger.eventIds.push(...(patch.eventIds ?? []));
  Object.assign(context.secrets, messageSwipeSecrets(context.entry.id, ledger));
}

interface ArrangedRoom {
  readonly account: NodeWorkspaceAccount;
  readonly friend: NodeWorkspaceAccount;
  readonly room: WorkspaceRoom;
  readonly own: RowTarget;
  readonly other: RowTarget;
}

type MatrixEvent = Readonly<Record<string, unknown>>;

/** Every `m.room.message` in one `/messages?dir=b&limit=50` page, oldest first. */
export function roomTextEvents(response: unknown): readonly MatrixEvent[] {
  assert(response && typeof response === 'object' && Array.isArray((response as { chunk?: unknown }).chunk),
    'Room messages page has a chunk');
  return ((response as { chunk: MatrixEvent[] }).chunk)
    .filter((event) => event['type'] === 'm.room.message')
    .reverse();
}

export interface ArrangedEvents {
  readonly other: { readonly eventId: string; readonly sender: string; readonly body: string };
  readonly own: { readonly eventId: string; readonly sender: string; readonly body: string };
  readonly fillerSender: string;
  readonly filler: number;
}

/** Lines 83–101: exactly theirs, then mine, then the fillers, as real text events. */
export function assertArrangedRoom(events: readonly MatrixEvent[], expected: ArrangedEvents): void {
  assert.equal(events.length, 2 + expected.filler, 'The Room holds exactly the arranged messages');
  const text = (event: MatrixEvent) => event['content'] as Readonly<Record<string, unknown>> | undefined;
  const check = (event: MatrixEvent, want: { eventId: string; sender: string; body: string }) => {
    assert.equal(event['event_id'], want.eventId, 'The arranged event id');
    assert.equal(event['sender'], want.sender, 'The arranged sender');
    assert.equal(text(event)?.['msgtype'], 'm.text', 'A text message');
    assert.equal(text(event)?.['body'], want.body, 'The arranged body');
  };
  check(events[0]!, expected.other);
  check(events[1]!, expected.own);
  events.slice(2).forEach((event, index) => {
    assert.equal(event['sender'], expected.fillerSender, 'The filler is ours');
    assert.equal(text(event)?.['body'], fillerBody(index), 'The filler body is exact');
  });
}

/**
 * Lines 49–101 through real Synapse: the shared signed-in Account, a fresh
 * other Account and Room, the other Account's message, then ours, then the
 * fillers of a long Room.
 */
async function arrangeRoom(context: MessageSwipeStageContext): Promise<ArrangedRoom> {
  const { fixtures, ledger, entry } = context;
  const { run } = ledger;
  const name = swipeRoomName(run);
  const own = ownBody(run);
  const other = otherBody(run);
  const filler = entry.arrangement.filler;
  protect(context, {
    room: { name },
    texts: [own, other, otherTransaction(run), ownTransaction(run),
      ...Array.from({ length: filler }, (_, index) => fillerTransaction(run, index))],
  });
  const account = await context.suite.shared.get(fixtures);
  protect(context, { account });
  const friend = await fixtures.account(`swipe-friend-${entry.id}`);
  protect(context, { friend });
  const room = await fixtures.createRoom(account, { name, invite: [friend.userId] });
  protect(context, { room: { id: room.id } });
  assert.equal(room.name, name, 'The Room carries the predecessor name template');
  await fixtures.join(friend, room.id);
  const otherId = await fixtures.sendMessage(friend, room.id, other, otherTransaction(run));
  protect(context, { eventIds: [otherId] });
  const ownId = await fixtures.sendMessage(account, room.id, own, ownTransaction(run));
  protect(context, { eventIds: [ownId] });
  for (let index = 0; index < filler; index++) {
    const id = await fixtures.sendMessage(account, room.id, fillerBody(index),
      fillerTransaction(run, index));
    protect(context, { eventIds: [id] });
  }
  const expected: ArrangedEvents = {
    other: { eventId: otherId, sender: friend.userId, body: other },
    own: { eventId: ownId, sender: account.userId, body: own },
    fillerSender: account.userId,
    filler,
  };
  const events = await waitForNativeShellState(
    async () => roomTextEvents(await fixtures.roomMessages(account, room.id)),
    passes((value) => assertArrangedRoom(value, expected)),
    'authoritative arranged Room messages',
    context.client.signal,
    EVENTS_MS,
  );
  assertArrangedRoom(events, expected);
  await receipt(context, 'arranged-room', {
    roomDigest: digest(room.id),
    otherDigest: digest(otherId),
    ownDigest: digest(ownId),
    filler,
    exactOrder: true,
  });
  return {
    account,
    friend,
    room,
    own: { body: own, eventId: ownId },
    other: { body: other, eventId: otherId },
  };
}

/**
 * Line 103–107 with one shared Account: the first stage signs in once; each
 * stage then stops the app, sets exactly its native `trinity.message-swipe`
 * (or the unseeded default) and relaunches, which is the predecessor's seed
 * followed by a fresh application boot. A `freshApp` stage clears the app and
 * signs in again without writing any preference.
 */
async function launch(context: MessageSwipeStageContext, account: NodeWorkspaceAccount,
  options: { readonly freshApp?: boolean; readonly threeButtonNavigation?: boolean } = {}): Promise<void> {
  assert(!context.safety.unsafeSecrets, 'Every stage identifier is registered before any UI step');
  const { client, suite, entry } = context;
  const { seed } = entry.arrangement;
  if (options.freshApp) {
    assert.equal(seed, null, 'A fresh-app stage is unseeded');
    await suite.shared.enter(client, PIXEL_5_ACCOUNT_PROFILE, { fresh: true });
    context.native = true;
    const cleared = await readNativeSwipePreference(client.device, APPLICATION_ID);
    assertSeededPreference(cleared, null);
    await receipt(context, 'native-preference-unseeded', { ...cleared, written: false });
    await suite.shared.signIn(client, account);
    await client.hideKeyboard();
  } else {
    if (!suite.signedIn) {
      await suite.shared.enter(client, PIXEL_5_ACCOUNT_PROFILE);
      context.native = true;
      await suite.shared.signIn(client, account);
      await client.hideKeyboard();
      suite.signedIn = true;
      await client.close();
      context.native = false;
    }
    const seeded = await seedNativeSwipePreference(client.device, APPLICATION_ID, seed);
    assertSeededPreference(seeded, seed);
    await receipt(context, 'native-preference-seeded', { ...seeded, seed, beforeLaunch: true });
    // A navigation-mode change re-creates the activity, so it happens while the app is stopped.
    if (options.threeButtonNavigation) await useThreeButtonNavigation(context);
    assert.equal(await suite.shared.enter(client, PIXEL_5_ACCOUNT_PROFILE), 'relaunch',
      'The seeded app relaunches with the shared Account');
    context.native = true;
    await suite.shared.signIn(client, account);
  }
  const applied = await readAppliedProfile(client);
  assertAppliedProfile(applied);
  await client.record('profile-applied', {
    profile: 'pixel-5',
    requested: PIXEL_5_ACCOUNT_PROFILE,
    digest: digest(JSON.stringify(PIXEL_5_ACCOUNT_PROFILE)),
    applied,
  });
  const live = await readNativeSwipePreference(client.device, APPLICATION_ID);
  assertSeededPreference(live, seed);
  await receipt(context, 'native-preference-launched', live);
}

export async function view(
  context: MessageSwipeStageContext,
  targets: readonly RowTarget[],
  check: (value: SwipeViewObservation) => unknown,
  description: string,
  timeoutMs: number,
): Promise<SwipeViewObservation> {
  let last: SwipeViewObservation | undefined;
  try {
    return await readSwipeView(context.client, targets, {
      accepts: (value) => { last = value; return passes(check)(value); },
      description,
      timeoutMs,
    });
  } catch (error) {
    // The last unmet observation, for diagnosis; the scrub redacts its bodies and route.
    if (last) await context.client.record('unmet-observation', last);
    throw error;
  }
}

/**
 * A negative claim is observed for `SETTLE_MS` and must hold on every read:
 * a late banner or drawer after a native gesture fails it.
 */
async function settled(
  context: MessageSwipeStageContext,
  targets: readonly RowTarget[],
  check: (value: SwipeViewObservation) => unknown,
  description: string,
): Promise<SwipeViewObservation> {
  const deadline = performance.now() + SETTLE_MS;
  let last: SwipeViewObservation;
  let reads = 0;
  do {
    last = await readSwipeView(context.client, targets, { description });
    check(last);
    reads++;
    await delay(250, undefined, { signal: context.client.signal });
  } while (performance.now() < deadline);
  assert(reads >= 2, `${description} held over several reads`);
  return last;
}

/** Helper 108–120 (and 122–141 for a long Room): open the exact Room natively. */
async function openRoom(context: MessageSwipeStageContext, arranged: ArrangedRoom,
  targets: readonly RowTarget[]): Promise<SwipeViewObservation> {
  const { client, entry } = context;
  const identity = { name: arranged.room.name, roomId: arranged.room.id, userId: arranged.account.userId };
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: arranged.room.name }, ROOM_OPEN_MS);
  await client.tapCurrent('.channel', { text: arranged.room.name });
  const ready = await view(context, targets, (value) => assertRoomReady(value, identity),
    'exact Room composer and route after native open', COMPOSER_MS);
  await record(context, 'room-ready', () => assertRoomReady(ready, identity), {
    composerVisible: true,
    exactPlaceholder: true,
    exactRoute: true,
    roomDigest: digest(arranged.room.id),
  });
  const banner = await view(context, targets, assertEncryptionBanner,
    'Set up encryption banner', COMPOSER_MS);
  await record(context, 'encryption-banner', () => assertEncryptionBanner(banner), {
    encryptionBanners: banner.encryptionBanners,
  });
  if (entry.arrangement.filler === LONG_ROOM_FILLER) {
    const loaded = await loadHistory(context, arranged, targets);
    await record(context, 'history-loaded', () => assertHistoryLoaded(loaded.view, arranged.own.body), {
      ownRowLoaded: true,
      nativeDrags: loaded.drags,
    });
  }
  // Helper 146–150: both target rows, visible, reconciled and the arranged events.
  const rows = await placeRows(context, targets);
  await receipt(context, 'target-rows', {
    rows: targets.length,
    exactEvents: true,
    timeOrigin: rows.timeOrigin,
  });
  return rows;
}

/**
 * Line 127 without renderer scrolling: native downward drags on the timeline
 * reach its top and trigger real back-pagination until the own row is loaded.
 */
async function loadHistory(context: MessageSwipeStageContext, arranged: ArrangedRoom,
  targets: readonly RowTarget[]): Promise<{ readonly view: SwipeViewObservation; readonly drags: number }> {
  const deadline = performance.now() + HISTORY_MS;
  for (let drags = 0; ; drags++) {
    const current = await readSwipeView(context.client, targets, { description: 'long-Room history' });
    if (rowFor(current, arranged.own.body).matches > 0) return { view: current, drags };
    assert(drags < HISTORY_DRAGS && performance.now() < deadline,
      'Native drags back-paginated to the own row within the predecessor bound');
    await dragTimeline(context, 'history', 'older');
    await delay(500, undefined, { signal: context.client.signal });
  }
}

/**
 * One slow native vertical drag across the middle of the timeline, proven as
 * a trusted native gesture. Every step clears the long-press slop, and the
 * drag pauses before lifting so the release carries no fling. `older` moves
 * content down.
 */
async function dragTimeline(context: MessageSwipeStageContext, name: string,
  toward: 'older' | 'newer', distance?: number): Promise<void> {
  const touch = await freshTouch(context);
  const box = touch.map.css;
  const height = box.bottom - box.top;
  const travel = Math.min(distance ?? height * 0.5, height * 0.6);
  const steps = Math.min(20, Math.max(2, Math.floor(travel / 12)));
  const x = box.left + (box.right - box.left) * 0.5;
  const top = box.top + (height - travel) / 2;
  const from = { x, y: toward === 'older' ? top : top + travel };
  const to = { x, y: toward === 'older' ? top + travel : top };
  await installPointerRecorder(context.client);
  context.touch = touch;
  await touch.press(from, to, steps);
  await delay(400, undefined, { signal: context.client.signal });
  await touch.release();
  context.touch = null;
  const events = await waitForNativeShellState(
    () => readPointerEvents(context.client),
    (value) => value.some((event) => event.type === 'pointerup' || event.type === 'pointercancel'),
    `native ${name} timeline drag ended`,
    context.client.signal,
    STYLE_MS,
  );
  const { moves, windowMs } = await proveGesture(context, events, { from, to }, 'up-or-cancel');
  await receipt(context, `timeline-drag-${name}`, {
    toward, travel, steps, moves, windowMs, terminal: events.at(-1)!.type,
  });
}

/** Scroll natively until every target row lies inside the timeline, with `margin` CSS px spare. */
async function placeRows(context: MessageSwipeStageContext, targets: readonly RowTarget[],
  margin = 4): Promise<SwipeViewObservation> {
  for (let drags = 0; ; drags++) {
    const current = await view(context, targets, (value) => assertTargetRows(value, targets.map((t) => t.body)),
      'target rows visible, reconciled and exact', ROOM_OPEN_MS);
    const scroller = current.scroll.box;
    assert(scroller, 'The timeline is measured');
    const boxes = targets.map((target) => rowFor(current, target.body).box!);
    const high = Math.min(...boxes.map((box) => box.top));
    const low = Math.max(...boxes.map((box) => box.bottom));
    if (high >= scroller.top + margin && low <= scroller.bottom - margin) return current;
    assert(drags < PLACEMENT_DRAGS, 'Native drags placed the target rows inside the timeline');
    if (high < scroller.top + margin)
      await dragTimeline(context, 'place', 'older', scroller.top + margin - high + 24);
    else await dragTimeline(context, 'place', 'newer', low - scroller.bottom + margin + 24);
  }
}

/**
 * `assertNativeGesture`, but a failed proof first records the raw trusted
 * pointer events it was given (scrubbed like every other diagnostic), so a
 * failing gesture is as diagnosable as a failing `view()` wait.
 */
async function proveGesture(
  context: MessageSwipeStageContext,
  events: readonly TrustedPointerEvent[],
  plan: GesturePlan,
  ending: GestureEnding,
): Promise<{ readonly moves: number; readonly durationMs: number; readonly windowMs: number }> {
  try {
    return assertNativeGesture(events, plan, ending);
  } catch (error) {
    await context.client.record('unmet-gesture', { plan, ending, events });
    throw error;
  }
}

async function freshTouch(context: MessageSwipeStageContext): Promise<NativeTouch> {
  assert.equal(context.touch, null, 'No native touch is held between gestures');
  return new NativeTouch(context.client, await measureDeviceMap(context.client));
}

interface GestureProof {
  readonly name: string;
  readonly plan: GesturePlan;
  readonly moves: number;
  readonly durationMs: number;
}

/** A complete native swipe, proven as trusted device input reaching the renderer. */
async function nativeSwipe(context: MessageSwipeStageContext, name: string, from: CssPoint,
  to: CssPoint, ending: 'up' | 'cancel' | 'up-or-cancel'): Promise<GestureProof> {
  const touch = await freshTouch(context);
  await installPointerRecorder(context.client);
  await touch.swipe(from, to);
  const events = await waitForNativeShellState(
    () => readPointerEvents(context.client),
    (value) => value.some((event) => event.type === 'pointerup' || event.type === 'pointercancel'),
    `native ${name} gesture ended`,
    context.client.signal,
    STYLE_MS,
  );
  const plan = { from, to };
  const { moves, durationMs } = await proveGesture(context, events, plan, ending);
  const proof = { name, plan, moves, durationMs };
  await receipt(context, `gesture-${name}`, {
    ...proof,
    device: touch.log.flatMap((command) => command.phases.map(({ phase, device }) => ({ phase, device }))),
    terminal: events.at(-1)!.type,
  });
  return proof;
}

/** A held native drag: down, the path, and the pointer still down afterwards. */
async function nativePress(context: MessageSwipeStageContext, name: string, from: CssPoint,
  to: CssPoint): Promise<NativeTouch> {
  const touch = await freshTouch(context);
  await installPointerRecorder(context.client);
  context.touch = touch;
  await touch.press(from, to);
  const events = await waitForNativeShellState(
    () => readPointerEvents(context.client),
    (value) => value.filter((event) => event.type === 'pointermove').length >= 2,
    `native ${name} press moved`,
    context.client.signal,
    STYLE_MS,
  );
  const { moves } = await proveGesture(context, events, { from, to }, 'held');
  await receipt(context, `held-${name}`, { from, to, moves, held: true });
  return touch;
}

async function nativeMoveHeld(context: MessageSwipeStageContext, touch: NativeTouch, name: string,
  from: CssPoint, to: CssPoint): Promise<void> {
  await touch.moveTo(to);
  const events = await readPointerEvents(context.client);
  await proveGesture(context, events, { from, to }, 'held');
  await receipt(context, `held-${name}`, { to, moves: events.length - 1, held: true });
}

async function nativeRelease(context: MessageSwipeStageContext, touch: NativeTouch,
  name: string): Promise<void> {
  await touch.release();
  context.touch = null;
  const events = await waitForNativeShellState(
    () => readPointerEvents(context.client),
    (value) => value.some((event) => event.type === 'pointerup' || event.type === 'pointercancel'),
    `native ${name} release`,
    context.client.signal,
    STYLE_MS,
  );
  assert.equal(events.at(-1)!.type, 'pointerup', 'The held pointer was released');
  await receipt(context, `released-${name}`, { terminal: 'pointerup' });
}

/** Lines 158–172: a rightward drag from 35% to 95% of the row's width, at its centre. */
async function swipeRow(context: MessageSwipeStageContext, targets: readonly RowTarget[],
  body: string, name: string, ending: 'up' | 'up-or-cancel' = 'up'): Promise<GestureProof> {
  const current = await placeRows(context, targets);
  const box = rowFor(current, body).box!;
  const y = box.top + box.height / 2;
  return nativeSwipe(context, name, { x: box.left + box.width * 0.35, y },
    { x: box.left + box.width * 0.95, y }, ending);
}

function rowCentre(box: Box): number {
  return box.top + box.height / 2;
}

// Stages.

async function stageStart(context: MessageSwipeStageContext): Promise<{
  readonly arranged: ArrangedRoom;
  readonly targets: readonly RowTarget[];
  readonly opened: SwipeViewObservation;
}> {
  const arranged = await arrangeRoom(context);
  context.safety.unsafeSecrets = false;
  await launch(context, arranged.account, {
    freshApp: context.entry.id === 'live-setting',
    threeButtonNavigation: context.entry.id === 'edge-dead-zones',
  });
  const targets = [arranged.own, arranged.other];
  const opened = await openRoom(context, arranged, targets);
  return { arranged, targets, opened };
}

export async function runEditOwn(context: MessageSwipeStageContext): Promise<void> {
  const { arranged, targets } = await stageStart(context);
  await swipeRow(context, targets, arranged.own.body, 'own-commit');
  const editing = await view(context, targets, (value) => assertEditing(value, arranged.own.body),
    'Editing banner for the own message', BANNER_MS);
  await record(context, 'editing', () => assertEditing(editing, arranged.own.body), {
    banner: 'Editing', exactComposer: true,
  });
}

export async function runReplyOther(context: MessageSwipeStageContext): Promise<void> {
  const { arranged, targets } = await stageStart(context);
  await swipeRow(context, targets, arranged.other.body, 'other-commit');
  const replying = await view(context, targets, (value) => assertReplying(value, arranged.friend.username),
    'Replying banner for the other message', BANNER_MS);
  await record(context, 'replying', () => assertReplying(replying, arranged.friend.username), {
    banner: 'Replying to', namesOther: true,
  });
}

/** Lines 220–230: from 40% to 50% of the row, short of the 25% commit threshold. */
async function halfway(context: MessageSwipeStageContext, targets: readonly RowTarget[],
  body: string, name: string): Promise<void> {
  const current = await placeRows(context, targets);
  const box = rowFor(current, body).box!;
  const y = rowCentre(box);
  await nativeSwipe(context, name, { x: box.left + box.width * 0.4, y },
    { x: box.left + box.width * 0.5, y }, 'up');
}

export async function runPartialAffordance(context: MessageSwipeStageContext): Promise<void> {
  const { arranged, targets } = await stageStart(context);
  await halfway(context, targets, arranged.own.body, 'own-halfway');
  const own = await view(context, targets, (value) => assertAffordanceVisible(value, arranged.own.body),
    'own affordance after the partial drag', STYLE_MS);
  await record(context, 'own-affordance-visible', () => assertAffordanceVisible(own, arranged.own.body), {
    count: 1, boxed: true,
  });
  await record(context, 'own-edit-affordance',
    () => assertAffordanceAction(own, arranged.own.body, 'edit'), { action: 'edit' });
  const uncommitted = await settled(context, targets, assertNoBanner, 'the partial drag did not commit');
  await receipt(context, 'own-partial-uncommitted', { banners: uncommitted.banners.length });
  await halfway(context, targets, arranged.other.body, 'other-halfway');
  const other = await view(context, targets,
    (value) => assertAffordanceAction(value, arranged.other.body, 'reply'),
    'other affordance after the partial drag', STYLE_MS);
  await record(context, 'other-reply-affordance',
    () => assertAffordanceAction(other, arranged.other.body, 'reply'), { action: 'reply' });
}

export async function runProgressiveFeedback(context: MessageSwipeStageContext): Promise<void> {
  const { arranged, targets } = await stageStart(context);
  const body = arranged.other.body;
  const current = await placeRows(context, targets);
  const box = rowFor(current, body).box!;
  const y = rowCentre(box);
  const start = { x: box.left + box.width * 0.35, y };
  const partlyAt = { x: box.left + box.width * 0.55, y };
  const committedAt = { x: box.left + box.width * 0.95, y };
  // Lines 293–311: a held native drag to 55%, observed before any release.
  const touch = await nativePress(context, 'progress-partial', start, partlyAt);
  const partlyView = await view(context, targets, (value) => {
    assertHeldPartial(value, body, 1);
    assertPartialOpacityPositive(value, body);
  }, 'the held partial drag fades the affordance in', STYLE_MS);
  const partly = rowFor(partlyView, body).affordance;
  await record(context, 'partial-opacity-positive',
    () => { assertPartialOpacityPositive(partlyView, body); },
    { opacity: partly.opacity, drag: rowFor(partlyView, body).drag, held: true });
  await record(context, 'partial-opacity-below-one',
    () => { assertPartialOpacityBelowOne(partlyView, body); },
    { opacity: partly.opacity, held: true });
  // Lines 313–318: move the same held pointer to 95%, still before release.
  await nativeMoveHeld(context, touch, 'progress-armed', start, committedAt);
  const armedView = await view(context, targets, (value) => assertArmedOpacityOne(value, body),
    'the held drag past the threshold shows the affordance fully', STYLE_MS);
  const armed = rowFor(armedView, body).affordance;
  await record(context, 'armed-opacity-one', () => assertArmedOpacityOne(armedView, body), {
    opacity: armed.opacity, armed: true, held: true,
  });
  await record(context, 'armed-scale-changed', () => assertScaleChanged(partly, armed), {
    partlyScale: partly.scale, armedScale: armed.scale,
  });
  await record(context, 'armed-colour-changed', () => assertColourChanged(partly, armed), {
    partlyColour: partly.color, armedColour: armed.color,
  });
  // Lines 319–325: the predecessor lifts the finger at the end.
  await nativeRelease(context, touch, 'progress');
}

export async function runOffInert(context: MessageSwipeStageContext): Promise<void> {
  const { arranged, targets, opened } = await stageStart(context);
  await record(context, 'no-affordance', () => assertNoAffordance(opened, arranged.own.body), {
    affordances: 0,
  });
  await swipeRow(context, targets, arranged.own.body, 'off-drag');
  const quiet = await settled(context, targets, (value) => {
    assertNoBanner(value);
    assertRowSettled(value, arranged.own.body);
  }, 'Off: no composer action and no drag state');
  await record(context, 'no-banner', () => assertNoBanner(quiet), { banners: 0, dragState: false });
}

export async function runLeftDirection(context: MessageSwipeStageContext): Promise<void> {
  const { arranged, targets } = await stageStart(context);
  const body = arranged.other.body;
  await swipeRow(context, targets, body, 'left-rejects-right');
  const rejected = await settled(context, targets, assertNoBanner, 'Left rejects a rightward drag');
  await record(context, 'right-drag-rejected', () => assertNoBanner(rejected), { banners: 0 });
  const current = await placeRows(context, targets);
  const box = rowFor(current, body).box!;
  const y = rowCentre(box);
  await nativeSwipe(context, 'left-commit', { x: box.left + box.width * 0.8, y },
    { x: box.left + box.width * 0.1, y }, 'up');
  const replying = await view(context, targets, (value) => assertReplying(value, arranged.friend.username),
    'a leftward drag replies', BANNER_MS);
  await record(context, 'left-drag-replying', () => assertReplying(replying, arranged.friend.username), {
    banner: 'Replying to', namesOther: true,
  });
}

export async function runLeftStripGeometry(context: MessageSwipeStageContext): Promise<void> {
  const { arranged, targets } = await stageStart(context);
  const body = arranged.other.body;
  const current = await placeRows(context, targets);
  const before = rowFor(current, body).box!;
  const y = rowCentre(before);
  const from = { x: before.left + before.width * 0.8, y };
  const to = { x: before.left + before.width * 0.5, y };
  // Lines 384–412: mid-drag, before release.
  const touch = await nativePress(context, 'leftward', from, to);
  const moved = await view(context, targets, (value) => {
    assertHeldDrag(value, body, -1);
    assertIconPastRowEnd(value, body);
    assertIconInsideOriginal(value, body, before);
  }, 'the held leftward drag uncovers the trailing strip', STYLE_MS);
  const movedRow = rowFor(moved, body);
  await record(context, 'icon-past-row-end', () => { assertIconPastRowEnd(moved, body); }, {
    iconCentre: assertIconPastRowEnd(moved, body), movedRight: movedRow.box!.right, held: true,
  });
  await record(context, 'icon-inside-original-row',
    () => { assertIconInsideOriginal(moved, body, before); }, {
      iconCentre: assertIconInsideOriginal(moved, body, before), originalRight: before.right, held: true,
    });
  await nativeRelease(context, touch, 'leftward');
}

export async function runVerticalAbandon(context: MessageSwipeStageContext): Promise<void> {
  const { arranged, targets } = await stageStart(context);
  const body = arranged.other.body;
  let current = await placeRows(context, targets);
  // The path ends 150 CSS px above the row: keep that end inside the timeline.
  for (let drags = 0; rowCentre(rowFor(current, body).box!) - 150 < current.scroll.box!.top + 8; drags++) {
    assert(drags < PLACEMENT_DRAGS, 'Native drags left room above the row for the turn');
    await dragTimeline(context, 'turn-room', 'older',
      current.scroll.box!.top + 8 + 150 - rowCentre(rowFor(current, body).box!) + 24);
    current = await placeRows(context, targets);
  }
  const box = rowFor(current, body).box!;
  const y = rowCentre(box);
  await nativeSwipe(context, 'turns-vertical', { x: box.left + box.width * 0.35, y },
    { x: box.left + box.width * 0.95, y: y - 150 }, 'up-or-cancel');
  const abandoned = await settled(context, targets, (value) => {
    assertNoBanner(value);
    assertNoDragStyle(value, body);
  }, 'the turned drag abandoned without acting');
  await record(context, 'no-banner', () => assertNoBanner(abandoned), { banners: 0 });
  await record(context, 'no-drag-style', () => assertNoDragStyle(abandoned, body), { drag: '' });
}

export interface CompositorFeasibility {
  readonly feasible: boolean;
  readonly nativePanStream: boolean;
  readonly compositorPanning: boolean;
  readonly moves: number;
  readonly scrollDelta: number;
}

/**
 * The hard gate for the Playwright-skipped compositor case: one held, pure
 * vertical native drag must reach the renderer as an interpolated trusted
 * touch path and pan the real timeline scroller while the finger is still
 * down. Chromium may take the pan with `pointercancel`; the finger is lifted
 * only after the observation. Nothing is scrolled by the renderer. The
 * result is recorded before the caller asserts it, so a failed gate leaves
 * `feasibility.json` behind.
 */
async function probeCompositorPanning(context: MessageSwipeStageContext,
  targets: readonly RowTarget[]): Promise<CompositorFeasibility> {
  const current = await readSwipeView(context.client, targets, { description: 'feasibility start' });
  const scroller = current.scroll.box!;
  const x = scroller.left + (scroller.right - scroller.left) * 0.5;
  const before = current.scroll.scrollTop!;
  // Pan toward whichever end still has at least the drag's range.
  const down = before >= 130;
  const from = { x, y: scroller.top + (scroller.bottom - scroller.top) * (down ? 0.35 : 0.65) };
  const to = { x, y: from.y + (down ? 120 : -120) };
  const touch = await freshTouch(context);
  await installPointerRecorder(context.client);
  context.touch = touch;
  let events: readonly TrustedPointerEvent[] = [];
  let during = before;
  try {
    await touch.press(from, to);
    const panned = await waitForNativeShellState(
      () => readSwipeView(context.client, targets, { description: 'held vertical pan' }),
      (value) => value.scroll.scrollTop !== before,
      'the held vertical drag panned the timeline',
      context.client.signal,
      SCROLL_MS,
    ).catch(() => null);
    during = panned?.scroll.scrollTop ?? before;
    events = await readPointerEvents(context.client);
  } finally {
    await touch.release();
    context.touch = null;
  }
  const moves = events.filter((event) => event.type === 'pointermove').length;
  const nativePanStream = passes(() => assertNativeGesture(events, { from, to }, 'held-pan'))(undefined);
  const compositorPanning = during !== before;
  const result: CompositorFeasibility = {
    feasible: nativePanStream && compositorPanning,
    nativePanStream,
    compositorPanning,
    moves,
    scrollDelta: during - before,
  };
  await context.client.record('feasibility', {
    stage: context.entry.id,
    primitive: 'input motionevent DOWN/MOVE (held) /UP on the touchscreen',
    ...result,
  });
  return result;
}

export async function runVerticalScroll(context: MessageSwipeStageContext): Promise<void> {
  const { arranged, targets } = await stageStart(context);
  const gate = await probeCompositorPanning(context, targets);
  assert(gate.feasible, 'Native held interpolation and compositor panning are feasible on this device');
  const body = arranged.other.body;
  const current = await placeRows(context, targets);
  const box = rowFor(current, body).box!;
  const before = current.scroll.scrollTop!;
  // Lines 473–477: drag toward whichever direction still has scroll range.
  const distance = before > 1 ? 100 : -100;
  const y = rowCentre(box);
  const scroller = current.scroll.box!;
  assert(y + distance >= scroller.top && y + distance <= scroller.bottom,
    'The vertical drag stays inside the timeline');
  await nativeSwipe(context, 'vertical', { x: box.left + box.width * 0.5, y },
    { x: box.left + box.width * 0.5, y: y + distance }, 'up-or-cancel');
  const moved = await view(context, targets, (value) => assertTimelineMoved(value, before),
    'the vertical native drag moved the timeline', SCROLL_MS);
  await record(context, 'timeline-moved', () => { assertTimelineMoved(moved, before); }, {
    before, after: moved.scroll.scrollTop, distance,
  });
  const quiet = await settled(context, targets, assertNoBanner, 'the vertical drag took no action');
  await record(context, 'no-banner', () => assertNoBanner(quiet), { banners: 0 });
}

/**
 * Android's gesture navigation claims a touch that starts at either screen
 * edge as system Back. The product dead zone is reached only when the platform
 * delivers that touch, so the edge stage runs under three-button navigation,
 * set while the app is stopped, and teardown restores the device's mode with
 * the app stopped again.
 */
async function useThreeButtonNavigation(context: MessageSwipeStageContext): Promise<void> {
  const { client } = context;
  await client.device.adb('shell', 'am', 'force-stop', APPLICATION_ID);
  const original = (await client.device.adb('shell', 'settings', 'get', 'secure', 'navigation_mode')).trim();
  const overlay = (mode: string) => mode === '0' ? 'threebutton' : mode === '1' ? 'twobutton' : 'gestural';
  const setMode = async (mode: string): Promise<void> => {
    await client.device.adb('shell', 'cmd', 'overlay', 'enable-exclusive', '--category',
      `com.android.internal.systemui.navbar.${overlay(mode)}`);
    await waitForNativeShellState(
      async () => (await client.device.adb('shell', 'settings', 'get', 'secure', 'navigation_mode')).trim(),
      (value) => value === mode,
      `navigation mode ${mode}`,
      client.signal,
      15_000,
    );
  };
  context.navigationRestore = async () => {
    context.navigationRestore = null;
    await client.device.adb('shell', 'am', 'force-stop', APPLICATION_ID);
    await setMode(original);
  };
  await setMode('0');
  await receipt(context, 'three-button-navigation', { original, applied: '0' });
}

export async function runEdgeDeadZones(context: MessageSwipeStageContext): Promise<void> {
  const { arranged, targets } = await stageStart(context);
  assert(context.navigationRestore, 'The edge stage runs under three-button navigation');
  let current = await placeRows(context, targets);
  const box = rowFor(current, arranged.other.body).box!;
  const y = rowCentre(box);
  const width = current.innerWidth;
  // Line 507: from 4 px, inside the left dead zone. Held first, to see that it never arms.
  const leftFrom = { x: 4, y };
  const leftTo = { x: width * 0.8, y };
  const held = await nativePress(context, 'left-edge', leftFrom, leftTo);
  const unarmed = await view(context, targets, (value) => assertRowSettled(value, arranged.other.body),
    'the edge-started drag never armed the row', STYLE_MS);
  await receipt(context, 'left-edge-unarmed', { drag: rowFor(unarmed, arranged.other.body).drag });
  await nativeRelease(context, held, 'left-edge');
  const quiet = await settled(context, targets, assertNoBanner, 'the left edge took no action');
  await record(context, 'left-edge-no-banner', () => assertNoBanner(quiet), { banners: 0 });
  // Line 515: the positive control, from 80 px.
  await nativeSwipe(context, 'inset-control', { x: 80, y }, { x: width * 0.85, y }, 'up');
  const replying = await view(context, targets, (value) => assertReplying(value, arranged.friend.username),
    'the in-row control replies', BANNER_MS);
  await record(context, 'inset-control-replying', () => assertReplying(replying, arranged.friend.username), {
    banner: 'Replying to', namesOther: true,
  });
  // Line 522: the extreme right is native-history territory.
  await nativeSwipe(context, 'right-edge', { x: width - 4, y }, { x: width * 0.2, y }, 'up');
  current = await settled(context, targets, assertDrawerHidden, 'the right edge opened nothing');
  await record(context, 'right-edge-drawer-hidden', () => assertDrawerHidden(current), { drawer: false });
  // Line 527: the drawer owns the adjacent inset band.
  await nativeSwipe(context, 'drawer-inset', { x: width - DRAWER_OPEN_FROM_RIGHT_PX, y },
    { x: width * 0.2, y }, 'up-or-cancel');
  const drawer = await view(context, targets, assertDrawerVisible, 'the inset band opened the drawer',
    DRAWER_MS);
  await record(context, 'inset-drawer-visible', () => assertDrawerVisible(drawer), { drawer: true });
}

async function drawerCycle(context: MessageSwipeStageContext, targets: readonly RowTarget[],
  suppressed?: RowTarget): Promise<void> {
  const initial = await readSwipeView(context.client, targets, { description: 'drawer start' });
  const width = initial.innerWidth;
  const y = initial.innerHeight / 2;
  await record(context, 'drawer-initially-hidden', () => assertDrawerHidden(initial), { drawer: false });
  await nativeSwipe(context, 'drawer-open', { x: width - DRAWER_OPEN_FROM_RIGHT_PX, y },
    { x: width * 0.3, y }, 'up-or-cancel');
  const opened = await view(context, targets, assertDrawerVisible, 'the edge drag opened the drawer',
    DRAWER_MS);
  await record(context, 'drawer-opened', () => assertDrawerVisible(opened), { drawer: true });
  if (suppressed) {
    const quiet = await view(context, targets, (value) => assertNoAffordance(value, suppressed.body),
      'row swipe is off over the open drawer', STYLE_MS);
    await record(context, 'row-swipe-suppressed', () => assertNoAffordance(quiet, suppressed.body), {
      affordances: 0, drawer: true,
    });
  }
  await nativeSwipe(context, 'drawer-close', { x: width * 0.4, y }, { x: width - 4, y }, 'up-or-cancel');
  const closed = await view(context, targets, assertDrawerHidden, 'the drag closed the drawer', DRAWER_MS);
  await record(context, 'drawer-closed', () => assertDrawerHidden(closed), { drawer: false });
}

export async function runDrawerLeft(context: MessageSwipeStageContext): Promise<void> {
  const { targets } = await stageStart(context);
  await drawerCycle(context, targets);
}

export async function runDrawerOff(context: MessageSwipeStageContext): Promise<void> {
  const { targets } = await stageStart(context);
  await drawerCycle(context, targets);
}

export async function runDrawerRight(context: MessageSwipeStageContext): Promise<void> {
  const { arranged, targets } = await stageStart(context);
  await drawerCycle(context, targets, arranged.other);
}

export async function runLiveSetting(context: MessageSwipeStageContext): Promise<void> {
  const { arranged, targets, opened } = await stageStart(context);
  const { client } = context;
  const userId = arranged.account.userId;
  const own = arranged.own.body;
  await record(context, 'initially-no-affordance', () => assertNoAffordance(opened, own), { affordances: 0 });
  // Line 604: below the members breakpoint the way to Settings is Back first.
  await client.tapCurrent('[data-testid="back-to-rooms"]');
  // Navigation 19–35 (Android branch): an Account-qualified Rooms route, then Settings.
  const rooms = await view(context, [], (value) => assertAccountRooms(value.href, userId),
    'Account-qualified Rooms route', SETTINGS_MS);
  await record(context, 'settings-rooms-route', () => assertAccountRooms(rooms.href, userId), {
    rooms: true, accountQualified: true,
  });
  await client.tapCurrent('[data-testid="open-settings"]');
  const sections = await view(context, [], assertSettingsSections, 'native Settings sections', SETTINGS_MS);
  await record(context, 'settings-sections-visible', () => assertSettingsSections(sections), {
    settingsRoute: true, sectionsVisible: true,
  });
  await client.tapCurrent('[data-testid="settings-nav-appearance"]');
  const detail = await view(context, [], (value) => assertSettingsDetail(value, 'appearance'),
    'Appearance detail', SETTINGS_MS);
  await record(context, 'settings-detail-ready', () => assertSettingsDetail(detail, 'appearance'), {
    route: '/settings/appearance', detailNonEmpty: true,
  });
  // Lines 606–607: choose Right natively.
  await client.scrollIntoViewIfNeeded('[data-testid="message-swipe-select"]', '[data-testid="settings-detail"]');
  await client.tapCurrent('[data-testid="message-swipe-select"] button');
  await client.tapCurrent('[data-testid="message-swipe-right"]');
  const chosen = await waitForNativeShellState(
    () => readNativeSwipePreference(client.device, APPLICATION_ID),
    passes((value) => assertSeededPreference(value, 'right')),
    'native Preferences hold Right after the native choice',
    client.signal,
    SETTINGS_MS,
  );
  await receipt(context, 'native-preference-chosen', chosen);
  // Navigation 64–102 (Android branch): unwind the native Settings routes with Back.
  await client.tapCurrent('trn-settings button[aria-label="Back"]');
  const unwound = await view(context, [], assertSectionUnwound, 'Back left the section', SETTINGS_MS);
  await record(context, 'settings-section-unwound', () => assertSectionUnwound(unwound), {
    path: new URL(unwound.href).pathname === '/settings' ? '/settings' : '/rooms',
  });
  if (new URL(unwound.href).pathname === '/settings')
    await client.tapCurrent('trn-settings button[aria-label="Back"]');
  const back = await view(context, [], (value) => assertAccountRooms(value.href, userId),
    'Account-qualified Rooms route after Settings', SETTINGS_MS);
  await record(context, 'rooms-route-restored', () => assertAccountRooms(back.href, userId), {
    rooms: true, accountQualified: true,
  });
  const detached = await view(context, [], assertSettingsDetached, 'Settings detached', SETTINGS_MS);
  await record(context, 'settings-detached', () => assertSettingsDetached(detached), { hosts: 0 });
  await record(context, 'settings-dialog-hidden', () => assertSettingsDialogHidden(detached), { dialogs: 0 });
  await record(context, 'no-settings-path', () => assertNoSettingsPath(detached), { settingsPath: false });
  // Lines 616–623: the same Room again, without a reload.
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: arranged.room.name }, ROOM_OPEN_MS);
  await client.tapCurrent('.channel', { text: arranged.room.name });
  const live = await view(context, targets, (value) => {
    assertAffordanceLive(value, own);
    assertSameDocument(value, opened.timeOrigin);
  }, 'the affordance is live in the same document', AFFORDANCE_MS);
  await record(context, 'affordance-live', () => {
    assertAffordanceLive(live, own);
    assertSameDocument(live, opened.timeOrigin);
  }, { affordances: 1, sameDocument: true });
}

const STAGE_RUNNERS: Readonly<Record<
  MessageSwipeStageId,
  (context: MessageSwipeStageContext) => Promise<void>
>> = {
  'edit-own': runEditOwn,
  'reply-other': runReplyOther,
  'partial-affordance': runPartialAffordance,
  'progressive-feedback': runProgressiveFeedback,
  'off-inert': runOffInert,
  'left-direction': runLeftDirection,
  'left-strip-geometry': runLeftStripGeometry,
  'vertical-abandon': runVerticalAbandon,
  'vertical-scroll': runVerticalScroll,
  'edge-dead-zones': runEdgeDeadZones,
  'drawer-left': runDrawerLeft,
  'drawer-off': runDrawerOff,
  'drawer-right': runDrawerRight,
  'live-setting': runLiveSetting,
};

interface StageReport {
  readonly id: MessageSwipeStageId;
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
  assertions: MessageSwipeAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 14;
  readonly expectedUniqueAssertions: 74;
  readonly expectedAssertionRecords: 74;
  readonly attempt: 1;
  readonly retries: 0;
  readonly applications: readonly string[];
  readonly stages: StageReport[];
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
 * The error rethrown to the test reporter after a failed stage: the shared
 * public rethrow keeps only names and first message lines, with every
 * registered secret and every Matrix Room and event-id shape redacted.
 */
export function redactStageFailure(
  stageId: string,
  failures: readonly unknown[],
  secrets: Readonly<Record<string, string>>,
): Error {
  return publicStageFailure(`Android message-swipe ${stageId} failed`, failures,
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
  return new Error(`Message-swipe cleanup failed: ${label} (${parts.join('; ')})`);
}

export interface GuardedCleanupState {
  readonly safety: MessageSwipePublicationSafety;
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

/** Register cleanups that block publication when they fail; only an id-free error is rethrown. */
export function guardMessageSwipeCleanup(
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

/** The bounded per-stage teardown: held touch, navigation mode, client and app data. */
export function stageTeardown(context: Pick<MessageSwipeStageContext, 'touch' | 'navigationRestore' | 'client'>,
  clear: () => Promise<void>, keepApp: boolean): readonly (() => Promise<void>)[] {
  return [
    async () => { const touch = context.touch; context.touch = null; await touch?.dispose(); },
    () => context.client.close(),
    async () => { await context.navigationRestore?.(); },
    async () => { if (!keepApp) await clear(); },
  ];
}

/** Single-attempt, fourteen-stage run with post-cleanup publication safety. */
export async function runMessageSwipeSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'message-swipe');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(MESSAGE_SWIPE_STAGES.length, 14, 'Message-swipe runs fourteen stages');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 14,
          expectedUniqueAssertions: 74,
          expectedAssertionRecords: 74,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeMessageSwipePublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: MessageSwipePublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardMessageSwipeCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan message-swipe diagnostics', () =>
          report.status === 'passed'
            ? markMessageSwipeDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanMessageSwipeArtifacts(output, secrets));
        guardedCleanup('Scrub message-swipe diagnostics', async () => {
          try { await scrubMessageSwipeArtifacts(output, secrets); }
          catch (error) { safety.scrubFailed = true; throw error; }
        });
        try {
          const device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          guardedCleanup('Message-swipe Android device', () => device.close());
          guardedCleanup('Message-swipe application data', () => device.clearApplicationData(APPLICATION_ID));
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
          const suite: SuiteState = { shared: new SharedStageAccount('swipe-actor'), signedIn: false };
          for (const entry of MESSAGE_SWIPE_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: MessageSwipeAssertion[] = [];
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
            console.info(`[message-swipe] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: MessageSwipeStageContext = {
              entry,
              client,
              fixtures,
              secrets,
              safety,
              records,
              identities,
              suite,
              receipts: 0,
              native: false,
              touch: null,
              navigationRestore: null,
              ledger: {
                run: `${resources.aliasLocalpart(`swipe-${entry.id}`)}${entry.arrangement.tag}`,
                texts: [],
                eventIds: [],
              },
            };
            try {
              protect(context, {});
              await STAGE_RUNNERS[entry.id](context);
              assertMessageSwipeRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              try { if (context.native) await client.capture('failed'); }
              catch (captureError) { failures.push(captureError); }
            } finally {
              const stageFailures = failures.length;
              // The shared Account's app state survives a passing stage; the
              // suite-level cleanup clears it after the last stage.
              await runMessageSwipeStageCleanup(stageTeardown(context,
                () => device.clearApplicationData(APPLICATION_ID), failures.length === 0), failures);
              if (failures.length > stageFailures) safety.cleanupFailed = true;
              stage.assertions = [...records];
              stage.assertionRecords = records.length;
              stage.receipts = context.receipts;
              stage.durationMs = performance.now() - started;
              stage.failureCount = failures.length;
              stage.status = failures.length ? 'failed' : 'passed';
              if (failures.length) stage.error = failures.map(describeFailure).join('\n');
              await save();
              console.info(`[message-swipe] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, MESSAGE_SWIPE_ASSERTION_RECORDS,
            'Every message-swipe parity identity was emitted once');
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
  void test('Android message-swipe journeys', { timeout: 1_800_000 },
    runMessageSwipeSuite);
}
