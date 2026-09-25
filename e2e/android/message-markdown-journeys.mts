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
  type AccountElement,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import {
  ANTI_CAPITALIZATION_SENTINEL,
  LEAD_BODY,
  MESSAGE_MARKDOWN_ASSERTION_RECORDS,
  MESSAGE_MARKDOWN_DRAFTS,
  MESSAGE_MARKDOWN_RUN_SUFFIX,
  MESSAGE_MARKDOWN_STAGES,
  assertBoldRun,
  assertCheckedGlyph,
  assertCodeEvent,
  assertCodeVisible,
  assertContinuationRow,
  assertDraftSent,
  assertFormattedBold,
  assertFormattedBreak,
  assertFormattedFormat,
  assertFormattedSource,
  assertFormattingEvents,
  assertLanguageCaption,
  assertLeadEvent,
  assertMessageMarkdownReceiptName,
  assertMessageMarkdownRecords,
  assertNativeComposerValue,
  assertNativeSheetReady,
  assertNoCheckboxInput,
  assertNoHoverToolbar,
  assertOneBreak,
  assertPlainBody,
  assertPlainNoFormat,
  assertPlainNoFormattedBody,
  assertPlainRow,
  assertRichVisible,
  assertRoomReady,
  assertSendEnabled,
  assertSendReady,
  assertServerEcho,
  assertSheetVisible,
  assertTaskEvent,
  assertTaskListVisible,
  assertUncheckedGlyph,
  authoritativeRoomMessages,
  messageMarkdownAssertion,
  messageMarkdownRoomName,
  needsSentinel,
  type ComposerObservation,
  type MessageMarkdownAssertion,
  type MessageMarkdownStage,
  type MessageMarkdownStageId,
  type NativeDraft,
  type TimelineObservation,
} from './message-markdown-contract.mts';
import {
  readAppliedProfile,
  readComposer,
  readTimeline,
} from './message-markdown-observer.mts';
import {
  markMessageMarkdownDiagnosticsSafe,
  messageMarkdownSecrets,
  redactSecretText,
  revokeMessageMarkdownPublicationOnAbort,
  runMessageMarkdownStageCleanup,
  scanMessageMarkdownArtifacts,
  scrubMessageMarkdownArtifacts,
  type MessageMarkdownPublicationSafety,
  type MessageMarkdownSecretIds,
} from './message-markdown-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const SHEET = '[role="dialog"][aria-label="Message actions"]';
const FORWARD = '[data-testid="sheet-forward"]';
const APPEND_FLOW = 'e2e/android/flows/message-markdown-append.yaml';

// Polling bounds: each is at least the predecessor's own bound.
const ROOM_OPEN_MS = 30_000;
const DRAFT_MS = 15_000;
const SEND_READY_MS = 20_000;
const RENDER_MS = 20_000;
const ECHO_MS = 20_000;
const SHEET_MS = 15_000;

const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

/** The minimum a parity record or receipt needs; the guard drives it with a fake client. */
export interface RecordContext {
  readonly entry: MessageMarkdownStage;
  readonly records: MessageMarkdownAssertion[];
  /** Suite-wide identities, so a duplicate can never be emitted twice. */
  readonly identities: Set<string>;
  receipts: number;
  readonly client: Pick<AccountWorkspaceClient, 'record'>;
}

/** Every identifier a stage creates, registered before any UI step. */
interface SecretLedger {
  readonly run: string;
  account?: MessageMarkdownSecretIds['account'];
  room?: { id?: string; name?: string };
  readonly eventIds: string[];
}

export interface MessageMarkdownStageContext extends RecordContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: AccountFixtures;
  readonly secrets: Record<string, string>;
  readonly safety: MessageMarkdownPublicationSafety;
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
  const identity = messageMarkdownAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Message-markdown parity records stay in source order');
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
  assertMessageMarkdownReceiptName(name);
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
  context: MessageMarkdownStageContext,
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
  Object.assign(context.secrets, messageMarkdownSecrets(context.entry.id, ledger));
}

/**
 * Arrange one fresh Account and private Room through real Synapse. The
 * messages under test are never seeded; they are typed natively below.
 */
async function arrangeStage(
  context: MessageMarkdownStageContext,
): Promise<{ readonly account: NodeWorkspaceAccount; readonly room: WorkspaceRoom }> {
  const { fixtures, entry, ledger } = context;
  const name = messageMarkdownRoomName[entry.id](ledger.run);
  protect(context, { room: { name } });
  const account = await fixtures.account(`md-${entry.id}`);
  protect(context, { account });
  const room = await fixtures.createRoom(account, { name, preset: 'private_chat' });
  protect(context, { room: { id: room.id } });
  assert.equal(room.name, name, 'The Room carries the predecessor name template');
  context.safety.unsafeSecrets = false;
  return { account, room };
}

/** Reset to the Pixel 5 profile the retained android-webview project uses. */
async function startNative(context: MessageMarkdownStageContext): Promise<void> {
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

/** Helper 4–16: tap the rail and the exact Room row, then prove its composer. */
async function openRoom(
  context: MessageMarkdownStageContext,
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

async function composerValue(
  client: AccountWorkspaceClient,
  candidates: readonly string[],
  description: string,
): Promise<ComposerObservation> {
  return readComposer(client, {
    accepts: (value) => candidates.some((candidate) => {
      try { assertNativeComposerValue(value, candidate); return true; }
      catch { return false; }
    }),
    description,
    timeoutMs: DRAFT_MS,
  });
}

/**
 * Type one continuation line at the caret after a native Enter. A line
 * that starts with a letter is typed behind the anti-capitalisation sentinel,
 * because Android capitalises the first letter of a new paragraph. The caret
 * then walks back over the typed line, Backspace removes the sentinel, and
 * Ctrl+End restores the caret to the draft end.
 */
async function appendNativeLine(
  client: AccountWorkspaceClient,
  afterBreak: string,
  line: string,
): Promise<void> {
  const sentinel = needsSentinel(line);
  await client.device.runFlow(join(client.workspaceRoot, APPEND_FLOW), {
    APP_ID: client.applicationId,
    SECRET_TEXT: sentinel ? `${ANTI_CAPITALIZATION_SENTINEL}${line}` : line,
  });
  if (!sentinel) return;
  await composerValue(client, [`${afterBreak}${ANTI_CAPITALIZATION_SENTINEL}${line}`],
    'sentinel-prefixed native line');
  for (let offset = 0; offset < line.length; offset++) await client.key('arrowLeft');
  await client.key('backspace');
  await client.keyCombination('documentEnd');
}

/**
 * Enter one predecessor `sendComposerLines` draft through native Android input:
 * the first line through the focused fill behind the digit sentinel, and every
 * further line after a native Enter, which inserts a line break (continuing a
 * list marker) in the composer on a mobile device.
 */
export async function enterNativeDraft(
  context: MessageMarkdownStageContext,
  draft: NativeDraft,
): Promise<void> {
  const { client } = context;
  await client.focusCurrent(COMPOSER);
  await client.fillFocused(COMPOSER, draft.first, ANTI_CAPITALIZATION_SENTINEL);
  await composerValue(client, [draft.first], `${draft.name} first native line`);
  const keys: string[] = ['focused-fill'];
  for (const step of draft.breaks) {
    await client.focused(COMPOSER);
    await client.key('enter');
    await composerValue(client, [step.afterBreak],
      `${draft.name} native Enter line break`);
    await appendNativeLine(client, step.afterBreak, step.typed);
    await composerValue(client, [`${step.afterBreak}${step.typed}`],
      `${draft.name} native continuation line`);
    keys.push('enter', needsSentinel(step.typed) ? 'sentinel-append' : 'append');
  }
  await receipt(context, `${draft.name}-native-draft`, {
    lines: draft.lines.length,
    breaks: draft.breaks.length,
    valueLength: draft.value.length,
    keys,
  });
}

/**
 * Helper 45–79: native draft, the enabled send control (75), then with the keyboard
 * dismissed that composer's enabled Send button (53) and a native Send tap. On a
 * mobile device Enter inserts a line break, so the button is the only send.
 */
export async function sendDraft(
  context: MessageMarkdownStageContext,
  draft: NativeDraft,
  suffix: string,
): Promise<void> {
  const { client } = context;
  assert(/(?:^|-)send-ready$/u.test(suffix), `${suffix} names a send readiness`);
  const enabledSuffix = suffix.replace(/-ready$/u, '-enabled');
  await enterNativeDraft(context, draft);
  const ready = await readComposer(client, {
    accepts: passes((value) => assertSendReady(value, draft)),
    description: `${draft.name} send control enabled for the exact draft`,
    timeoutMs: SEND_READY_MS,
  });
  await record(context, suffix, () => assertSendReady(ready, draft), {
    exactNativeValue: true,
    lines: draft.lines.length,
    sendEnabled: ready.sendDisabled === false,
  });
  await client.hideKeyboard();
  const enabled = await readComposer(client, {
    accepts: passes((value) => assertSendEnabled(value, draft)),
    description: `${draft.name} Send button enabled with the keyboard dismissed`,
    timeoutMs: SEND_READY_MS,
  });
  await record(context, enabledSuffix, () => assertSendEnabled(enabled, draft), {
    exactDraft: true,
    sendEnabled: enabled.sendDisabled === false,
  });
  await client.tapCurrent('[data-testid="composer-send"]');
  const cleared = await readComposer(client, {
    accepts: passes(assertDraftSent),
    description: `${draft.name} composer cleared by the native send`,
    timeoutMs: SEND_READY_MS,
  });
  assertDraftSent(cleared);
  await receipt(context, `${draft.name}-sent`, { cleared: true });
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

/** Helper 177–179: the one row carrying `needle` reconciles to a server event id. */
async function serverEcho(
  context: MessageMarkdownStageContext,
  needle: string,
  suffix: string,
): Promise<string> {
  const echo = await timeline(context.client,
    (value) => assertServerEcho(value, needle),
    `row carrying ${JSON.stringify(needle)} reconciled to a server event`, ECHO_MS);
  const row = assertServerEcho(echo, needle);
  protect(context, { eventIds: [row.id] });
  await record(context, suffix, () => assertServerEcho(echo, needle), {
    serverId: row.id.startsWith('$'),
    eventDigest: digest(row.id),
  });
  return row.id;
}

// Stage 1: formatting, line breaks and the plain/HTML wire distinction (52–125).

export async function runFormatting(context: MessageMarkdownStageContext): Promise<void> {
  const { client, fixtures } = context;
  const { account, room } = await arrangeStage(context);
  await startNative(context);
  await client.login(account);
  await client.hideKeyboard();
  await openRoom(context, room, account);

  await sendDraft(context, MESSAGE_MARKDOWN_DRAFTS.plain, 'plain-send-ready');
  const plainView = await timeline(client, assertPlainRow,
    'visible exact plain two-line row', RENDER_MS);
  const plain = assertPlainRow(plainView);
  await record(context, 'plain-visible', () => assertPlainRow(plainView), {
    visible: plain.visible,
    html: plain.html,
    whiteSpace: plain.whiteSpace,
    breaks: plain.breaks,
  });

  await sendDraft(context, MESSAGE_MARKDOWN_DRAFTS.rich, 'rich-send-ready');
  const richView = await timeline(client, assertRichVisible,
    'visible rendered-markdown row', RENDER_MS);
  const rich = assertRichVisible(richView);
  await record(context, 'rich-visible', () => assertRichVisible(richView), {
    visible: rich.visible,
  });
  await record(context, 'bold-run', () => assertBoldRun(rich), {
    strongCount: rich.strong.length,
  });
  await record(context, 'one-break', () => assertOneBreak(rich), {
    breaks: rich.breaks,
  });

  // The predecessor's loop over ['plain one', 'rich two'] (101–105).
  const plainId = await serverEcho(context, 'plain one', 'plain-server-echo');
  const richId = await serverEcho(context, 'rich two', 'rich-server-echo');

  // The exact authoritative reader (29–47); the wire is never inferred from rendering.
  const events = authoritativeRoomMessages(await fixtures.roomMessages(account, room.id));
  const wire = assertFormattingEvents(events,
    { eventId: plainId, roomId: room.id, sender: account.userId },
    { eventId: richId, roomId: room.id, sender: account.userId });
  await receipt(context, 'authoritative-events', {
    messageEvents: events.length,
    orderedAsRows: true,
  });
  await record(context, 'plain-body', () => assertPlainBody(wire.plain), {
    exactBody: true,
  });
  await record(context, 'plain-no-format', () => assertPlainNoFormat(wire.plain), {
    format: false,
  });
  await record(context, 'plain-no-formatted-body',
    () => assertPlainNoFormattedBody(wire.plain), { formattedBody: false });
  await record(context, 'formatted-format', () => assertFormattedFormat(wire.formatted), {
    htmlFormat: true,
  });
  await record(context, 'formatted-break', () => assertFormattedBreak(wire.formatted), {
    exactBreak: true,
  });
  await record(context, 'formatted-bold', () => assertFormattedBold(wire.formatted), {
    exactBold: true,
  });
  await record(context, 'formatted-source', () => assertFormattedSource(wire.formatted), {
    exactSource: true,
  });
}

// Stage 2: a task list renders as glyphs rather than dropping them (127–168).

export async function runTaskList(context: MessageMarkdownStageContext): Promise<void> {
  const { client, fixtures } = context;
  const { account, room } = await arrangeStage(context);
  await startNative(context);
  await client.login(account);
  await client.hideKeyboard();
  await openRoom(context, room, account);

  await sendDraft(context, MESSAGE_MARKDOWN_DRAFTS.task, 'send-ready');
  const listView = await timeline(client, assertTaskListVisible,
    'visible rendered task list', RENDER_MS);
  const list = assertTaskListVisible(listView);
  await record(context, 'list-visible', () => assertTaskListVisible(listView), {
    visible: list.visible,
  });
  await record(context, 'checked-glyph', () => assertCheckedGlyph(list), {
    items: list.items.length,
  });
  await record(context, 'unchecked-glyph', () => assertUncheckedGlyph(list), {
    items: list.items.length,
  });
  await record(context, 'no-checkbox-input', () => assertNoCheckboxInput(list), {
    inputs: list.inputs,
    checkboxes: list.checkboxes,
  });

  // A real ready server event, and the same glyphs on the reconciled row.
  const ready = await timeline(client, (value) => assertServerEcho(value, 'shipped'),
    'task row reconciled to a server event', ECHO_MS);
  const row = assertServerEcho(ready, 'shipped');
  protect(context, { eventIds: [row.id] });
  assertTaskEvent(await fixtures.roomEvent(account, room.id, row.id), {
    eventId: row.id, roomId: room.id, sender: account.userId,
  });
  const readyList = assertTaskListVisible(ready);
  assertUncheckedGlyph(readyList);
  assertNoCheckboxInput(readyList);
  await receipt(context, 'task-server-event', {
    eventDigest: digest(row.id),
    continuedSource: true,
    readyRowGlyphs: true,
  });
}

// Stage 3: Android branch of the language-caption definition (170–224).

export async function runCodeCaption(context: MessageMarkdownStageContext): Promise<void> {
  const { client, fixtures } = context;
  const { account, room } = await arrangeStage(context);
  await startNative(context);
  await client.login(account);
  await client.hideKeyboard();
  await openRoom(context, room, account);

  await sendDraft(context, MESSAGE_MARKDOWN_DRAFTS.lead, 'lead-send-ready');
  // The predecessor pauses 500 ms; the lead is proved a ready server event instead.
  const leadView = await timeline(client, (value) => assertServerEcho(value, LEAD_BODY),
    'lead row reconciled to a server event', ECHO_MS);
  const leadId = assertServerEcho(leadView, LEAD_BODY).id;
  protect(context, { eventIds: [leadId] });
  assertLeadEvent(await fixtures.roomEvent(account, room.id, leadId), {
    eventId: leadId, roomId: room.id, sender: account.userId,
  });
  await receipt(context, 'lead-server-event', { eventDigest: digest(leadId) });

  await sendDraft(context, MESSAGE_MARKDOWN_DRAFTS.code, 'code-send-ready');
  const codeView = await timeline(client, assertCodeVisible,
    'one visible rendered code block', RENDER_MS);
  const code = assertCodeVisible(codeView);
  await record(context, 'code-visible', () => assertCodeVisible(codeView), {
    visible: code.pre.visible,
  });
  const codeId = await serverEcho(context, 'x = 1', 'server-echo');
  assertCodeEvent(await fixtures.roomEvent(account, room.id, codeId), {
    eventId: codeId, roomId: room.id, sender: account.userId,
  });
  await receipt(context, 'code-server-event', { eventDigest: digest(codeId) });

  const readyView = await timeline(client,
    (value) => assertContinuationRow(value, codeId, leadId),
    'ready code continuation row', RENDER_MS);
  const row = assertContinuationRow(readyView, codeId, leadId);
  await record(context, 'continuation-row',
    () => assertContinuationRow(readyView, codeId, leadId), {
      continuation: row.continuation,
      readyServerEvent: true,
    });
  await record(context, 'no-hover-toolbar', () => assertNoHoverToolbar(row), {
    rowToolbars: row.toolbarCount,
    timelineToolbars: readyView.toolbarCount,
    hoverNone: readyView.hoverNone,
  });
  assert.equal(readyView.toolbarCount, 0, 'No row in the timeline paints a hover toolbar');
  const [pre] = row.texts.flatMap((text) => text.pres);
  assert(pre, 'The continuation row holds one code block');
  await record(context, 'language-caption', () => assertLanguageCaption(pre), {
    language: pre.language,
    caption: pre.caption,
    captionOpacity: pre.captionOpacity,
    captionDisplay: pre.captionDisplay,
  });

  // Helper 214–222: a native long press opens the Android message-action sheet.
  // As the predecessor does, the row is found by its code text, never by its
  // event id: native actions log their selector to the published job log. The
  // press requires exactly one match, and the continuation row above proved
  // that the code event's row holds this text.
  await client.hideKeyboard();
  await client.longPressCurrent('.scroll .msg[data-mid^="$"]', { text: 'x = 1' });
  const dialogs = await client.waitElements(SHEET,
    (values) => values.length === 1 && values[0]!.visible,
    'Android message-action sheet', {}, SHEET_MS);
  const actions = await client.elements(FORWARD);
  await record(context, 'sheet-ready', () => assertNativeSheetReady(dialogs, actions), {
    oneNativeSheet: dialogs.length === 1,
    oneForwardAction: actions.length === 1,
  });
  const sheet: readonly AccountElement[] = await client.waitElements(SHEET,
    (values) => values.length === 1 && values[0]!.visible,
    'Message actions sheet still visible', {}, SHEET_MS);
  await record(context, 'sheet-visible', () => assertSheetVisible(sheet), {
    visible: sheet[0]?.visible ?? false,
  });
}

const STAGE_RUNNERS: Readonly<Record<
  MessageMarkdownStageId,
  (context: MessageMarkdownStageContext) => Promise<void>
>> = {
  formatting: runFormatting,
  'task-list': runTaskList,
  'code-caption': runCodeCaption,
};

interface StageReport {
  readonly id: MessageMarkdownStageId;
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
  assertions: MessageMarkdownAssertion[];
  receipts: number;
  failureCount: number;
  error?: string;
}

interface SuiteReport {
  status: 'running' | 'passed' | 'failed';
  readonly expectedStages: 3;
  readonly expectedUniqueAssertions: 37;
  readonly expectedAssertionRecords: 37;
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
 * prints thrown errors, including assertion actual/expected values, to the
 * ungated job log, so rethrow only names and messages, with every registered
 * secret redacted. The complete text stays in the scrubbed journeys.json.
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
      lines.push(`${value.name}: ${value.message}`);
    } else {
      lines.push(typeof value);
    }
  };
  for (const failure of failures) visit(failure);
  return new Error(
    redactSecretText(`Android message-markdown ${stageId} failed\n${lines.join('\n')}`, secrets),
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
  return new Error(`Message-markdown cleanup failed: ${label} (${parts.join('; ')})`);
}

/** The run state a failed guarded cleanup marks before it rethrows. */
export interface GuardedCleanupState {
  readonly safety: MessageMarkdownPublicationSafety;
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
export function guardMessageMarkdownCleanup(
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

/** Single-attempt, serial three-stage run with post-cleanup publication safety. */
export async function runMessageMarkdownSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'message-markdown');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        assert.equal(MESSAGE_MARKDOWN_STAGES.length, 3, 'Message-markdown runs three stages');
        const stages: StageReport[] = [];
        const report: SuiteReport = {
          status: 'running',
          expectedStages: 3,
          expectedUniqueAssertions: 37,
          expectedAssertionRecords: 37,
          attempt: 1,
          retries: 0,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeMessageMarkdownPublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: MessageMarkdownPublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = guardMessageMarkdownCleanup(
          (label, action) => matrixResources.cleanup(label, action),
          { safety, report, save },
        );
        // Cleanups retire last-in-first-out: scrub runs before the final scan/mark.
        guardedCleanup('Scan message-markdown diagnostics', () =>
          report.status === 'passed'
            ? markMessageMarkdownDiagnosticsSafe(output, secrets, safety, signal, report)
            : scanMessageMarkdownArtifacts(output, secrets));
        guardedCleanup('Scrub message-markdown diagnostics', async () => {
          try { await scrubMessageMarkdownArtifacts(output, secrets); }
          catch (error) { safety.scrubFailed = true; throw error; }
        });
        try {
          const device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          guardedCleanup('Message-markdown Android device', () => device.close());
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
          for (const entry of MESSAGE_MARKDOWN_STAGES) {
            const directory = join(output, entry.id);
            await mkdir(directory, { recursive: true });
            const client = new AccountWorkspaceClient(device,
              session.workspaceRoot, directory, signal, APPLICATION_ID);
            const records: MessageMarkdownAssertion[] = [];
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
            console.info(`[message-markdown] ${entry.id} start`);
            safety.unsafeSecrets = true;
            const context: MessageMarkdownStageContext = {
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
                run: `${resources.aliasLocalpart(`md-${entry.id}`)}${MESSAGE_MARKDOWN_RUN_SUFFIX[entry.id]}`,
                eventIds: [],
              },
            };
            try {
              protect(context, {});
              await STAGE_RUNNERS[entry.id](context);
              assertMessageMarkdownRecords(entry.id, records);
              await client.capture('passed');
            } catch (error) {
              failures.push(error);
              try { if (context.native) await client.capture('failed'); }
              catch (captureError) { failures.push(captureError); }
            } finally {
              const stageFailures = failures.length;
              await runMessageMarkdownStageCleanup([
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
              console.info(`[message-markdown] ${entry.id} end ${stage.status}`);
            }
            // Stop at the first failed stage; there is exactly one attempt.
            if (failures.length)
              throw redactStageFailure(entry.id, failures, secrets);
          }
          assert.equal(identities.size, MESSAGE_MARKDOWN_ASSERTION_RECORDS,
            'Every message-markdown parity identity was emitted once');
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
  void test('Android message-markdown journeys', { timeout: 1_500_000 },
    runMessageMarkdownSuite);
}
