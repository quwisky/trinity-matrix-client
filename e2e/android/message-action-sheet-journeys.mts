import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountElementFilter,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceMessageActionSheetHistory,
} from './account-workspace-fixtures.mts';
import {
  MESSAGE_ACTION_SHEET_ASSERTION_RECORDS,
  MESSAGE_ACTION_SHEET_SOURCES,
  messageActionSheetAssertion,
  messageActionSheetCases,
  type MessageActionSheetAssertion,
  type MessageActionSheetCase,
} from './message-action-sheet-contract.mts';
import {
  assertSheetClearance,
  assertSheetViewport,
  assertSheetPositionRestored,
  assertSheetReaction,
  readSheetGeometry,
} from './message-action-sheet-observer.mts';
import {
  openMaestroDevice,
  redactMaestroArtifacts,
} from './maestro-session.mts';
import {
  messageActionSheetSecrets,
  scanMessageActionSheetArtifacts as scanArtifacts,
} from './message-action-sheet-artifacts.mts';
import { evaluateNative, waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const DIALOG = '[role="dialog"][aria-label="Message actions"]';
const SHEET = `${DIALOG} [data-testid="action-sheet-surface"]`;
const SHEET_SCROLL = `${SHEET} .overflow-y-auto`;
const CANCEL = `${SHEET_SCROLL} > button:last-child`;
const THREAD = '[data-testid="thread-view"]';
const TIMELINE = '.chat-body > trn-virtual-message-list [data-message-scroller]';
const JUMP = '[data-testid="jump-to-latest"]';
const visibleOne = (elements: readonly AccountElement[]): boolean =>
  elements.length === 1 && elements[0]!.visible;
const absent = (elements: readonly AccountElement[]): boolean => elements.length === 0;
const hidden = (elements: readonly AccountElement[]): boolean =>
  elements.every((element) => !element.visible);

interface StageContext {
  readonly client: AccountWorkspaceClient;
  readonly entry: MessageActionSheetCase;
  readonly fixtures: ReturnType<typeof createAccountFixtures>;
  readonly account: NodeWorkspaceAccount;
  readonly history: WorkspaceMessageActionSheetHistory;
  readonly unique: Set<MessageActionSheetAssertion>;
  readonly records: Set<MessageActionSheetAssertion>;
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}` : message;
}

async function record(context: StageContext, suffix: string, observation: unknown): Promise<void> {
  const identity = messageActionSheetAssertion(context.entry.id, suffix);
  assert(!context.records.has(identity), `${identity} is recorded once`);
  context.records.add(identity);
  context.unique.add(identity);
  await context.client.record(identity, { assertion: identity, observation });
}

async function elements(
  context: StageContext,
  suffix: string,
  selector: string,
  accepts: (values: readonly AccountElement[]) => boolean,
  filter: AccountElementFilter = {},
): Promise<readonly AccountElement[]> {
  const values = await context.client.waitElements(selector, accepts, suffix, filter, 30_000);
  await record(context, suffix, values.map((value) => ({ visible: value.visible, text: value.text, rect: value.rect })));
  return values;
}

async function finiteNumber(client: AccountWorkspaceClient, expression: string): Promise<number> {
  const value = await evaluateNative(client.webview, expression);
  assert(typeof value === 'number' && Number.isFinite(value), 'Observed measurement is finite');
  return value;
}

/**
 * Selectors reach the job log, so no native action or wait names an event id:
 * a target row is `.msg[data-mid^="$"]` scoped by its unique body, and a
 * read-only observation binds it to the exact event before each gesture. The
 * id-bearing `eventIdSelector` is used only inside read-only renderer
 * observations, which never log or record it.
 */
const ROW = '.msg[data-mid^="$"]';

interface RowTarget {
  readonly selector: string;
  readonly filter: AccountElementFilter;
  readonly within: AccountElementFilter;
  readonly eventIdSelector: string;
  readonly eventId: string;
}

function rowTarget(scope: string, body: string, eventId: string): RowTarget {
  const prefix = scope ? `${scope} ` : '';
  return {
    selector: `${prefix}${ROW}`,
    filter: { text: body },
    within: { within: { selector: '.msg', text: body } },
    eventIdSelector: `${prefix}.msg[data-mid=${JSON.stringify(eventId)}]`,
    eventId,
  };
}

async function bindTarget(client: AccountWorkspaceClient, target: RowTarget, description: string): Promise<void> {
  const identity = await client.eventIdentity(target.selector, target.filter, target.eventId);
  assert(identity.matches === 1 && identity.exactEvent, description);
}

async function sheetVisible(context: StageContext): Promise<void> {
  await elements(context, 'sheet-visible', SHEET, visibleOne);
  const dialogs = await context.client.elements(DIALOG);
  assert.equal(dialogs.length, 1, 'Exactly one named phone action dialog');
  const backdrops = await context.client.elements('.cdk-overlay-backdrop');
  assert(visibleOne(backdrops), 'Exactly one visible action-sheet backdrop');
}

async function dismissSheet(client: AccountWorkspaceClient): Promise<void> {
  await client.tapCurrentExposed('.cdk-overlay-backdrop');
  await client.waitElements(SHEET, absent, 'native backdrop closes action sheet');
}

async function clearance(context: StageContext, selector: string): Promise<void> {
  const geometry = await waitForNativeShellState(
    () => readSheetGeometry(context.client, selector),
    (value) => {
      try { assertSheetClearance(value); return true; } catch { return false; }
    },
    'exact connected target clear of its named sheet',
    context.client.signal,
    15_000,
  );
  assertSheetClearance(geometry);
  for (const suffix of ['sheet-present', 'row-inside-top', 'row-inside-bottom', 'eight-pixel-gap']) {
    await record(context, `clearance.${suffix}`, geometry);
  }
}

/** Move only with native swipes; a measured unobstructed button ends the loop. */
async function reachSheetButton(
  client: AccountWorkspaceClient,
  selector: string,
  filter: AccountElementFilter = {},
): Promise<AccountElement> {
  for (let swipe = 0; swipe <= 8; swipe++) {
    const candidates = await client.elements(selector, filter);
    assert.equal(candidates.length, 1, 'One exact action-sheet button');
    const button = candidates[0]!;
    const scroller = await client.visible(SHEET_SCROLL);
    if (button.visible && button.unobstructedCenter &&
        button.rect.y >= scroller.rect.y - 1 && button.rect.bottom <= scroller.rect.bottom + 1) return button;
    assert(swipe < 8, 'Sheet button is reachable within eight native swipes');
    await client.swipeCurrent(SHEET_SCROLL, {
      direction: button.rect.y < scroller.rect.y ? 'decrease-scroll-top' : 'increase-scroll-top',
    });
  }
  throw new Error('Native sheet scroll did not expose its button');
}

async function relativeTop(client: AccountWorkspaceClient, selector: string): Promise<number> {
  return finiteNumber(client, `(() => {
    const rows = [...document.querySelectorAll(${JSON.stringify(selector)})];
    if(rows.length !== 1 || !rows[0].isConnected) throw new Error('One connected restoration target is required');
    const row = rows[0], scroller = row.closest('[data-message-scroller]');
    if(!scroller?.isConnected) throw new Error('Restoration target needs its own live scroller');
    const box = row.getBoundingClientRect(), bounds = scroller.getBoundingClientRect();
    if(box.height <= 0 || bounds.height <= 0) throw new Error('Restoration boxes have positive height');
    return box.top - bounds.top;
  })()`);
}

async function restored(context: StageContext, selector: string, before: number): Promise<void> {
  const after = await waitForNativeShellState(
    () => relativeTop(context.client, selector),
    (value) => {
      try { assertSheetPositionRestored(before, value); return true; } catch { return false; }
    },
    'exact target position restored after native backdrop dismissal',
    context.client.signal,
    10_000,
  );
  assertSheetPositionRestored(before, after);
  await record(context, 'position-restored', { before, after, delta: Math.abs(after - before) });
}

async function reply(context: StageContext, target: RowTarget): Promise<void> {
  const { client } = context;
  const toolbarCount = (await client.elements(`${ROW} .msg__toolbar`, target.within)).length;
  assert(toolbarCount === 0, 'Phone has no hover toolbar');
  await record(context, 'toolbar-absent', { toolbarCount });
  const bodyWidth = await finiteNumber(client,
    `document.querySelector(${JSON.stringify(`${target.eventIdSelector} .msg__body`)})?.getBoundingClientRect().width`);
  assert(bodyWidth > 200, 'Phone message body stays wider than 200 CSS pixels');
  await record(context, 'body-wide', { bodyWidth });
  const author = await client.visible(`${ROW} .msg__author`, target.within);
  assert(author.text.length > 0, 'Exact source target has an author');
  await bindTarget(client, target, 'Reply long press targets the exact source event');
  await client.longPressCurrent(target.selector, target.filter);
  await sheetVisible(context);
  const revealedCount = (await client.elements(`${target.selector}.msg--revealed`, target.filter)).length;
  assert(revealedCount === 0, 'Long press uses the sheet, not revealed hover state');
  await record(context, 'revealed-row-absent', { revealedCount });
  const dialogCount = (await client.elements(DIALOG)).length;
  assert(dialogCount === 1, 'Phone sheet is one named dialog');
  await record(context, 'single-named-dialog', { dialogCount });
  const geometry = await readSheetGeometry(client, target.eventIdSelector);
  assert(geometry.sheetPresent, 'Sheet has a real bounding box');
  await record(context, 'sheet-box-present', geometry);
  await clearance(context, target.eventIdSelector);
  assertSheetViewport(geometry);
  await record(context, 'sheet-top-in-viewport', geometry);
  await record(context, 'sheet-bottom-in-viewport', geometry);
  const cancel = await reachSheetButton(client, CANCEL, { exactText: 'Cancel' });
  await record(context, 'cancel-visible', { visible: cancel.visible, unobstructed: cancel.unobstructedCenter });
  assert(cancel.rect.width > 0 && cancel.rect.height > 0, 'Cancel has a real box');
  await record(context, 'cancel-box-present', cancel.rect);
  const viewportHeight = await finiteNumber(client, 'window.innerHeight');
  const cancelBottom = cancel.rect.bottom;
  assert(cancelBottom <= viewportHeight + 1, 'Cancel is inside the viewport after native sheet scrolling');
  await record(context, 'cancel-bottom-in-viewport', { cancelBottom, viewportHeight });
  await reachSheetButton(client, '[data-testid="sheet-reply"]');
  await client.tapCurrent('[data-testid="sheet-reply"]');
  await elements(context, 'sheet-closed', SHEET, absent);
  const banner = await client.waitElements('.composer__banner',
    (values) => visibleOne(values) && values[0]!.text.replace(/\s+/gu, ' ').trim() === `Replying to ${author.text}`,
    'Replying to exact target author');
  await record(context, 'reply-banner', { text: banner[0]!.text, exactTargetAuthor: true });
}

async function quickReaction(context: StageContext, target: RowTarget): Promise<void> {
  const { client, fixtures, account, history } = context;
  await bindTarget(client, target, 'Quick-reaction long press targets the exact event');
  await client.longPressCurrent(target.selector, target.filter);
  await sheetVisible(context);
  await client.tapCurrent('[data-testid="sheet-react-👍"]');
  await elements(context, 'sheet-closed', 'trn-action-sheet', absent);
  const key = `${ROW} trn-message-reactions .reaction.reaction--mine[aria-pressed="true"] .reaction__key`;
  const keyFilter = { exactText: '👍', ...target.within };
  const reaction = await client.visible(key, keyFilter, 20_000);
  const keyIdentity = await client.eventIdentity(key, keyFilter, target.eventId);
  assert(keyIdentity.matches === 1 && keyIdentity.exactEvent, 'Thumbs-up renders inside the exact target event');
  const facts = await waitForNativeShellState(
    () => fixtures.messageActionSheetReactionEvents(account, history.roomId, history.targetEventId),
    (values) => values.length === 1 && (() => {
      try { assertSheetReaction(values[0]!); return true; } catch { return false; }
    })(),
    'one ready exact Matrix thumbs-up relation', client.signal, 20_000,
  );
  assert.equal(facts.length, 1);
  assertSheetReaction(facts[0]!);
  await record(context, 'reaction-ready', { visible: reaction.visible, relation: facts[0] });
}

async function backdrop(context: StageContext, target: RowTarget): Promise<void> {
  const { client, fixtures, account, history } = context;
  await bindTarget(client, target, 'Backdrop long press targets the exact event');
  await client.longPressCurrent(target.selector, target.filter);
  await sheetVisible(context);
  await dismissSheet(client);
  await elements(context, 'sheet-closed', 'trn-action-sheet', absent);
  const bannerCount = (await client.elements('.composer__banner')).length;
  const reactionEvents = await fixtures.messageActionSheetReactionEvents(account, history.roomId, history.targetEventId);
  const targetEvent = await fixtures.roomEvent(account, history.roomId, history.targetEventId);
  assert(bannerCount === 0, 'Backdrop does not start a reply or edit');
  assert(reactionEvents.length === 0, 'Backdrop does not send a reaction');
  assert.deepEqual(targetEvent['content'], { msgtype: 'm.text', body: history.targetBody }, 'Backdrop does not redact or change the target');
  await record(context, 'no-action', { bannerCount, reactionCount: reactionEvents.length, targetUnchanged: true });
}

async function virtualizedLatest(context: StageContext, target: RowTarget): Promise<void> {
  const { client, history } = context;
  assert.equal(history.messageCount, 81);
  assert(history.oldestFillerEventId && history.oldestFillerBody === 'sheet filler v 0');
  await elements(context, 'virtual-list-visible', '.chat-body > trn-virtual-message-list', visibleOne);
  const initial = await waitForNativeShellState(
    () => client.visible(TIMELINE),
    (value) => Math.abs(value.scrollHeight - value.scrollTop - value.clientHeight) <= 2,
    'virtual history starts settled at latest', client.signal, 15_000,
  );
  await client.waitElements(JUMP, hidden, 'latest pill hidden before native history');
  await client.record('history-initial-position', {
    scrollTop: initial.scrollTop, scrollHeight: initial.scrollHeight,
    clientHeight: initial.clientHeight,
  });
  const oldest = rowTarget(TIMELINE, history.oldestFillerBody, history.oldestFillerEventId);
  let found = false;
  for (let swipe = 0; swipe <= 30; swipe++) {
    const rows = await client.elements(oldest.selector, oldest.filter);
    if (rows.length === 1 && rows[0]!.text.includes(history.oldestFillerBody)) { found = true; break; }
    assert(swipe < 30, 'Oldest exact filler renders within thirty native history swipes');
    await client.swipeCurrent(TIMELINE, {
      direction: 'decrease-scroll-top', positionReference: 'bottom',
    });
  }
  assert(found, 'Exact oldest filler is rendered');
  await bindTarget(client, oldest, 'Rendered oldest filler is the exact oldest event');
  await record(context, 'oldest-filler-rendered', { exactEvent: true, exactBody: true, rendered: found });
  await elements(context, 'jump-visible', JUMP, visibleOne);
  await client.tapCurrent(JUMP);
  await elements(context, 'latest-target-visible', target.selector, visibleOne, target.filter);
  await elements(context, 'jump-hidden-before', JUMP, hidden);
  const rowCount = await waitForNativeShellState(
    async () => (await client.elements(`${TIMELINE} trn-message-row`)).length,
    (count) => count > 0 && count < 80,
    'virtualized newest window contains fewer than eighty rows', client.signal, 15_000,
  );
  assert(rowCount < 80 && rowCount > 0, 'Virtualized row cap is active');
  await record(context, 'virtual-row-cap', { rowCount });
  const before = await relativeTop(client, target.eventIdSelector);
  await bindTarget(client, target, 'Padding long press targets the exact latest event');
  await client.longPressCurrent(target.selector, target.filter, { allowBlankPadding: true });
  await sheetVisible(context);
  const geometry = await readSheetGeometry(client, target.eventIdSelector);
  assert.equal(geometry.rowCount, 1);
  assert.equal(geometry.rowConnected, true);
  await record(context, 'single-connected-target', { rowCount: geometry.rowCount, connected: geometry.rowConnected });
  await clearance(context, target.eventIdSelector);
  await elements(context, 'jump-hidden-during', JUMP, hidden);
  await dismissSheet(client);
  await elements(context, 'sheet-closed', SHEET, absent);
  await elements(context, 'target-visible-after', target.selector, visibleOne, target.filter);
  await restored(context, target.eventIdSelector, before);
  await elements(context, 'jump-hidden-after', JUMP, hidden);
}

async function threadTarget(context: StageContext, target: RowTarget): Promise<void> {
  const { client, history } = context;
  await bindTarget(client, target, 'Thread long press targets the exact event');
  await client.longPressCurrent(target.selector, target.filter);
  await client.visible(SHEET);
  await reachSheetButton(client, '[data-testid="sheet-thread"]');
  await client.tapCurrent('[data-testid="sheet-thread"]');
  await elements(context, 'thread-visible', THREAD, visibleOne);
  const threadRow = rowTarget(THREAD, history.targetBody, history.targetEventId);
  await elements(context, 'thread-row-visible', threadRow.selector, visibleOne, threadRow.filter);
  const before = await relativeTop(client, threadRow.eventIdSelector);
  await bindTarget(client, threadRow, 'Thread long press targets the exact event in the Thread');
  await client.longPressCurrent(threadRow.selector, threadRow.filter);
  await sheetVisible(context);
  await clearance(context, threadRow.eventIdSelector);
  await dismissSheet(client);
  await elements(context, 'sheet-closed', SHEET, absent);
  await restored(context, threadRow.eventIdSelector, before);
}

async function runStage(context: StageContext): Promise<void> {
  const { client, account, history, entry } = context;
  await client.login(account);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: history.roomName }, 30_000);
  await client.tapCurrent('.channel', { text: history.roomName });
  await elements(context, 'room-ready', '[data-testid="composer-input"]', visibleOne);
  const target = rowTarget('', history.targetBody, history.targetEventId);
  const ready = await client.visible(target.selector, target.filter, 30_000);
  assert(ready.text.includes(history.targetBody), 'Exact ready fixture target is visible');
  await bindTarget(client, target, 'Ready fixture target is the exact seeded event');
  await client.record('fixture-receipt', { messageCount: history.messageCount, targetReady: true, exactTargetBody: true, oldestFillerPresent: history.oldestFillerEventId !== null });
  switch (entry.id) {
    case 'reply': await reply(context, target); break;
    case 'quick-reaction': await quickReaction(context, target); break;
    case 'backdrop-dismiss': await backdrop(context, target); break;
    case 'virtualized-latest': await virtualizedLatest(context, target); break;
    case 'thread-target': await threadTarget(context, target); break;
  }
  assert.deepEqual([...context.records], [...entry.assertions], 'Each exact stage assertion is recorded in source order');
}

async function cleanupUi(client: AccountWorkspaceClient): Promise<void> {
  if ((await client.elements(SHEET)).some((element) => element.visible)) await dismissSheet(client);
  if ((await client.elements(THREAD)).some((element) => element.visible)) {
    await client.tapCurrent(`${THREAD} [aria-label="Close thread"]`);
    await client.waitElements(THREAD, absent, 'Thread closes during teardown');
  }
}

void test('Android message-action-sheet journeys', { timeout: 2_700_000 }, async (testContext) => {
  await withNodeTestResources({ testId: testContext.name, signal: testContext.signal }, async ({ matrixResources, signal }) => {
    const session = readSession();
    const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ?? join(session.workspaceRoot, 'dist/.playwright'), 'message-action-sheet');
    await mkdir(output, { recursive: true });
    const secrets: Record<string, string> = {};
    matrixResources.cleanup('Scan message-action-sheet diagnostics', () => scanArtifacts(output, secrets));
    matrixResources.cleanup('Redact message-action-sheet diagnostics', () => redactMaestroArtifacts(output, secrets, true));
    const unique = new Set<MessageActionSheetAssertion>();
    const stages: Array<{
      id: MessageActionSheetCase['id']; source: string; status: 'running' | 'passed' | 'failed';
      durationMs: number; artifact: string; attempt: 1; retries: 0;
      expectedAssertionRecords: number; assertionRecords: number; failureCount: number; error?: string;
    }> = [];
    const save = async (): Promise<void> => writeFile(join(output, 'journeys.json'), `${JSON.stringify({
      expectedStages: 5, expectedUniqueAssertions: 54, expectedAssertionRecords: 54,
      attempt: 1, retries: 0, applications: [APPLICATION_ID], sources: MESSAGE_ACTION_SHEET_SOURCES, stages,
    }, null, 2)}\n`);
    await save();
    const device = await openMaestroDevice({ workspaceRoot: session.workspaceRoot, signal, artifactDirectory: output, serial: process.env['TRINITY_ANDROID_SERIAL'] });
    matrixResources.cleanup('Message-action-sheet Android device', () => device.close());
    const fixtures = createAccountFixtures(matrixResources, signal);
    const apk = join(session.workspaceRoot, 'android/app/build/outputs/apk/debug/app-debug.apk');
    await installWithAndroidRuntimeProvenance({ device, applicationId: APPLICATION_ID, apk,
      rendererManifest: join(session.workspaceRoot, 'dist/web-bundle-manifest.json'),
      profile: PIXEL_5_ACCOUNT_PROFILE, output: join(output, 'runtime-provenance.json') });
    for (const entry of messageActionSheetCases) {
      const directory = join(output, entry.id);
      await mkdir(directory, { recursive: true });
      const client = new AccountWorkspaceClient(device, session.workspaceRoot, directory, signal, APPLICATION_ID);
      const records = new Set<MessageActionSheetAssertion>();
      const stage: (typeof stages)[number] = { id: entry.id, source: entry.source, status: 'running', durationMs: 0,
        artifact: `${entry.id}/**`, attempt: 1, retries: 0, expectedAssertionRecords: entry.assertions.length, assertionRecords: 0, failureCount: 0 };
      stages.push(stage);
      await save();
      const started = performance.now();
      const failures: unknown[] = [];
      let active = false;
      console.info(`[message-action-sheet] ${entry.id} start`);
      try {
        await client.reset(PIXEL_5_ACCOUNT_PROFILE);
        active = true;
        const account = await fixtures.account(`sheet-${entry.id}`);
        const roomName = matrixResources.roomName(`sheet-${entry.tag}`);
        Object.assign(secrets, messageActionSheetSecrets(entry.id, account, roomName));
        const history = await fixtures.createMessageActionSheetHistory(account, roomName, entry.tag, matrixResources.roomName(`sheet-event-${entry.tag}`));
        Object.assign(secrets, messageActionSheetSecrets(entry.id, account, roomName, history));
        assert.equal(history.messageCount, entry.messageCount);
        await runStage({ client, entry, fixtures, account, history, unique, records });
        await client.capture('passed');
      } catch (error) {
        failures.push(error);
        try { if (active) await client.capture('failed'); } catch (captureError) { failures.push(captureError); }
      } finally {
        try { if (active) await cleanupUi(client); } catch (error) { failures.push(error); }
        try { await client.close(); } catch (error) { failures.push(error); }
        try { await device.clearApplicationData(APPLICATION_ID); } catch (error) { failures.push(error); }
        stage.assertionRecords = records.size;
        stage.durationMs = performance.now() - started;
        stage.failureCount = failures.length;
        stage.status = failures.length ? 'failed' : 'passed';
        if (failures.length) stage.error = failures.map(describeFailure).join('\n');
        await save();
        console.info(`[message-action-sheet] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`);
      }
      if (failures.length) throw new AggregateError(failures, `Message-action-sheet ${entry.id} failed`);
    }
    assert.equal(unique.size, MESSAGE_ACTION_SHEET_ASSERTION_RECORDS);
  });
});
