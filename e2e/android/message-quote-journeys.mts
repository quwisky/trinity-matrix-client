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
  MESSAGE_QUOTE_ASSERTION_RECORDS,
  MESSAGE_QUOTE_RUN_SUFFIX,
  MESSAGE_QUOTE_STAGES,
  PARAGRAPH_SENTINEL,
  QUOTE_IMAGE_BODY,
  QUOTE_IMAGE_FILENAME,
  assertAnswerOutside,
  assertAnswerVisible,
  assertCapabilityRoom,
  assertComposerCaret,
  assertComposerQuote,
  assertCopyVisible,
  assertDraftSent,
  assertImageRow,
  assertMessageQuoteReceiptName,
  assertMessageQuoteRecords,
  assertNativeSheetReady,
  assertNoQuote,
  assertOneBlockquote,
  assertQuoteBlockRoom,
  assertQuoteVisible,
  assertQuotesFirst,
  assertQuotesSecond,
  assertRoomReady,
  assertRowVisible,
  assertSameRow,
  assertSendEnabled,
  assertServerEcho,
  assertSheetClosed,
  authoritativeRoomMessages,
  messageQuoteAssertion,
  messageQuoteRoomName,
  quoteAnswer,
  quoteControl,
  quoteEventBody,
  quoteFirst,
  quoteImagePng,
  quoteImageTransaction,
  quoteSourceBody,
  quoteSourceSteps,
  quotedComposer,
  type MessageQuoteAssertion,
  type MessageQuoteStage,
  type MessageQuoteStageId,
  type SheetObservation,
  type TimelineObservation,
} from './message-quote-contract.mts';
import {
  readAppliedProfile,
  readComposer,
  readSheet,
  readTimeline,
} from './message-quote-observer.mts';
import {
  markMessageQuoteDiagnosticsSafe,
  messageQuoteSecrets,
  redactSecretText,
  revokeMessageQuotePublicationOnAbort,
  runMessageQuoteStageCleanup,
  scanMessageQuoteArtifacts,
  scrubMessageQuoteArtifacts,
  type MessageQuotePublicationSafety,
  type MessageQuoteSecretIds,
} from './message-quote-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const SEND = '[data-testid="composer-send"]';
const SHEET = '[role="dialog"][aria-label="Message actions"]';
const SHEET_SCROLL = `${SHEET} [data-testid="action-sheet-surface"] .overflow-y-auto`;
const QUOTE = '[data-testid="sheet-quote"]';
const CANCEL = `${SHEET} button`;
/** Reconciled message rows; the text filter picks one and is never logged. */
const READY_ROW = '.scroll .msg[data-mid^="$"]';
const APPEND_FLOW = 'e2e/android/flows/message-quote-append.yaml';

// Polling bounds: each is at least the predecessor's own bound.
const ROOM_OPEN_MS = 30_000;
const DRAFT_MS = 15_000;
const SEND_READY_MS = 20_000;
const RENDER_MS = 20_000;
const ECHO_MS = 20_000;
const EVENTS_MS = 20_000;
const SHEET_MS = 15_000;
const QUOTE_MS = 10_000;
/** Native in-sheet swipes allowed before Cancel must be reachable. */
const SHEET_SWIPES = 8;

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

/** The minimum a parity record or receipt needs; the guard drives it with a fake client. */
export interface RecordContext {
  readonly entry: MessageQuoteStage;
  readonly records: MessageQuoteAssertion[];
  /** Suite-wide identities, so a duplicate can never be emitted twice. */
  readonly identities: Set<string>;
  receipts: number;
  readonly client: Pick<AccountWorkspaceClient, 'record'>;
}

/** Every identifier a stage creates, registered before any UI step. */
interface SecretLedger {
  readonly run: string;
  account?: MessageQuoteSecretIds['account'];
  room?: { id?: string; name?: string };
  contentUri?: string;
  readonly eventIds: string[];
}

export interface MessageQuoteStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: AccountFixtures;
  readonly secrets: Record<string, string>;
  readonly safety: MessageQuotePublicationSafety;
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
  const identity = messageQuoteAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Message-quote parity records stay in source order');
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
  assertMessageQuoteReceiptName(name);
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
  context: MessageQuoteStageContext,
  patch: {
    readonly account?: NodeWorkspaceAccount;
    readonly room?: { readonly id?: string; readonly name?: string };
    readonly contentUri?: string;
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
  if (patch.contentUri !== undefined) ledger.contentUri = patch.contentUri;
  ledger.eventIds.push(...(patch.eventIds ?? []));
  Object.assign(context.secrets, messageQuoteSecrets(context.entry.id, ledger));
}

/**
 * Arrange one fresh Account and private Room through real Synapse. The quoted
 * source, the answer and the text control are never seeded; they are typed
 * natively below.
 */
async function arrangeStage(
  context: MessageQuoteStageContext,
): Promise<{ readonly account: NodeWorkspaceAccount; readonly room: WorkspaceRoom }> {
  const { fixtures, entry, ledger } = context;
  const name = messageQuoteRoomName[entry.id](ledger.run);
  protect(context, { room: { name } });
  const account = await fixtures.account(`quote-${entry.id}`);
  protect(context, { account });
  const room = await fixtures.createRoom(account, { name, preset: 'private_chat' });
  protect(context, { room: { id: room.id } });
  assert.equal(room.name, name, 'The Room carries the predecessor name template');
  return { account, room };
}

/** Reset to the Pixel 5 phone profile. */
async function startNative(context: MessageQuoteStageContext): Promise<void> {
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

/** Helper 29–37: tap the rail and the exact Room row, then prove its composer. */
async function openRoom(
  context: MessageQuoteStageContext,
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

/** Wait, read-only, for the exact composer value with the caret at `caret`. */
async function composerAt(
  client: AccountWorkspaceClient,
  expected: string,
  caret: number,
  description: string,
): Promise<void> {
  const composer = await readComposer(client, {
    accepts: passes((value) => assertComposerCaret(value, expected, caret)),
    description,
    timeoutMs: DRAFT_MS,
  });
  assertComposerCaret(composer, expected, caret);
}

/**
 * Append one paragraph at the focused composer caret. Android capitalises the
 * first letter of a new paragraph, so the paragraph is typed behind the digit
 * sentinel; the caret then walks back over it, Backspace removes the sentinel
 * and Ctrl+End restores the caret. Each key waits for the state the previous
 * key produced: every key is a separate injection the WebView applies later.
 */
export async function appendNativeLine(
  client: AccountWorkspaceClient,
  prefix: string,
  line: string,
): Promise<void> {
  const typed = `${PARAGRAPH_SENTINEL}${line}`;
  await client.focused(COMPOSER);
  await client.device.runFlow(join(client.workspaceRoot, APPEND_FLOW), {
    APP_ID: client.applicationId,
    SECRET_TEXT: typed,
  });
  await composerAt(client, `${prefix}${typed}`, prefix.length + typed.length,
    'sentinel-prefixed native paragraph');
  for (let offset = 0; offset < line.length; offset++) await client.key('arrowLeft');
  await composerAt(client, `${prefix}${typed}`, prefix.length + 1,
    'native caret just after the sentinel');
  await client.key('backspace');
  await composerAt(client, `${prefix}${line}`, prefix.length,
    'native sentinel removed');
  await client.keyCombination('documentEnd');
  await composerAt(client, `${prefix}${line}`, prefix.length + line.length,
    'native caret restored to the draft end');
}

/**
 * Lines 75–78: the first paragraph through the focused fill, two native Enter
 * presses (a line break each on a mobile device) for the real blank line, then
 * the second paragraph appended at the caret.
 */
export async function enterSourceNatively(
  context: MessageQuoteStageContext,
): Promise<void> {
  const { client } = context;
  await client.focusCurrent(COMPOSER);
  const keys: string[] = [];
  let value = '';
  for (const step of quoteSourceSteps(context.ledger.run)) {
    if (step.kind === 'fill') {
      await client.fillFocused(COMPOSER, step.text, PARAGRAPH_SENTINEL);
    } else if (step.kind === 'enter') {
      await client.focused(COMPOSER);
      await client.key('enter');
    } else {
      await appendNativeLine(client, value, step.text);
    }
    await composerAt(client, step.value, step.value.length,
      `native source ${step.kind} step`);
    value = step.value;
    keys.push(step.kind);
  }
  assert.equal(value, quoteSourceBody(context.ledger.run),
    'The native draft is the exact two-paragraph source');
  await receipt(context, 'source-native-draft', {
    keys,
    paragraphs: value.split('\n\n').length,
    blankLine: value.includes('\n\n'),
    valueLength: value.length,
  });
}

/**
 * Helper 49–55 on a mobile device: with the keyboard dismissed, the composer's
 * Send button is enabled for the exact draft (53), then a native tap sends.
 */
export async function sendDraft(
  context: MessageQuoteStageContext,
  draft: string,
  suffix: string,
  name: string,
): Promise<void> {
  const { client } = context;
  await client.hideKeyboard();
  const enabled = await readComposer(client, {
    accepts: passes((value) => assertSendEnabled(value, draft)),
    description: `${name} Send button enabled with the keyboard dismissed`,
    timeoutMs: SEND_READY_MS,
  });
  await record(context, suffix, () => assertSendEnabled(enabled, draft), {
    exactDraft: true,
    sendEnabled: enabled.sendDisabled === false,
  });
  await client.tapCurrent(SEND);
  const cleared = await readComposer(client, {
    accepts: passes(assertDraftSent),
    description: `${name} composer cleared by the native send`,
    timeoutMs: SEND_READY_MS,
  });
  assertDraftSent(cleared);
  await receipt(context, `${name}-sent`, { cleared: true });
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

/** Helper 177–179: the one row carrying `needle` reconciles to a server event id. */
async function serverEcho(
  context: MessageQuoteStageContext,
  needle: string,
  suffix: string,
): Promise<string> {
  const echo = await timeline(context.client,
    (value) => assertServerEcho(value, needle),
    'row reconciled to a server event', ECHO_MS);
  const row = assertServerEcho(echo, needle);
  protect(context, { eventIds: [row.id] });
  await record(context, suffix, () => assertServerEcho(echo, needle), {
    serverId: row.id.startsWith('$'),
    eventDigest: digest(row.id),
  });
  return row.id;
}

/** Read the Room from real Synapse until `check` accepts its exact messages. */
async function serverMessages(
  context: MessageQuoteStageContext,
  account: NodeWorkspaceAccount,
  room: WorkspaceRoom,
  check: (events: ReturnType<typeof authoritativeRoomMessages>) => void,
  description: string,
): Promise<ReturnType<typeof authoritativeRoomMessages>> {
  const events = await waitForNativeShellState(
    async () => authoritativeRoomMessages(await context.fixtures.roomMessages(account, room.id)),
    passes(check),
    description,
    context.client.signal,
    EVENTS_MS,
  );
  check(events);
  return events;
}

/**
 * Helper 214–222: a native long press opens the Android message-action sheet,
 * proved as the message-forward suite proves it. The row is selected without
 * an identifier (native actions log their selector); the caller has proved,
 * read-only, that exactly one row matches and that it is the expected event.
 */
async function openSheet(
  context: MessageQuoteStageContext,
  selector: string,
  filter: { readonly text?: string },
  suffix: string,
): Promise<SheetObservation> {
  const { client } = context;
  await client.hideKeyboard();
  await client.longPressCurrent(selector, filter);
  const opened = await sheet(client, assertNativeSheetReady, 'Android message-action sheet');
  await record(context, suffix, () => assertNativeSheetReady(opened), {
    oneNativeSheet: opened.dialogs === 1,
    oneForwardAction: opened.forward.count === 1,
  });
  return opened;
}

/** Reach the sheet's last button, Cancel, through bounded native in-sheet swipes. */
async function reachCancel(client: AccountWorkspaceClient): Promise<number> {
  for (let swipe = 0; swipe <= SHEET_SWIPES; swipe++) {
    const [cancel] = await client.waitElements(CANCEL,
      (values) => values.length === 1, 'one Cancel button in the sheet',
      { exactText: 'Cancel' }, SHEET_MS);
    const scroller = await client.visible(SHEET_SCROLL, {}, SHEET_MS);
    if (cancel!.visible && cancel!.unobstructedCenter &&
        cancel!.rect.y >= scroller.rect.y - 1 &&
        cancel!.rect.bottom <= scroller.rect.bottom + 1) return swipe;
    assert(swipe < SHEET_SWIPES, 'Cancel is reachable within the native swipe bound');
    await client.swipeCurrent(SHEET_SCROLL, { direction: 'increase-scroll-top' });
  }
  throw new Error('Native sheet scroll did not expose Cancel');
}

// Stage 1: quote a two-paragraph message and send it as a blockquote (42–115).

export async function runQuoteBlock(context: MessageQuoteStageContext): Promise<void> {
  const { client, ledger } = context;
  const { run } = ledger;
  const { account, room } = await arrangeStage(context);
  context.safety.unsafeSecrets = false;
  const first = quoteFirst(run);
  const answer = quoteAnswer(run);
  await startNative(context);
  await client.login(account);
  await client.hideKeyboard();
  await openRoom(context, room, account);

  // Lines 73–79: two paragraphs with a real blank line, typed and sent natively.
  await enterSourceNatively(context);
  await sendDraft(context, quoteSourceBody(run), 'source-send-enabled', 'source');

  // Lines 81–83: the source row, then its reconciled server event.
  const sourceView = await timeline(client, (value) => assertRowVisible(value, first),
    'visible source row', RENDER_MS);
  const source = assertRowVisible(sourceView, first);
  await record(context, 'source-visible', () => assertRowVisible(sourceView, first), {
    visible: source.visible,
  });
  const sourceId = await serverEcho(context, first, 'source-server-echo');
  const expected = { roomId: room.id, sender: account.userId, run };
  const [sourceEvent] = await serverMessages(context, account, room,
    (events) => assertQuoteBlockRoom(events, { ...expected, sourceId }),
    'authoritative two-paragraph source');
  await receipt(context, 'source-event', {
    eventDigest: digest(sourceId),
    exactBody: true,
    blankLine: true,
    original: true,
    htmlBody: typeof Reflect.get(Object(sourceEvent?.['content']), 'formatted_body') === 'string',
  });

  // Lines 85–87: a native long press on the exact source row, then Quote.
  const target = await timeline(client, (value) => assertSameRow(value, first, sourceId),
    'the one source row is the proved source event', RENDER_MS);
  assertSameRow(target, first, sourceId);
  await openSheet(context, READY_ROW, { text: first }, 'sheet-ready');
  await client.tapCurrent(QUOTE);
  const closed = await sheet(client, assertSheetClosed, 'sheet closed by Quote');
  await receipt(context, 'quote-picked', { openSheets: closed.dialogs });

  // Line 94: exactly the inserted block, blank line marked, caret on the blank line.
  const quoted = await readComposer(client, {
    accepts: passes((value) => assertComposerQuote(value, run)),
    description: 'exact quote block inserted in the composer',
    timeoutMs: QUOTE_MS,
  });
  await record(context, 'composer-quote', () => assertComposerQuote(quoted, run), {
    exactValue: true,
    markedBlankLine: true,
    caretAtEnd: quoted.selectionStart === quoted.value?.length,
  });

  // Lines 99–101: the answer, appended natively and sent.
  await appendNativeLine(client, quotedComposer(run), answer);
  await receipt(context, 'answer-native-draft', { keys: ['append'], exactValue: true });
  await sendDraft(context, quoteEventBody(run), 'answer-send-enabled', 'answer');

  // The quote event is proved on the wire before any rendered record.
  const echo = await timeline(client, (value) => assertServerEcho(value, answer),
    'quote row reconciled to a server event', ECHO_MS);
  const quoteId = assertServerEcho(echo, answer).id;
  protect(context, { eventIds: [quoteId] });
  await serverMessages(context, account, room,
    (events) => assertQuoteBlockRoom(events, { ...expected, sourceId, quoteId }),
    'authoritative quote event');
  await receipt(context, 'quote-event', {
    eventDigest: digest(quoteId),
    exactBody: true,
    htmlBlockquote: true,
    noRelation: true,
  });

  // Lines 103–114: the reconciled quote row and its one real blockquote.
  const view = await timeline(client, (value) => {
    const row = assertAnswerVisible(value, answer, quoteId);
    const quote = assertOneBlockquote(row);
    assertQuotesFirst(quote, run);
    assertQuotesSecond(quote, run);
    assertAnswerOutside(row, quote, run);
  }, 'the quote row renders one blockquote with both paragraphs', RENDER_MS);
  const row = assertAnswerVisible(view, answer, quoteId);
  await record(context, 'answer-visible', () => assertAnswerVisible(view, answer, quoteId), {
    visible: row.visible,
    eventDigest: digest(quoteId),
  });
  const quote = assertOneBlockquote(row);
  await record(context, 'one-blockquote', () => assertOneBlockquote(row), {
    blockquotes: row.blockquotes,
  });
  await record(context, 'quotes-first', () => assertQuotesFirst(quote, run), {
    containsFirst: true,
  });
  await record(context, 'quotes-second', () => assertQuotesSecond(quote, run), {
    containsSecond: true,
  });
  await record(context, 'answer-outside', () => assertAnswerOutside(row, quote, run), {
    answerOutside: true,
  });
}

// Stage 2: Quote is offered for text and not for an image (117–217, Android branches).

export async function runQuoteCapability(context: MessageQuoteStageContext): Promise<void> {
  const { client, fixtures, ledger } = context;
  const { run } = ledger;
  const { account, room } = await arrangeStage(context);
  const body = quoteControl(run);

  // Lines 147–169: the pinned PNG as an m.image fixture; the only REST send.
  const image = await fixtures.sendImageMessage(account, room.id, {
    png: quoteImagePng(),
    filename: QUOTE_IMAGE_FILENAME,
    body: QUOTE_IMAGE_BODY,
    transactionId: quoteImageTransaction(run),
  });
  protect(context, { contentUri: image.contentUri, eventIds: [image.eventId] });
  context.safety.unsafeSecrets = false;
  const expected = {
    roomId: room.id,
    sender: account.userId,
    run,
    imageId: image.eventId,
    contentUri: image.contentUri,
  };
  await serverMessages(context, account, room,
    (events) => assertCapabilityRoom(events, expected), 'authoritative image fixture');
  await receipt(context, 'image-fixture-event', {
    eventDigest: digest(image.eventId),
    exactUpload: true,
    body: QUOTE_IMAGE_BODY,
  });

  await startNative(context);
  await client.login(account);
  await client.hideKeyboard();
  await openRoom(context, room, account);

  // Lines 176–178: the text control, typed and sent natively.
  await client.focusCurrent(COMPOSER);
  await client.fillFocused(COMPOSER, body, PARAGRAPH_SENTINEL);
  await composerAt(client, body, body.length, 'native text control');
  await receipt(context, 'control-native-draft', { keys: ['fill'], exactValue: true });
  await sendDraft(context, body, 'control-send-enabled', 'control');

  // Lines 180–182: the control row, then its reconciled server event.
  const controlView = await timeline(client, (value) => assertRowVisible(value, body),
    'visible text control row', RENDER_MS);
  const control = assertRowVisible(controlView, body);
  await record(context, 'control-visible', () => assertRowVisible(controlView, body), {
    visible: control.visible,
  });
  const controlId = await serverEcho(context, body, 'control-server-echo');
  await serverMessages(context, account, room,
    (events) => assertCapabilityRoom(events, { ...expected, controlId }),
    'authoritative image fixture and text control');
  await receipt(context, 'control-event', {
    eventDigest: digest(controlId),
    exactBody: true,
    afterImage: true,
  });

  // Lines 183–187: the text control's sheet offers Quote; Cancel closes it.
  const target = await timeline(client, (value) => assertSameRow(value, body, controlId),
    'the one control row is the proved control event', RENDER_MS);
  assertSameRow(target, body, controlId);
  await openSheet(context, READY_ROW, { text: body }, 'text-sheet-ready');
  const offered = await sheet(client, assertQuoteVisible, 'text sheet offers Quote');
  await record(context, 'text-quote-visible', () => assertQuoteVisible(offered), {
    quoteActions: offered.quote.count,
    quoteVisible: offered.quote.visible,
  });
  const swipes = await reachCancel(client);
  await client.tapCurrent(CANCEL, { exactText: 'Cancel' });
  const closed = await sheet(client, assertSheetClosed, 'sheet closed by native Cancel');
  await record(context, 'text-sheet-closed', () => assertSheetClosed(closed), {
    openSheets: closed.dialogs,
    cancelSwipes: swipes,
  });

  // Lines 199–205: the exact image row; its opened sheet has Copy and no Quote.
  const imageView = await timeline(client, (value) => assertImageRow(value, image.eventId),
    'the one image row is the fixture event', RENDER_MS);
  const imageRow = assertImageRow(imageView, image.eventId);
  await record(context, 'image-visible', () => assertImageRow(imageView, image.eventId), {
    visible: imageRow.visible,
    media: imageRow.media,
    mediaKinds: imageRow.mediaKinds,
    eventDigest: digest(image.eventId),
  });
  await openSheet(context, READY_ROW, { text: QUOTE_IMAGE_FILENAME }, 'image-sheet-ready');
  const imageSheet = await sheet(client, assertCopyVisible, 'image sheet offers Copy');
  await record(context, 'image-copy-visible', () => assertCopyVisible(imageSheet), {
    copyActions: imageSheet.copy.count,
    copyVisible: imageSheet.copy.visible,
  });
  await record(context, 'image-no-quote', () => assertNoQuote(imageSheet), {
    quoteActions: imageSheet.quote.count,
    copyVisible: imageSheet.copy.visible,
    sameOpenSheet: imageSheet.dialogs === 1,
  });
}

const STAGE_RUNNERS: Readonly<Record<
  MessageQuoteStageId,
  (context: MessageQuoteStageContext) => Promise<void>
>> = {
  'quote-block': runQuoteBlock,
  'quote-capability': runQuoteCapability,
};

interface StageReport {
  readonly id: MessageQuoteStageId;
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
  assertions: MessageQuoteAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 2;
  readonly expectedUniqueAssertions: 23;
  readonly expectedAssertionRecords: 23;
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
  return publicStageFailure(`Android message-quote ${stageId} failed`, failures,
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
  return new Error(`Message-quote cleanup failed: ${label} (${parts.join('; ')})`);
}

/** The run state a failed guarded cleanup marks before it rethrows. */
export interface GuardedCleanupState {
  readonly safety: MessageQuotePublicationSafety;
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
export function guardMessageQuoteCleanup(
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
export async function runMessageQuoteSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'message-quote');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(MESSAGE_QUOTE_STAGES.length, 2, 'Message-quote runs two stages');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 2,
          expectedUniqueAssertions: 23,
          expectedAssertionRecords: 23,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeMessageQuotePublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: MessageQuotePublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardMessageQuoteCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan message-quote diagnostics', () =>
          report.status === 'passed'
            ? markMessageQuoteDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanMessageQuoteArtifacts(output, secrets));
        guardedCleanup('Scrub message-quote diagnostics', async () => {
          try { await scrubMessageQuoteArtifacts(output, secrets); }
          catch (error) { safety.scrubFailed = true; throw error; }
        });
        try {
          const device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          guardedCleanup('Message-quote Android device', () => device.close());
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
          for (const entry of MESSAGE_QUOTE_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: MessageQuoteAssertion[] = [];
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
            console.info(`[message-quote] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: MessageQuoteStageContext = {
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
                run: `${resources.aliasLocalpart(`quote-${entry.id}`)}${MESSAGE_QUOTE_RUN_SUFFIX[entry.id]}`,
                eventIds: [],
              },
            };
            try {
              protect(context, {});
              await STAGE_RUNNERS[entry.id](context);
              assertMessageQuoteRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              try { if (context.native) await client.capture('failed'); }
              catch (captureError) { failures.push(captureError); }
            } finally {
              const stageFailures = failures.length;
              await runMessageQuoteStageCleanup([
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
              console.info(`[message-quote] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, MESSAGE_QUOTE_ASSERTION_RECORDS,
            'Every message-quote parity identity was emitted once');
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
  void test('Android message-quote journeys', { timeout: 1_200_000 },
    runMessageQuoteSuite);
}
