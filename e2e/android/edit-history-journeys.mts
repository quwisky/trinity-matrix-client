import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import { MatrixTestResources } from '../support/test-resources.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountElementFilter,
} from './account-workspace-client.mts';
import type { NodeWorkspaceAccount } from './account-workspace-fixtures.mts';
import {
  EDIT_HISTORY_ASSERTION_RECORDS,
  assertEditHistoryRecords,
  editHistoryAssertion,
  editHistoryCases,
  type EditHistoryCase,
} from './edit-history-contract.mts';
import {
  editHistorySecrets,
  scanEditHistoryArtifacts,
  scrubEditHistoryArtifacts,
} from './edit-history-artifacts.mts';
import {
  type LifecycleSeed,
  type PixelSeed,
  createEditHistoryFixtures,
} from './edit-history-fixture.mts';
import {
  assertFormattedDiff,
  assertHistoryOrder,
  assertNativeTarget,
  assertPixelBaselineGeometry,
  assertPixelGeometry,
  assertPlainDiff,
  assertScaledReading,
  readEditHistory,
  readFontProfile,
  readPixelGeometry,
  type EditHistorySnapshot,
  type PixelGeometry,
} from './edit-history-observer.mts';
import type { FontScaleLease } from './maestro-session.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import { evaluateNative, waitForNativeShellState } from './native-shell-client.mts';

const DIALOG = '[data-testid="edit-history"]';
const CLOSE = '[data-testid="edit-history-close"]';
const TOGGLE = '[data-testid="edit-history-toggle"]';
const CONFIRM = '[data-testid="alert-confirm"]';
const REMOVE = '[data-testid="edit-history"] .revision:last-child [data-testid="revision-remove"]';
const TIMELINE = '.chat-body > trn-virtual-message-list [data-message-scroller]';
const APPLICATION_ID = 'eu.qwky.trinity';

export interface StageContext {
  readonly client: AccountWorkspaceClient;
  readonly entry: EditHistoryCase;
  readonly fixtures: ReturnType<typeof createEditHistoryFixtures>;
  readonly account: NodeWorkspaceAccount;
  readonly records: string[];
}

export interface RevisionStageContext extends StageContext {
  readonly seed: LifecycleSeed;
}

export interface PixelStageContext extends StageContext {
  readonly seed: PixelSeed;
}

/** An assertion must pass before a parity identity can be emitted. */
export async function record(
  context: StageContext,
  suffix: string,
  assertion: () => void,
  observation: unknown,
): Promise<void> {
  const identity = editHistoryAssertion(context.entry.id, suffix);
  assert.equal(identity, context.entry.assertions[context.records.length],
    'Edit-history parity records stay in source order');
  assertion();
  await context.client.record(identity, { assertion: identity, observation });
  context.records.push(identity);
}

const visibleOne = (elements: readonly AccountElement[]): boolean =>
  elements.length === 1 && elements[0]!.visible;
const hidden = (elements: readonly AccountElement[]): boolean =>
  elements.every((element) => !element.visible);
/**
 * Selectors reach the job log, so none names an event id. A seeded row is an
 * identifier-free `.msg[data-mid^="$"]` scoped by its current wording, and a
 * read-only observation binds each target to the exact seeded event before it
 * is used.
 */
const ROW = '.msg[data-mid^="$"]';
const ROW_TEXT = `${ROW} .msg__text`;
const MARKER = `${ROW} [data-testid="msg-edited"]`;
const DELETED_BODY = '(message deleted)';

/** One identifier-free target and the event a read-only observation must bind it to. */
export interface EventTarget {
  readonly selector: string;
  readonly filter: AccountElementFilter;
  readonly eventId: string;
}

/** The edited marker of the row whose current wording contains `text`. */
const markerIn = (text: string, eventId: string): EventTarget => ({
  selector: MARKER,
  filter: { within: { selector: '.msg', text: text.trim() } },
  eventId,
});

/**
 * Read-only: the timeline row whose `data-mid` is `eventId`. The identifier is
 * only an in-page comparison value and never leaves the renderer.
 */
async function readEventRow(
  client: AccountWorkspaceClient,
  eventId: string,
): Promise<{ readonly rows: number; readonly visible: boolean; readonly text: string; readonly markers: number }> {
  const value = await evaluateNative(client.webview, `(() => {
    const id=${JSON.stringify(eventId)};
    const rows=[...document.querySelectorAll('.msg[data-mid^="$"]')].filter(row=>row.getAttribute('data-mid')===id);
    const row=rows[0],box=row?.getBoundingClientRect();
    return {rows:rows.length,visible:Boolean(row&&box.width>0&&box.height>0&&getComputedStyle(row).visibility==='visible'),text:row?.textContent?.trim()??'',markers:row?row.querySelectorAll('[data-testid="msg-edited"]').length:0};
  })()`);
  assert(value && typeof value === 'object', 'Event row observation is an object');
  return value as { readonly rows: number; readonly visible: boolean; readonly text: string; readonly markers: number };
}

async function bindTarget(
  client: Pick<AccountWorkspaceClient, 'eventIdentity'>,
  target: EventTarget,
  description: string,
): Promise<void> {
  const identity = await client.eventIdentity(target.selector, target.filter, target.eventId);
  assert(identity.matches === 1 && identity.exactEvent, description);
}

async function historyRows(
  client: AccountWorkspaceClient,
  count: number,
): Promise<EditHistorySnapshot> {
  return waitForNativeShellState(
    () => readEditHistory(client),
    (value) => value.visible && value.rows.length === count,
    `${count} visible edit-history rows`,
    client.signal,
    20_000,
  );
}

async function closeHistory(client: AccountWorkspaceClient): Promise<void> {
  assertNativeTarget(await client.elements(CLOSE));
  await client.tapCurrent(CLOSE);
  await client.waitElements(DIALOG, hidden, 'edit-history closed after native Close');
}

async function reachRemove(client: AccountWorkspaceClient): Promise<void> {
  for (let swipe = 0; swipe <= 8; swipe++) {
    const elements = await client.elements(REMOVE);
    assert.equal(elements.length, 1, 'One trailing revision Remove');
    if (elements[0]!.visible && elements[0]!.unobstructedCenter) {
      assertNativeTarget(elements);
      return;
    }
    assert(swipe < 8, 'Trailing Remove is reachable within eight native swipes');
    const moved = await client.swipeCurrent('.revisions', {
      direction: 'increase-scroll-top',
    });
    assert(moved.afterScrollTop > moved.beforeScrollTop,
      'Native swipe advances revision scroll');
  }
}

async function timelineText(
  client: AccountWorkspaceClient,
  eventId: string,
  expected: string,
): Promise<AccountElement> {
  const target = { selector: ROW_TEXT, filter: { exactText: expected.trim() }, eventId };
  const [value] = await client.waitElements(
    target.selector,
    (elements) => visibleOne(elements) &&
      matchesTimelineText(elements[0]!.text, expected),
    'exact edited timeline wording',
    target.filter,
    30_000,
  );
  assert(value);
  await bindTarget(client, target, 'Edited wording belongs to the exact seeded event');
  return value;
}

/** Account observations trim DOM text; fixture bodies may end in spaces. */
export function matchesTimelineText(observed: string, expected: string): boolean {
  return observed === expected.trim();
}

/** Keep the clipped 44px marker reachable through measured native input. */
export async function openHistoryMarker(
  client: Pick<AccountWorkspaceClient,
    'waitElements' | 'visible' | 'swipeCurrent' | 'tapCurrentExposed' | 'eventIdentity'>,
  marker: EventTarget,
): Promise<void> {
  for (let attempt = 0; attempt <= 8; attempt++) {
    const [target] = await client.waitElements(marker.selector, visibleOne,
      'one visible edited marker before native open', marker.filter);
    assert(target);
    const timeline = await client.visible(TIMELINE);
    const centerY = target.rect.y + target.rect.height / 2;
    if (centerY >= timeline.rect.y && centerY <= timeline.rect.bottom) break;
    assert(attempt < 8, 'Edited marker reaches the timeline within eight native swipes');
    const direction = centerY < timeline.rect.y
      ? 'decrease-scroll-top' : 'increase-scroll-top';
    const proof = await client.swipeCurrent(TIMELINE, { direction });
    assert(direction === 'decrease-scroll-top'
      ? proof.afterScrollTop < proof.beforeScrollTop
      : proof.afterScrollTop > proof.beforeScrollTop,
    'Native marker swipe advances timeline scroll');
  }
  await bindTarget(client, marker, 'Edited marker belongs to the exact seeded event');
  await client.tapCurrentExposed(marker.selector, marker.filter);
}

/** Fail if a native swipe cannot expose the final action in eight attempts. */
export async function reachPixelRemove(
  client: Pick<AccountWorkspaceClient, 'swipeCurrent'>,
  initial: PixelGeometry,
  observe: () => Promise<PixelGeometry>,
): Promise<PixelGeometry> {
  let geometry = initial;
  const exposed = (value: PixelGeometry): boolean =>
    value.removeUnobstructed && value.removeLeft >= 0 &&
    value.removeRight <= value.width && value.removeTop >= 0 &&
    value.removeBottom <= value.height;
  for (let attempt = 0; !exposed(geometry) && attempt < 8; attempt++) {
    const proof = await client.swipeCurrent('.revisions', {
      direction: 'increase-scroll-top',
    });
    assert(proof.afterScrollTop > proof.beforeScrollTop,
      'Native Pixel swipe advances revision scroll');
    geometry = await observe();
  }
  assert(exposed(geometry), 'Trailing Remove is reached within eight native swipes');
  return geometry;
}

/** Exercise the two-edit lifecycle entirely through installed-host input. */
export async function runRevisionLifecycle(
  context: RevisionStageContext,
): Promise<void> {
  const { client, fixtures, account, seed } = context;
  const plainId = seed.plain.originalId;
  const versions = seed.plain.versions;
  const marker = (text: string): EventTarget => markerIn(text, plainId);
  assert.equal(context.entry.id, 'revision-lifecycle');
  const beforeRemoval = await fixtures.serverState(account, seed.roomId,
    seed.plain.originalId, seed.plain.editIds, seed.plain.editIds);
  assert(beforeRemoval.survivorMatches && beforeRemoval.liveCount === 2,
    'Both seeded edits are authoritative before removal');
  const formattedProof = await fixtures.serverState(account, seed.roomId,
    seed.formatted.originalId, [seed.formatted.editId], [seed.formatted.editId]);
  assert(formattedProof.survivorMatches && formattedProof.liveCount === 1,
    'Formatted edit wire content is authoritative');
  await fixtures.liveEditEvent(account, seed.roomId,
    seed.doomed.originalId, seed.doomed.editId);
  await fixtures.redactedOriginal(account, seed.roomId, seed.doomed.originalId);
  await client.record('seeded-server-chains', {
    plainLive: beforeRemoval.liveCount,
    formattedLive: formattedProof.liveCount,
    redactedOriginal: true,
    redactedOriginalEditLive: true,
  });

  await client.reset(PIXEL_5_ACCOUNT_PROFILE);
  await client.login(account);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: seed.roomName }, 30_000);
  await client.tapCurrent('.channel', { text: seed.roomName });
  const latest = await timelineText(client, plainId, versions[2]!);
  await record(context, 'room-ready', () => assert(latest.visible), { ready: true });
  await record(context, 'latest-text', () => assert.equal(latest.text, versions[2]),
    { latestExact: true });

  const [firstMarker] = await client.waitElements(MARKER, visibleOne,
    'accessible edited marker on original event', marker(versions[2]!).filter, 20_000);
  await record(context, 'marker-visible', () => {
    assert(firstMarker?.visible && /edited/iu.test(firstMarker.text));
  }, { markerVisible: true });
  const markerTarget = await client.elements(MARKER, marker(versions[2]!).filter);
  const timeline = await client.visible(TIMELINE);
  await client.record('marker-target-before-open', {
    count: markerTarget.length,
    rect: markerTarget[0]?.rect,
    visible: markerTarget[0]?.visible,
    unobstructedCenter: markerTarget[0]?.unobstructedCenter,
    timelineRect: timeline.rect,
    timelineScrollTop: timeline.scrollTop,
    timelineScrollHeight: timeline.scrollHeight,
    timelineClientHeight: timeline.clientHeight,
  });
  await openHistoryMarker(client, marker(versions[2]!));
  let history = await historyRows(client, 3);
  await record(context, 'dialog-visible', () => assert(history.visible),
    { dialogVisible: true });
  await record(context, 'three-revisions', () => assert.equal(history.rows.length, 3),
    { rowCount: history.rows.length });
  await record(context, 'oldest-first-labels', () =>
    assertHistoryOrder(history.rows.map((entry) => entry.label)),
    { ordered: true });

  const insertions = await client.elements(`${DIALOG} .revision:last-child ins.diff-ins`);
  await record(context, 'insertion-visible', () =>
    assert(insertions.some((element) => element.visible)),
    { visibleInsertion: true });
  await record(context, 'inserted-final', () => {
    assertPlainDiff(history);
    assert(history.rows[2]!.inserted.join(' ').includes('final'));
  }, { insertedFinal: true });
  await record(context, 'deleted-second', () =>
    assert(history.rows[2]!.deleted.join(' ').includes('second')),
    { deletedSecond: true });
  await record(context, 'original-no-diff', () => {
    assert.deepEqual(history.rows[0]!.inserted, []);
    assert.deepEqual(history.rows[0]!.deleted, []);
  }, { originalHasNoDiff: true });

  await record(context, 'toggle-default-on', () =>
    assert.equal(history.togglePressed, 'true'), { pressed: true });
  assertNativeTarget(await client.elements(TOGGLE));
  await client.tapCurrent(TOGGLE);
  history = await waitForNativeShellState(
    () => readEditHistory(client),
    (value) => value.visible && value.rows.length === 3 && value.togglePressed === 'false',
    'edit-history highlights off', client.signal, 15_000);
  await record(context, 'toggle-off', () =>
    assert.equal(history.togglePressed, 'false'), { pressed: false });
  await record(context, 'no-insertions-off', () =>
    assert(history.rows.every((entry) => entry.inserted.length === 0)),
    { insertions: 0 });
  await record(context, 'exact-versions-off', () =>
    assert.deepEqual(history.rows.map((entry) => entry.text), versions),
    { exactVersions: true });
  assertNativeTarget(await client.elements(TOGGLE));
  await client.tapCurrent(TOGGLE);
  history = await waitForNativeShellState(
    () => readEditHistory(client),
    (value) => value.visible && value.rows.length === 3 &&
      value.togglePressed === 'true' && value.rows[2]!.inserted.length > 0,
    'edit-history highlights restored', client.signal, 15_000);
  await record(context, 'insertions-restored', () =>
    assert(history.rows.some((entry) => entry.inserted.length > 0)),
    { restored: true });
  await record(context, 'no-error', () => assert.equal(history.errorCount, 0),
    { errorCount: 0 });
  await record(context, 'not-truncated', () =>
    assert.equal(history.truncatedCount, 0), { truncatedCount: 0 });
  await closeHistory(client);
  const firstClosed = await client.elements(DIALOG);
  await record(context, 'closed-first', () =>
    assert(hidden(firstClosed), 'Dialog is hidden'), { closed: true });

  const formattedMarker = markerIn('deploy on Monday', seed.formatted.originalId);
  await openHistoryMarker(client, formattedMarker);
  history = await historyRows(client, 2);
  await record(context, 'formatted-dialog', () => assert(history.visible),
    { dialogVisible: true });
  let formatted = history.rows[1]!;
  await record(context, 'bold-insert-mon', () => {
    assertFormattedDiff(formatted);
    assert.deepEqual(formatted.strongInserted, ['Mon']);
  }, { boldInsertedMon: true });
  await record(context, 'bold-delete-fri', () =>
    assert.deepEqual(formatted.strongDeleted, ['Fri']),
    { boldDeletedFri: true });
  await record(context, 'bold-retain-day', () =>
    assert(formatted.strongText.some((text) => text.includes('day'))),
    { boldRetainedDay: true });
  assertNativeTarget(await client.elements(TOGGLE));
  await client.tapCurrent(TOGGLE);
  history = await waitForNativeShellState(
    () => readEditHistory(client),
    (value) => value.visible && value.rows.length === 2 && value.togglePressed === 'false',
    'formatted history highlights off', client.signal, 15_000);
  formatted = history.rows[1]!;
  await record(context, 'bold-monday-off', () =>
    assert.deepEqual(formatted.strongText, ['Monday']),
    { boldMonday: true });
  await record(context, 'formatted-no-diff-off', () => {
    assertFormattedDiff(formatted, 'off');
    assert.equal(formatted.inserted.length + formatted.deleted.length, 0);
  }, { marks: 0 });
  await record(context, 'formatted-no-old-word', () =>
    assert(!formatted.text.includes('Fri ')), { staleFriday: false });
  await closeHistory(client);
  const formattedClosed = await client.elements(DIALOG);
  await record(context, 'formatted-closed', () =>
    assert(hidden(formattedClosed), 'Formatted dialog is hidden'), { closed: true });

  await openHistoryMarker(client, marker(versions[2]!));
  history = await historyRows(client, 3);
  await record(context, 'plain-reopened', () => assert(history.visible),
    { reopened: true });
  await record(context, 'plain-reopened-three', () =>
    assert.equal(history.rows.length, 3), { rowCount: 3 });
  await record(context, 'two-remove-actions', () =>
    assert.equal(history.rows.reduce((count, entry) => count + entry.removeCount, 0), 2),
    { removeActions: 2 });
  await record(context, 'original-not-removable', () =>
    assert.equal(history.rows[0]!.removeCount, 0),
    { originalRemoveActions: 0 });

  await reachRemove(client);
  assertNativeTarget(await client.elements(REMOVE));
  await client.tapCurrent(REMOVE);
  await client.waitElements(CONFIRM, visibleOne,
    'one visible nested destructive confirmation');
  assertNativeTarget(await client.elements(CONFIRM));
  await client.tapCurrent(CONFIRM);
  history = await historyRows(client, 2);
  const oneSurvivor = await fixtures.serverState(account, seed.roomId,
    seed.plain.originalId, seed.plain.editIds, [seed.plain.editIds[0]!]);
  await record(context, 'two-after-current-remove', () => {
    assert.equal(history.rows.length, 2);
    assert(oneSurvivor.removedRedacted && oneSurvivor.survivorMatches &&
      oneSurvivor.liveCount === 1);
  }, { rowCount: 2, serverSurvivors: 1 });
  await record(context, 'final-absent-after-remove', () =>
    assert(!history.rows.some((entry) => entry.text.includes(versions[2]!))),
    { finalAbsent: true });
  await record(context, 'no-error-after-remove', () =>
    assert.equal(history.errorCount, 0), { errorCount: 0 });
  await closeHistory(client);
  const awaitedDialog = await client.elements(DIALOG);
  await record(context, 'closed-after-current-remove', () =>
    assert(hidden(awaitedDialog)), { closed: true });

  const second = await timelineText(client, plainId, versions[1]!);
  await record(context, 'timeline-second-draft', () =>
    assert.equal(second.text, versions[1]), { secondDraftExact: true });
  const repairedMarker = await client.waitElements(MARKER, visibleOne,
    'marker remains after current edit removal', marker(versions[1]!).filter);
  await bindTarget(client, marker(versions[1]!), 'Remaining marker belongs to the exact original event');
  await record(context, 'marker-remains', () =>
    assert(repairedMarker.length === 1 && repairedMarker[0]!.visible &&
      /edited/iu.test(repairedMarker[0]!.text)), { markerVisible: true });
  await openHistoryMarker(client, marker(versions[1]!));
  history = await historyRows(client, 2);
  await record(context, 'reopened-two', () =>
    assert.equal(history.rows.length, 2), { rowCount: 2 });
  await record(context, 'removed-final-still-absent', () =>
    assert(!history.rows.some((entry) => entry.text.includes(versions[2]!))),
    { finalAbsent: true });
  await record(context, 'second-still-present', () =>
    assert(history.rows.some((entry) => entry.text.includes(versions[1]!))),
    { secondPresent: true });

  await reachRemove(client);
  assertNativeTarget(await client.elements(REMOVE));
  await client.tapCurrent(REMOVE);
  await client.waitElements(CONFIRM, visibleOne,
    'one visible last-edit destructive confirmation');
  assertNativeTarget(await client.elements(CONFIRM));
  await client.tapCurrent(CONFIRM);
  history = await historyRows(client, 1);
  const noSurvivors = await fixtures.serverState(account, seed.roomId,
    seed.plain.originalId, seed.plain.editIds, []);
  await record(context, 'one-after-last-remove', () => {
    assert.equal(history.rows.length, 1);
    assert(noSurvivors.removedRedacted && noSurvivors.survivorMatches &&
      noSurvivors.liveCount === 0);
  }, { rowCount: 1, serverSurvivors: 0 });
  await closeHistory(client);
  const lastDialog = await client.elements(DIALOG);
  await record(context, 'closed-after-last-remove', () =>
    assert(hidden(lastDialog)), { closed: true });

  const first = await timelineText(client, plainId, versions[0]!);
  await record(context, 'timeline-original', () =>
    assert.equal(first.text, versions[0]), { originalExact: true });
  const markerAfter = await client.elements(MARKER, marker(versions[0]!).filter);
  await record(context, 'marker-absent', () =>
    assert.equal(markerAfter.length, 0), { markerCount: 0 });

  // Removing the two plain edits leaves redacted edit rows with the same
  // "(message deleted)" wording, so no wording names the deleted original.
  // A read-only observation selects it by comparing `data-mid` in the page;
  // there is no native action on it.
  const deleted = await waitForNativeShellState(
    () => readEventRow(client, seed.doomed.originalId),
    (value) => value.rows === 1 && value.visible,
    'redacted timeline row remains visible', client.signal, 20_000);
  await record(context, 'deleted-row-visible', () =>
    assert(deleted.rows === 1 && deleted.visible), { redactedRowVisible: true });
  await record(context, 'deleted-marker-absent', () =>
    assert.equal(deleted.markers, 0), { markerCount: 0 });
  await record(context, 'deleted-body-absent', () =>
    assert(deleted.text.includes(DELETED_BODY) && !deleted.text.includes(seed.doomed.body)),
    { oldBodyAbsent: true });
}

/** Prove the compact Pixel surface and an actual device-owned large-text state. */
export async function runPixel5LargeText(
  context: PixelStageContext,
): Promise<void> {
  const { client, account, seed } = context;
  assert.equal(context.entry.id, 'pixel5-large-text');
  const marker = markerIn(seed.versions[2]!, seed.originalId);
  await client.reset(PIXEL_5_ACCOUNT_PROFILE);
  await client.login(account);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: seed.roomName }, 30_000);
  await client.tapCurrent('.channel', { text: seed.roomName });
  const latest = await timelineText(client, seed.originalId, seed.versions[2]!);
  await record(context, 'room-ready', () => assert(latest.visible),
    { ready: true });
  await record(context, 'latest-text', () =>
    assert(matchesTimelineText(latest.text, seed.versions[2]!)),
    { latestExact: true });
  const pixelMarker = await client.elements(marker.selector, marker.filter);
  const pixelTimeline = await client.visible(TIMELINE);
  await client.record('pixel-marker-before-open', {
    count: pixelMarker.length,
    rect: pixelMarker[0]?.rect,
    visible: pixelMarker[0]?.visible,
    unobstructedCenter: pixelMarker[0]?.unobstructedCenter,
    timelineRect: pixelTimeline.rect,
    timelineScrollTop: pixelTimeline.scrollTop,
    timelineScrollHeight: pixelTimeline.scrollHeight,
    timelineClientHeight: pixelTimeline.clientHeight,
  });
  await openHistoryMarker(client, marker);
  const opened = await historyRows(client, 3);
  await record(context, 'dialog-visible', () => assert(opened.visible),
    { dialogVisible: true });

  const baseline = await readPixelGeometry(client);
  const initialFont = await readFontProfile(client);
  assertPixelBaselineGeometry(baseline);
  assert.equal(initialFont.rootPx, baseline.rootPx,
    'Baseline font observation matches dialog geometry');
  await record(context, 'dialog-box-present', () =>
    assert(baseline.dialogWidth > 0 && baseline.dialogHeight > 0),
    { dialogBoxPresent: true });
  await record(context, 'fullscreen-width', () =>
    assert(baseline.dialogWidth >= baseline.width - 1),
    { width: baseline.dialogWidth });
  await record(context, 'fullscreen-height', () =>
    assert(baseline.dialogHeight >= baseline.height - 1),
    { height: baseline.dialogHeight });
  await record(context, 'close-visible', () => assert(baseline.closeVisible),
    { closeVisible: true });
  await record(context, 'close-width-44', () =>
    assert(baseline.closeWidth >= 44), { closeWidth: baseline.closeWidth });
  await record(context, 'close-height-44', () =>
    assert(baseline.closeHeight >= 44), { closeHeight: baseline.closeHeight });
  await record(context, 'dialog-no-overflow', () =>
    assert(baseline.dialogScrollWidth <= baseline.dialogClientWidth),
    { dialogOverflow: false });
  await record(context, 'toggle-visible', () => assert(baseline.toggleVisible),
    { toggleVisible: true });
  await record(context, 'revisions-visible', () =>
    assert(baseline.revisionsVisible), { readingVisible: true });
  await closeHistory(client);

  let scale: FontScaleLease | undefined;
  let stageFailure: unknown;
  try {
    await client.close();
    scale = await client.device.setFontScale('1.5');
    await client.relaunch(PIXEL_5_ACCOUNT_PROFILE);
    await client.tapCurrent('[data-testid="rail-rooms"]');
    await client.visible('.channel', { text: seed.roomName }, 30_000);
    await client.tapCurrent('.channel', { text: seed.roomName });
    await timelineText(client, seed.originalId, seed.versions[2]!);
    const scaledMarker = await client.elements(marker.selector, marker.filter);
    const scaledTimeline = await client.visible(TIMELINE);
    const scaledFont = await readFontProfile(client);
    await client.record('pixel-marker-after-scale', {
      count: scaledMarker.length,
      rect: scaledMarker[0]?.rect,
      visible: scaledMarker[0]?.visible,
      unobstructedCenter: scaledMarker[0]?.unobstructedCenter,
      timelineRect: scaledTimeline.rect,
      timelineScrollTop: scaledTimeline.scrollTop,
      timelineScrollHeight: scaledTimeline.scrollHeight,
      timelineClientHeight: scaledTimeline.clientHeight,
      rootPx: scaledFont.rootPx,
      width: scaledFont.width,
      height: scaledFont.height,
      dpr: scaledFont.dpr,
    });
    await openHistoryMarker(client, marker);
    await historyRows(client, 3);
    let scaled = await readPixelGeometry(client);
    assertScaledReading(initialFont, scaled);
    await client.record('font-scale-applied', {
      priorSetting: scale.previous,
      appliedSetting: scale.applied,
      rootBeforePx: initialFont.rootPx,
      rootAfterPx: scaled.rootPx,
      width: scaled.width,
      height: scaled.height,
      dpr: scaled.dpr,
    });
    await record(context, 'reading-no-overflow', () =>
      assert(scaled.revisionsScrollWidth <= scaled.revisionsClientWidth),
      { readingOverflow: false, rootPx: scaled.rootPx });
    scaled = await reachPixelRemove(client, scaled,
      () => readPixelGeometry(client));
    assertPixelGeometry(scaled);
    const remove = assertNativeTarget(await client.elements(REMOVE));
    await record(context, 'remove-in-viewport', () => {
      assert(scaled.removeUnobstructed);
      assert(remove.rect.y >= 0 && remove.rect.bottom <= scaled.height);
    }, { removeExposed: true });
    await record(context, 'remove-left-inside', () =>
      assert(scaled.removeLeft >= 0), { left: scaled.removeLeft });
    await record(context, 'remove-right-inside', () =>
      assert(scaled.removeRight <= scaled.width), { right: scaled.removeRight });
  } catch (error) {
    stageFailure = error;
  } finally {
    const cleanupFailures: unknown[] = [];
    try {
      await client.close();
    } catch (error) {
      cleanupFailures.push(error);
    }
    try {
      await scale?.restore();
    } catch (error) {
      cleanupFailures.push(error);
    }
    if (scale && !client.signal.aborted) {
      try {
        await client.relaunch(PIXEL_5_ACCOUNT_PROFILE);
        const restored = await readFontProfile(client);
        assert.equal(restored.rootPx, initialFont.rootPx);
        assert.equal(restored.inlineRootSize, initialFont.inlineRootSize);
        assert.equal(restored.width, initialFont.width);
        assert.equal(restored.height, initialFont.height);
        assert.equal(restored.dpr, initialFont.dpr);
        await client.record('font-scale-restored', {
          priorSetting: scale.previous,
          settingReadbackVerified: true,
          rootBeforePx: initialFont.rootPx,
          rootRestoredPx: restored.rootPx,
          width: restored.width,
          height: restored.height,
          dpr: restored.dpr,
        });
      } catch (error) {
        cleanupFailures.push(error);
      }
    }
    if (stageFailure !== undefined && cleanupFailures.length)
      throw new AggregateError([stageFailure, ...cleanupFailures],
        'Pixel stage and font restoration failed');
    if (stageFailure !== undefined) throw stageFailure;
    if (cleanupFailures.length)
      throw new AggregateError(cleanupFailures, 'Pixel font restoration failed');
  }
}

interface EditHistoryStageReport {
  readonly id: EditHistoryCase['id'];
  readonly source: string;
  status: 'running' | 'passed' | 'failed';
  durationMs: number;
  readonly artifact: string;
  readonly attempt: 1;
  readonly retries: 0;
  readonly expectedAssertionRecords: number;
  assertionRecords: number;
  assertions: string[];
  failureCount: number;
  error?: string;
}

function describeFailure(error: unknown): string {
  const message = error instanceof Error
    ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

/** Single-attempt, serial installed-Android run with post-cleanup publication safety. */
export async function runEditHistorySuite(testContext: TestContext): Promise<void> {
  await withNodeTestResources({
    testId: testContext.name,
    signal: testContext.signal,
  }, async ({ matrixResources, signal }) => {
    const session = readSession();
    const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
      join(session.workspaceRoot, 'dist/.playwright'), 'edit-history');
    await mkdir(output, { recursive: true });
    const publication = join(output, 'publication-safe');
    await rm(publication, { force: true });
    const secrets: Record<string, string> = {};
    const stages: EditHistoryStageReport[] = [];
    const report: {
      status: 'running' | 'passed' | 'failed';
      expectedStages: 2;
      expectedUniqueAssertions: 62;
      expectedAssertionRecords: 62;
      attempt: 1;
      retries: 0;
      applications: readonly string[];
      stages: EditHistoryStageReport[];
    } = {
      status: 'running',
      expectedStages: 2,
      expectedUniqueAssertions: 62,
      expectedAssertionRecords: 62,
      attempt: 1,
      retries: 0,
      applications: [APPLICATION_ID],
      stages,
    };
    const save = async (): Promise<void> =>
      writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
    await save();
    let unsafeSecrets = false;
    let scrubFailed = false;
    const markCleanupFailure = async (label: string): Promise<void> => {
      report.status = 'failed';
      const last = stages.at(-1);
      if (last) {
        last.status = 'failed';
        last.failureCount++;
        last.error = `Cleanup failed: ${label}`;
      }
      await save();
    };
    const guardedCleanup = (
      label: string,
      work: () => Promise<void>,
    ): void => matrixResources.cleanup(label, async () => {
      try {
        await work();
      } catch (error) {
        await markCleanupFailure(label);
        throw error;
      }
    });
    guardedCleanup('Scan edit-history diagnostics', async () => {
      if (unsafeSecrets || scrubFailed)
        throw new Error('Incomplete secrets or scrub blocks diagnostic publication');
      await scanEditHistoryArtifacts(output, secrets);
      await writeFile(publication, 'scanned\n');
    });
    guardedCleanup('Scrub edit-history diagnostics', async () => {
      try {
        await scrubEditHistoryArtifacts(output, secrets);
      } catch (error) {
        scrubFailed = true;
        throw error;
      }
    });
    try {
      const device = await openMaestroDevice({
        workspaceRoot: session.workspaceRoot,
        signal,
        artifactDirectory: output,
        serial: process.env['TRINITY_ANDROID_SERIAL'],
      });
      guardedCleanup('Edit-history Android device', () => device.close());
      // Fixture cleanups register after the device, so they retire first.
      const resources = new MatrixTestResources(matrixResources.namespace);
      resources.cleanup = guardedCleanup;
      const base = createAccountFixtures(resources, signal);
      const fixtures = createEditHistoryFixtures(resources, signal, base);
      const apk = join(session.workspaceRoot,
        'android/app/build/outputs/apk/debug/app-debug.apk');
      await installWithAndroidRuntimeProvenance({
        device,
        applicationId: APPLICATION_ID,
        apk,
        rendererManifest: join(session.workspaceRoot, 'dist/web-bundle-manifest.json'),
        profile: PIXEL_5_ACCOUNT_PROFILE,
        output: join(output, 'runtime-provenance.json'),
      });
      const unique = new Set<string>();
      for (const entry of editHistoryCases) {
        const directory = join(output, entry.id);
        await mkdir(directory, { recursive: true });
        const client = new AccountWorkspaceClient(device,
          session.workspaceRoot, directory, signal, APPLICATION_ID);
        const records: string[] = [];
        const stage: EditHistoryStageReport = {
          id: entry.id,
          source: entry.source,
          status: 'running',
          durationMs: 0,
          artifact: `${entry.id}/**`,
          attempt: 1,
          retries: 0,
          expectedAssertionRecords: entry.expectedAssertionRecords,
          assertionRecords: 0,
          assertions: [],
          failureCount: 0,
        };
        stages.push(stage);
        await save();
        const started = performance.now();
        const failures: unknown[] = [];
        console.info(`[edit-history] ${entry.id} start`);
        try {
          const roomName = resources.roomName(`edit-history-${entry.id}`);
          const runId = resources.userLocalpart(`edit-history-events-${entry.id}`);
          secrets[`SECRET_${entry.id}_ROOM_NAME`] = roomName;
          secrets[`SECRET_${entry.id}_RUN_ID`] = runId;
          unsafeSecrets = true;
          // Pixel parity opens history before large text; use a compact sender
          // name so the post-scale native reopen does not test an extra header case.
          const accountRole = entry.id === 'pixel5-large-text' ? 'e'
            : `edit-history-${entry.id}`;
          const account = await base.account(accountRole);
          Object.assign(secrets, editHistorySecrets(entry.id, account, roomName));
          if (entry.id === 'revision-lifecycle') {
            const seed = await fixtures.lifecycle(account, roomName, runId);
            Object.assign(secrets,
              editHistorySecrets(entry.id, account, roomName, seed));
            unsafeSecrets = false;
            await runRevisionLifecycle({
              client, entry, fixtures, account, seed, records,
            });
          } else {
            const seed = await fixtures.pixel5(account, roomName, runId);
            Object.assign(secrets,
              editHistorySecrets(entry.id, account, roomName, seed));
            unsafeSecrets = false;
            await runPixel5LargeText({
              client, entry, fixtures, account, seed, records,
            });
          }
          assertEditHistoryRecords(entry.id, records);
          for (const identity of records) {
            assert(!unique.has(identity), 'No duplicate suite assertion identity');
            unique.add(identity);
          }
        } catch (error) {
          failures.push(error);
        } finally {
          try { await client.close(); } catch (error) { failures.push(error); }
          try {
            await device.clearApplicationData(APPLICATION_ID);
          } catch (error) { failures.push(error); }
          stage.assertions = [...records];
          stage.assertionRecords = records.length;
          stage.durationMs = performance.now() - started;
          stage.failureCount = failures.length;
          stage.status = failures.length ? 'failed' : 'passed';
          if (failures.length) stage.error = failures.map(describeFailure).join('\n');
          await save();
          console.info(`[edit-history] ${entry.id} end ${stage.status}`);
        }
        if (failures.length)
          throw new AggregateError(failures, `Edit-history ${entry.id} failed`);
      }
      assert.equal(unique.size, EDIT_HISTORY_ASSERTION_RECORDS);
      report.status = 'passed';
      await save();
    } catch (error) {
      report.status = 'failed';
      await save();
      throw error;
    }
  });
}

// Importing assertion helpers in Vitest must never launch a native run.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void test('Android edit-history journeys', { timeout: 2_400_000 },
    runEditHistorySuite);
}
