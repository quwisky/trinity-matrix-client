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
  type AccountElementFilter,
  type AccountViewportProfile,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';
import {
  GATES,
  GENERAL_TOUCH_PROFILE,
  MOBILE_SHEET_PROFILE,
  REACTION_GROUP,
  RUN_TAGS,
  WHO_REACTED_ASSERTION_RECORDS,
  WHO_REACTED_STAGES,
  assertApiLogin,
  assertArrangement,
  assertCloseVisible,
  assertComposerVisible,
  assertDetailOverflow,
  assertDialogDismissed,
  assertDirectoryOverflow,
  assertDirectoryScrolled,
  assertDialogTotal,
  assertDialogVisible,
  assertEventSent,
  assertGate,
  assertGroupCount,
  assertJoined,
  assertKeyCount,
  assertKeyPressed,
  assertLongReactorEllipsis,
  assertLongReactorListed,
  assertLastKeyPressed,
  assertLongReactorOverflow,
  assertMode,
  assertReactionsArranged,
  assertReactors,
  assertRoomCreated,
  assertRoomsRoute,
  assertSectionUnwound,
  assertSettingsDetached,
  assertSettingsSections,
  assertSheetBottom,
  assertSheetClass,
  assertSheetLeft,
  assertSheetRight,
  assertTargetRow,
  assertThumbsCount,
  assertThumbsSummary,
  assertWhoReactedReceiptName,
  assertWhoReactedRecords,
  bodyOf,
  longReactorNameOf,
  otherRole,
  reactionPlan,
  readerRole,
  roomNameOf,
  targetTxnOf,
  whoReactedAssertion,
  type RoomEvent,
  type WhoReactedAssertion,
  type WhoReactedStage,
  type WhoReactedStageId,
} from './who-reacted-contract.mts';
import {
  readReactionDialog,
  readReactionRow,
  readShellRoute,
  type ReactionDialogObservation,
  type ReactionRowObservation,
  type ShellRouteObservation,
} from './who-reacted-observer.mts';
import { readAppliedProfile, type ObservationOptions } from './message-quote-observer.mts';
import {
  markWhoReactedDiagnosticsSafe,
  revokeWhoReactedPublicationOnAbort,
  whoReactedSecrets,
  type WhoReactedPublicationSafety,
  type WhoReactedSecretIds,
} from './who-reacted-artifacts.mts';
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
  readonly entry: WhoReactedStage;
  readonly records: WhoReactedAssertion[];
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

export interface WhoReactedStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: AccountFixtures;
  readonly secrets: Record<string, string>;
  readonly safety: WhoReactedPublicationSafety;
  readonly ledger: SecretLedger;
  readonly signal: AbortSignal;
  /** Set once `client.reset` has attached a WebView that can be captured. */
  native: boolean;
  /** Every reaction event id, in send order. */
  reactionIds: string[];
}

/** A parity identity is emitted only after its proof passed, in contract order. */
export async function record(
  context: RecordContext,
  suffix: string,
  assertion: () => void,
  observation: unknown,
): Promise<void> {
  const identity = whoReactedAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Who-reacted parity records stay in source order');
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
  assertWhoReactedReceiptName(name);
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
  context: WhoReactedStageContext,
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
  const ids: WhoReactedSecretIds = {
    accounts: ledger.accounts.map(({ userId, username, password }) => ({ userId, username, password })),
    rooms: ledger.rooms,
    texts: ledger.texts,
    eventIds: ledger.eventIds,
    transactions: ledger.transactions,
  };
  Object.assign(context.secrets, whoReactedSecrets(context.entry.id, ids));
}

export function whoReactedTeardown(
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
export async function finishWhoReactedStage(
  client: Pick<AccountWorkspaceClient, 'close'>,
  device: { clearApplicationData(id: string): Promise<unknown> },
  failures: unknown[],
): Promise<boolean> {
  const before = failures.length;
  await runPinnedPanelStageCleanup(whoReactedTeardown(client, device), failures);
  return failures.length > before;
}

const APPLICATION_ID = 'eu.qwky.trinity';
const RAIL = '[data-testid="rail-rooms"]';
const WHO = '[data-testid="reactions-who"]';
const KEY = '[data-testid="reactions-key"]';
const CLOSE = '[data-testid="close-reactions"]';
const LAST_KEY = '[data-testid="reactions-directory"] > [data-testid="reactions-key"]:last-of-type';
const SETTINGS_BACK = 'trn-settings button[aria-label="Back"]';
const TIMELINE = '.scroll';
const READY_ROW = '.scroll .msg[data-mid^="$"]';
const BACK_FLOW = 'e2e/android/flows/native-shell-back.yaml';
// Bounds (spec D4): at least the predecessor's own; 10/15 s and default 5 s become 20 s.
const ROOM_ROW_MS = 30_000;   // 230 waitFor
const UI_MS = 20_000;         // 232, 256, 278, 320, 348–477, 529, 583–707 except the 30 s ones
const REACTION_MS = 30_000;   // 265, 271, 558, 562 and every gate
const SERVER_MS = 30_000;     // reactions-arranged read-back

/** Time left of `boundMs` since `since`, never below 1 ms. */
function left(boundMs: number, since: number): number {
  return Math.max(boundMs - (Date.now() - since), 1);
}

/** A native tap whose return time anchors every following window. */
async function tap(context: WhoReactedStageContext, selector: string,
  filter: AccountElementFilter = {}): Promise<number> {
  await context.client.tapCurrent(selector, filter);
  return Date.now();
}

/** Android host Back through the shared Back flow; its return anchors the dismissal. */
export async function pressHostBack(context: WhoReactedStageContext): Promise<number> {
  const { client } = context;
  await client.device.runFlow(join(client.workspaceRoot, BACK_FLOW), { APP_ID: APPLICATION_ID });
  return Date.now();
}

/** Poll a renderer read until `check` passes; on timeout rethrow `check`'s own failure on the last read. */
async function until<T>(context: WhoReactedStageContext,
  read: (options: ObservationOptions<T>) => Promise<T>, check: (value: T) => void,
  timeoutMs: number, description: string): Promise<T> {
  let last: T | undefined;
  try {
    return await read({ accepts: (v) => { last = v; return passes(check)(v); }, timeoutMs, description });
  } catch (error) {
    if (last !== undefined && error instanceof Error && error.message.startsWith('Timed out waiting for')) check(last);
    throw error;
  }
}

async function server<T>(context: WhoReactedStageContext, read: () => Promise<T>,
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

async function startNative(context: WhoReactedStageContext, profile: AccountViewportProfile): Promise<void> {
  assert(!context.safety.unsafeSecrets, 'Every stage identifier is registered before any UI step');
  await context.client.reset(profile);
  context.native = true;
  const applied = await readAppliedProfile(context.client);
  const label = context.entry.id === 'pill-dialog' ? 'general touch profile' : 'mobile sheet profile';
  assert(applied.innerWidth === profile.width && applied.innerHeight === profile.height
    && Math.abs(applied.devicePixelRatio - (profile.deviceScaleFactor ?? 1)) < 1e-6
    && applied.coarsePointer && applied.hoverNone && applied.platform === 'android',
  `The applied profile is the ${label}`);
  await context.client.record('profile-applied', {
    requested: profile, digest: digest(JSON.stringify(profile)), ...applied,
  });
}

export interface Arranged {
  readonly runId: string;
  readonly roomName: string;
  readonly body: string;
  readonly longName: string;
  readonly reader: NodeWorkspaceAccount;
  readonly others: readonly NodeWorkspaceAccount[];
  readonly room: { readonly id: string; readonly name: string };
  readonly targetId: string;
}

/** Spec D2: 17 Accounts, the long name, the public Room, 16 rate-limited joins and the target. */
export async function arrangeStage(context: WhoReactedStageContext): Promise<Arranged> {
  const { fixtures, ledger, entry } = context;
  const runId = ledger.run;
  const roomName = roomNameOf(runId);
  const body = bodyOf(runId);
  const longName = longReactorNameOf(runId);
  const plan = reactionPlan(runId);
  protect(context, { rooms: [{ name: roomName }], texts: [body, longName],
    transactions: [targetTxnOf(runId), ...new Set(plan.map(({ txn }) => txn))] });
  const reader = await fixtures.account(readerRole(entry.id));
  protect(context, { accounts: [reader] });
  await record(context, 'api-login-reader', () => assertApiLogin(reader), { userMatches: true });
  const others: NodeWorkspaceAccount[] = [];
  for (let n = 1; n <= 16; n++) {
    const other = await fixtures.account(otherRole(entry.id, n));
    protect(context, { accounts: [other] });
    others.push(other);
    await record(context, `api-login-other-${String(n).padStart(2, '0')}`, () => assertApiLogin(other), { userMatches: true });
  }
  // 108 and 217–218: the predecessor's long localpart is what the room shows; set before the join.
  await fixtures.setDisplayName(others[0]!, longName);
  const room = await fixtures.createRoom(reader, { name: roomName, preset: 'public_chat' });
  protect(context, { rooms: [{ id: room.id }] });
  await record(context, 'room-created', () => assertRoomCreated(room.id), { roomDigest: digest(room.id) });
  for (const [index, other] of others.entries()) {
    const joined = await fixtures.joinHonoringRateLimit(other, room.id);
    await record(context, `join-other-${String(index + 1).padStart(2, '0')}`, () => assertJoined(joined),
      { status: joined.status, attempts: joined.attempts, retryAfterMs: joined.retryAfterMs });
  }
  const targetId = await fixtures.sendMessage(reader, room.id, body, targetTxnOf(runId));
  protect(context, { eventIds: [targetId] });
  await record(context, 'target-sent', () => assertEventSent(targetId), { eventDigest: digest(targetId) });
  assertArrangement(historyOf(await fixtures.roomMessages(reader, room.id)) as unknown as readonly RoomEvent[],
    { readerId: reader.userId, otherIds: others.map(({ userId }) => userId), targetId, runId });
  await receipt(context, 'arranged', { joinedMembers: 17, messages: 1, joinRule: 'public', longName: true,
    roomDigest: digest(room.id) });
  context.safety.unsafeSecrets = false;
  return { runId, roomName, body, longName, reader, others, room, targetId };
}

/** 227–235 and 256/553: sign in, open the exact Room, and bind the target row. */
export async function openArrangedRoom(context: WhoReactedStageContext, a: Arranged,
  profile: AccountViewportProfile): Promise<void> {
  const { client } = context;
  await startNative(context, profile);
  await client.login(a.reader);
  await client.hideKeyboard();
  await enterRoom(context, a, 'room-open');
  const readyAt = Date.now();
  const row = await until(context, (o) => readReactionRow(client, a.body, a.targetId, o),
    assertTargetRow, left(UI_MS, readyAt), 'the arranged target row');
  await record(context, 'target-visible', () => assertTargetRow(row), { rows: 1, exactEvent: true });
}

/** `openRoom` (227–235): rail, the Room row within 30 s, then its composer (232). */
async function enterRoom(context: WhoReactedStageContext, a: Arranged, suffix: string): Promise<void> {
  const { client } = context;
  const railAt = await tap(context, RAIL);
  await client.visible('.channel', { text: a.roomName }, left(ROOM_ROW_MS, railAt));
  const openedAt = await tap(context, '.channel', { text: a.roomName });
  const opened = await until(context, (o) => readShellRoute(client, o), assertComposerVisible,
    left(UI_MS, openedAt), 'composer of the exact Room');
  await record(context, suffix, () => assertComposerVisible(opened), { composerVisible: true });
}

/** Spec D5: the predecessor's 36 sends in groups of 8, gated on the rendered row. */
export async function sendPacedReactions(context: WhoReactedStageContext, a: Arranged): Promise<number> {
  const { client, fixtures } = context;
  const plan = reactionPlan(a.runId);
  const senderOf = (index: number): NodeWorkspaceAccount => (index === 0 ? a.reader : a.others[index - 1]!);
  const ids: string[] = [];
  let lastSentAt = 0;
  for (let start = 0, group = 0; start < plan.length; start += REACTION_GROUP, group++) {
    for (const entry of plan.slice(start, start + REACTION_GROUP)) {
      const id = await fixtures.sendReaction(senderOf(entry.sender), a.room.id, a.targetId, entry.key, entry.txn);
      lastSentAt = Date.now();
      protect(context, { eventIds: [id] });
      ids.push(id);
      await record(context, `reaction-${String(entry.n).padStart(2, '0')}`, () => assertEventSent(id),
        { key: entry.key, sender: entry.sender === 0 ? 'reader' : `other-${entry.sender}`, eventDigest: digest(id) });
    }
    const gate = GATES[group];
    if (gate === undefined) break;
    const sentAt = lastSentAt;
    const row = await until<ReactionRowObservation>(context, (o) => readReactionRow(client, a.body, a.targetId, o),
      (r) => assertGate(r, gate), left(REACTION_MS, sentAt), `reaction gate ${group + 1}`);
    await receipt(context, `reaction-gate-${group + 1}`, { thumbs: row.thumbsCount, groups: row.pills,
      waitedMs: Date.now() - sentAt });
  }
  context.reactionIds = ids;
  return lastSentAt;
}

/** Spec D5 read-back: every reaction on the server, exactly as planned. */
async function proveReactionsArranged(context: WhoReactedStageContext, a: Arranged,
  lastSentAt: number): Promise<void> {
  const expected = () => ({ plan: reactionPlan(a.runId), ids: context.reactionIds,
    readerId: a.reader.userId, otherIds: a.others.map(({ userId }) => userId), targetId: a.targetId });
  const events = await server(context,
    async () => await context.fixtures.reactionRelations(a.reader, a.room.id, a.targetId) as unknown as readonly RoomEvent[],
    (e) => { assertReactionsArranged(e, expected()); }, lastSentAt, 'the 36 reactions on the server', SERVER_MS);
  await receipt(context, 'reactions-arranged', assertReactionsArranged(events, expected()));
}

/** 318/578/617: reveal the chip natively when the composer covers it, then tap it. */
export async function revealAndOpenDialog(context: WhoReactedStageContext, a: Arranged,
  suffix: string, prefix: '' | 'light-' | 'dark-'): Promise<ReactionDialogObservation> {
  const { client } = context;
  const within = { selector: READY_ROW, text: a.body };
  const before = await readReactionDialog(client, a.longName);
  assert.equal(before.dialogs, 0, 'There is no Reactions dialog before the native tap');
  await receipt(context, `${prefix}dialog-absent`, { dialogs: 0 });
  await client.scrollIntoViewIfNeeded(WHO, TIMELINE, { within });
  const tappedAt = await tap(context, WHO, { within });
  const dialog = await until(context, (o) => readReactionDialog(client, a.longName, o), assertDialogVisible,
    left(UI_MS, tappedAt), 'the Reactions dialog');
  await record(context, suffix, () => assertDialogVisible(dialog), { dialogs: 1 });
  return dialog;
}

/** Consecutive records: each polls from the read that satisfied the previous one. */
async function chain<T>(context: WhoReactedStageContext, read: (o: ObservationOptions<T>) => Promise<T>,
  steps: readonly (readonly [suffix: string, check: (v: T) => void, evidence: (v: T) => unknown])[],
  bound = UI_MS): Promise<T> {
  let value: T | undefined;
  for (const [suffix, check, evidence] of steps) {
    const anchor = Date.now();
    value = await until(context, read, check, left(bound, anchor), suffix);
    const settled = value;
    await record(context, suffix, () => check(settled), evidence(settled));
  }
  assert(value !== undefined, 'A chain has at least one record');
  return value;
}

export async function runPillDialog(context: WhoReactedStageContext): Promise<void> {
  const { client } = context;
  const a = await arrangeStage(context);
  await openArrangedRoom(context, a, GENERAL_TOUCH_PROFILE);
  const lastSentAt = await sendPacedReactions(context, a);
  const row = (o: ObservationOptions<ReactionRowObservation>) => readReactionRow(client, a.body, a.targetId, o);
  // 265 anchors at the last send's return; 271 and 278 follow on (spec D4).
  const counted = await until(context, row, assertThumbsCount, left(REACTION_MS, lastSentAt), '👍 17');
  await record(context, 'thumbs-count', () => assertThumbsCount(counted), { thumbsCount: 17 });
  await chain(context, row, [
    ['group-count', assertGroupCount, (r) => ({ groups: r.pills })],
  ], REACTION_MS);
  await chain(context, row, [
    ['thumbs-summary', assertThumbsSummary, (r) => ({ matches: true, others: r.summaryOthers })],
  ]);
  await proveReactionsArranged(context, a, lastSentAt);
  await revealAndOpenDialog(context, a, 'dialog-visible', '');
  const dialog = (o: ObservationOptions<ReactionDialogObservation>) => readReactionDialog(client, a.longName, o);
  const shape = await chain(context, dialog, [
    ['dialog-total', assertDialogTotal, () => ({ total: 36 })],
    ['close-visible', assertCloseVisible, () => ({ closeVisible: true })],
    ['key-count', assertKeyCount, (d) => ({ keys: d.keys })],
    ['long-reactor-listed', assertLongReactorListed, () => ({ listed: true })],
    ['thumbs-reactors', (d) => assertReactors(d, 17), (d) => ({ reactors: d.reactors })],
    ['long-reactor-ellipsis', assertLongReactorEllipsis, () => ({ textOverflow: 'ellipsis' })],
    ['long-reactor-overflow', assertLongReactorOverflow, (d) => ({ overflowPx: d.longName.overflow })],
    ['detail-overflow', assertDetailOverflow, (d) => ({ detailOverflowPx: d.detailOverflow })],
  ]);
  await receipt(context, 'dialog-shape', { sheet: shape.sheetHost, pressed: shape.pressedKeys,
    directoryOverflowPx: shape.directory ? shape.directory.scrollWidth - shape.directory.clientWidth : null });
  // 472–477: the heart by native touch.
  const heartAt = await tap(context, KEY, { text: '❤️' });
  const heart = await until(context, dialog, (d) => assertKeyPressed(d, '❤️'), left(UI_MS, heartAt), '❤️ pressed');
  await record(context, 'heart-pressed', () => assertKeyPressed(heart, '❤️'), { pressed: ['❤️'] });
  await chain(context, dialog, [['heart-reactors', (d) => assertReactors(d, 1), (d) => ({ reactors: d.reactors })]]);
  // 528–529: host Back (issue), where the predecessor pressed Escape.
  const backAt = await pressHostBack(context);
  const closed = await until(context, dialog, assertDialogDismissed, left(UI_MS, backAt), 'dialog dismissed');
  await record(context, 'dialog-dismissed', () => assertDialogDismissed(closed), { dialogs: 0 });
  const recovered = await until(context, (o) => readShellRoute(client, o), assertComposerVisible,
    left(UI_MS, Date.now()), 'the Room after Back');
  const same = await client.eventIdentity(READY_ROW, { text: a.body }, a.targetId);
  assert(same.matches === 1 && same.exactEvent, 'Back returned to the same Room and target');
  await receipt(context, 'room-recovered', { composerVisible: recovered.composerVisible, sameRoom: true });
}

/** 568–575 (light) and 607–615 (dark): the real native Settings path and back to the same Room. */
export async function roundTripAppearance(context: WhoReactedStageContext, a: Arranged,
  mode: 'light' | 'dark'): Promise<void> {
  const { client } = context;
  const route = (o: ObservationOptions<ShellRouteObservation>) => readShellRoute(client, o);
  const start = await readShellRoute(client);
  // The predecessor's conditional (568/608): the tap's return anchors the window, else the read before it.
  const anchor = start.backToRoomsVisible ? await tap(context, '[data-testid="back-to-rooms"]') : Date.now();
  await receipt(context, `${mode}-back-to-rooms`, { visible: start.backToRoomsVisible, tapped: start.backToRoomsVisible });
  // Navigation 19–35 (Android path).
  const rooms = await until(context, route, (r) => assertRoomsRoute(r, a.reader.userId), left(UI_MS, anchor), 'Rooms route');
  await record(context, `${mode}-rooms-route`, () => assertRoomsRoute(rooms, a.reader.userId), { rooms: true, accountQualified: true });
  const sectionsAt = rooms.path.startsWith('/settings') ? Date.now() : await tap(context, '[data-testid="open-settings"]');
  const sections = await until(context, route, assertSettingsSections, left(UI_MS, sectionsAt), 'Settings sections');
  await record(context, `${mode}-settings-sections`, () => assertSettingsSections(sections), { sectionsVisible: true });
  // 570–572 / 610–612.
  await tap(context, '[data-testid="settings-nav-appearance"]');
  const modeAt = await tap(context, `[data-testid="mode-${mode}"]`);
  const applied = await until(context, route, (r) => assertMode(r, mode), left(UI_MS, modeAt), `${mode} mode`);
  await record(context, `${mode}-mode`, () => assertMode(applied, mode), { dark: applied.dark });
  // Navigation 64–102 (Android path): the in-page Back button, twice when the first lands on /settings.
  const firstBackAt = await tap(context, SETTINGS_BACK);
  const unwound = await until(context, route, assertSectionUnwound, left(UI_MS, firstBackAt), 'Settings section unwound');
  await record(context, `${mode}-section-unwound`, () => assertSectionUnwound(unwound), { settingsRoot: unwound.path === '/settings' });
  const restoredAnchor = unwound.path === '/settings' ? await tap(context, SETTINGS_BACK) : Date.now();
  const restored = await until(context, route, (r) => assertRoomsRoute(r, a.reader.userId), left(UI_MS, restoredAnchor), 'Rooms restored');
  await record(context, `${mode}-rooms-restored`, () => assertRoomsRoute(restored, a.reader.userId), { rooms: true, accountQualified: true });
  const detached = await until(context, route, assertSettingsDetached, left(UI_MS, Date.now()), 'Settings detached');
  await record(context, `${mode}-settings-detached`, () => assertSettingsDetached(detached), { settingsHosts: 0 });
  // 574 / 614: the same Room again.
  await enterRoom(context, a, `${mode}-room-open`);
  const same = await client.eventIdentity(READY_ROW, { text: a.body }, a.targetId);
  assert(same.matches === 1 && same.exactEvent, 'The same Room and target reopened');
  await receipt(context, `${mode}-same-room`, { sameRoom: true });
}

const MAX_DIRECTORY_SWIPES = 6;
const SWIPE_MS = 20_000;

/**
 * Spec D7: native horizontal swipes on the reaction directory until its last
 * key is unobstructed. Renderer access only measures; the swipe is a Maestro
 * flow at points mapped by the client's read-only `nativeRect`.
 */
export async function swipeDirectory(context: WhoReactedStageContext, a: Arranged): Promise<number> {
  const { client } = context;
  for (let swipe = 1; swipe <= MAX_DIRECTORY_SWIPES + 1; swipe++) {
    const before = await readReactionDialog(client, a.longName);
    if (before.lastKey.unobstructed) return swipe - 1;
    assert(swipe <= MAX_DIRECTORY_SWIPES, 'The last key within six native swipes');
    assert(before.directory, 'The reaction directory is rendered');
    const native = await client.nativeRect(before.directory.rect);
    const y = Math.round((native.topLeft.y + native.bottomRight.y) / 2);
    const span = native.bottomRight.x - native.topLeft.x;
    const startX = Math.round(native.topLeft.x + span * 0.8);
    const endX = Math.round(native.topLeft.x + span * 0.2);
    const flow = join(client.output, `accounts-point-swipe-directory-${swipe}.yaml`);
    await writeFile(flow, `appId: ${APPLICATION_ID}\n---\n- swipe:\n    start: "${startX},${y}"\n    end: "${endX},${y}"\n    duration: 600\n`);
    await client.device.runFlow(flow, {});
    const swipedAt = Date.now();
    const after = await until<ReactionDialogObservation>(context, (o) => readReactionDialog(client, a.longName, o),
      (d) => assert((d.directory?.scrollLeft ?? 0) > before.directory!.scrollLeft,
        'The native swipe advanced the directory'), left(SWIPE_MS, swipedAt), 'directory swipe');
    await receipt(context, `directory-swipe-${swipe}`, { before: before.directory.scrollLeft,
      after: after.directory!.scrollLeft, max: after.directory!.scrollWidth - after.directory!.clientWidth });
  }
  throw new Error('unreachable');
}

export async function runMobileSheet(context: WhoReactedStageContext): Promise<void> {
  const { client } = context;
  const a = await arrangeStage(context);
  await openArrangedRoom(context, a, MOBILE_SHEET_PROFILE);
  const lastSentAt = await sendPacedReactions(context, a);
  const row = (o: ObservationOptions<ReactionRowObservation>) => readReactionRow(client, a.body, a.targetId, o);
  const counted = await until(context, row, assertThumbsCount, left(REACTION_MS, lastSentAt), '👍 17');
  await record(context, 'thumbs-count', () => assertThumbsCount(counted), { thumbsCount: 17 });
  await chain(context, row, [['group-count', assertGroupCount, (r) => ({ groups: r.pills })]], REACTION_MS);
  await proveReactionsArranged(context, a, lastSentAt);
  const dialog = (o: ObservationOptions<ReactionDialogObservation>) => readReactionDialog(client, a.longName, o);
  await roundTripAppearance(context, a, 'light');
  await revealAndOpenDialog(context, a, 'light-dialog-visible', 'light-');
  const sheet = await chain(context, dialog, [['sheet-class', assertSheetClass, () => ({ sheet: true })]]);
  // 586–599: one geometry read decides the three bounds, as the predecessor's single evaluate.
  await record(context, 'sheet-left-bound', () => assertSheetLeft(sheet), { left: sheet.box?.left });
  await record(context, 'sheet-right-bound', () => assertSheetRight(sheet), { right: sheet.box?.right, innerWidth: sheet.innerWidth });
  await record(context, 'sheet-bottom-attached', () => assertSheetBottom(sheet), { bottom: sheet.box?.bottom, innerHeight: sheet.innerHeight });
  await receipt(context, 'light-sheet-paint', { backgroundDigest: digest(sheet.background ?? '') });
  const closeAt = await tap(context, CLOSE);
  const closed = await until(context, dialog, assertDialogDismissed, left(UI_MS, closeAt), 'dialog closed');
  await record(context, 'light-dialog-closed', () => assertDialogDismissed(closed), { dialogs: 0 });
  await roundTripAppearance(context, a, 'dark');
  const dark = await revealAndOpenDialog(context, a, 'dark-dialog-visible', 'dark-');
  assertSheetClass(dark); assertSheetLeft(dark); assertSheetRight(dark); assertSheetBottom(dark);
  assert.notEqual(dark.background, sheet.background, 'The dark sheet paint differs from the light one');
  await receipt(context, 'dark-sheet-usable', { sheet: true, bounded: true, bottomAttached: true, paintChanged: true });
  await chain(context, dialog, [
    ['directory-overflow', assertDirectoryOverflow, (d) => ({ overflowPx: d.directory!.scrollWidth - d.directory!.clientWidth })],
    ['detail-overflow', assertDetailOverflow, (d) => ({ detailOverflowPx: d.detailOverflow })],
  ]);
  await swipeDirectory(context, a);
  const lastAt = await tap(context, LAST_KEY);
  const last = await until(context, dialog, assertLastKeyPressed, left(UI_MS, lastAt), 'last key pressed');
  await record(context, 'last-key-pressed', () => assertLastKeyPressed(last), { key: last.lastKey.key });
  await chain(context, dialog, [
    ['directory-scrolled', assertDirectoryScrolled, (d) => ({ scrollLeft: d.directory!.scrollLeft })],
    ['last-key-reactors', (d) => assertReactors(d, 1), (d) => ({ reactors: d.reactors })],
  ]);
  const backAt = await pressHostBack(context);
  const dismissed = await until(context, dialog, assertDialogDismissed, left(UI_MS, backAt), 'sheet dismissed');
  await record(context, 'dialog-dismissed', () => assertDialogDismissed(dismissed), { dialogs: 0 });
  await chain(context, (o) => readShellRoute(client, o),
    [['composer-visible', assertComposerVisible, () => ({ composerVisible: true })]]);
  await receipt(context, 'room-recovered', { composerVisible: true });
}

const STAGE_RUNNERS: Readonly<Record<
  WhoReactedStageId,
  (context: WhoReactedStageContext) => Promise<void>
>> = {
  'pill-dialog': runPillDialog,
  'mobile-sheet': runMobileSheet,
};

interface StageReport {
  readonly id: WhoReactedStageId;
  readonly source: string;
  readonly title: string;
  readonly profile: 'general-touch' | 'mobile-sheet';
  status: 'running' | 'passed' | 'failed';
  durationMs: number;
  readonly artifact: string;
  readonly attempt: 1;
  readonly retries: 0;
  readonly expectedAssertionRecords: number;
  assertionRecords: number;
  assertions: WhoReactedAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 2;
  readonly expectedUniqueAssertions: 191;
  readonly expectedAssertionRecords: 191;
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
  return publicStageFailure(`Android who-reacted ${stageId} failed`, failures,
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
  return new Error(`Who-reacted cleanup failed: ${label} (${parts.join('; ')})`);
}

/** The run state a failed guarded cleanup marks before it rethrows. */
export interface GuardedCleanupState {
  readonly safety: WhoReactedPublicationSafety;
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
export function guardWhoReactedCleanup(
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
export async function runWhoReactedSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'who-reacted');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(WHO_REACTED_STAGES.length, 2, 'Who-reacted runs two stages');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 2,
          expectedUniqueAssertions: 191,
          expectedAssertionRecords: 191,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeWhoReactedPublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: WhoReactedPublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardWhoReactedCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan who-reacted diagnostics', () =>
          report.status === 'passed'
            ? markWhoReactedDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanPinnedPanelArtifacts(output, secrets));
        guardedCleanup('Scrub who-reacted diagnostics', async () => {
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
          guardedCleanup('Who-reacted Android device', () => device.close());
          // Fixture cleanups register after the device, so they retire first.
          const resources = new MatrixTestResources(matrixResources.namespace);
          resources.cleanup = guardedCleanup;
          const fixtures = createAccountFixtures(resources, signal);
          await installWithAndroidRuntimeProvenance({
            device,
            applicationId: APPLICATION_ID,
            apk: join(session.workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk'),
            rendererManifest: join(session.workspaceRoot, 'dist/web-bundle-manifest.json'),
            profile: GENERAL_TOUCH_PROFILE,
            output: join(output, 'runtime-provenance.json'),
          });
          const identities = new Set<string>();
          for (const entry of WHO_REACTED_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: WhoReactedAssertion[] = [];
            const stage: StageReport = {
              id: entry.id,
              source: entry.source,
              title: entry.title,
              profile: entry.id === 'pill-dialog' ? 'general-touch' : 'mobile-sheet',
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
            console.info(`[who-reacted] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: WhoReactedStageContext = {
              entry,
              client,
              fixtures,
              secrets,
              safety,
              records,
              identities,
              receipts: 0,
              native: false,
              reactionIds: [],
              signal,
              ledger: {
                run: `${resources.namespace.role(RUN_TAGS[entry.id].role)}${RUN_TAGS[entry.id].suffix}`,
                accounts: [],
                rooms: [],
                texts: [],
                eventIds: [],
                transactions: [],
              },
            };
            try {
              await STAGE_RUNNERS[entry.id](context);
              assertWhoReactedRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              try { if (context.native) await client.capture('failed'); }
              catch (captureError) { failures.push(captureError); }
            } finally {
              if (await finishWhoReactedStage(client, device, failures)) safety.cleanupFailed = true;
              stage.assertions = [...records];
              stage.assertionRecords = records.length;
              stage.receipts = context.receipts;
              stage.durationMs = performance.now() - started;
              stage.failureCount = failures.length;
              stage.status = failures.length ? 'failed' : 'passed';
              if (failures.length) stage.error = failures.map(describeFailure).join('\n');
              await save();
              console.info(`[who-reacted] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, WHO_REACTED_ASSERTION_RECORDS,
            'Every who-reacted parity identity was emitted once');
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
  void test('Android who-reacted journeys', { timeout: 1_500_000 }, runWhoReactedSuite);
}
