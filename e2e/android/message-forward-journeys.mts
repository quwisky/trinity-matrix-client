import assert from 'node:assert/strict';
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
  MESSAGE_FORWARD_ASSERTIONS,
  assertExactPickerResult,
  assertForwardRoomRoute,
  assertForwardRecords,
  assertForwardTargetEvent,
  assertNativeSheetReady,
  assertReadySourceEvent,
  type ForwardPickerResult,
  type MessageForwardAssertion,
} from './message-forward-contract.mts';
import {
  forwardRoomSecrets,
  forwardSecrets,
  markForwardDiagnosticsSafe,
  revokeForwardPublicationOnAbort,
  runForwardStageCleanup,
  scrubForwardArtifacts,
} from './message-forward-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { evaluateNative, waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const READY_ROW = '.scroll .msg[data-mid^="$"]';
const SHEET = '[role="dialog"][aria-label="Message actions"]';
const FORWARD = '[data-testid="sheet-forward"]';
const PICKER = '[data-testid="switcher-input"]';
const PICKER_RESULT = '[data-testid="switcher-result"]';

interface StageReport {
  readonly id: 'forward-to-room';
  readonly source: string;
  status: 'running' | 'passed' | 'failed';
  durationMs: number;
  readonly artifact: 'forward-to-room/**';
  readonly attempt: 1;
  readonly retries: 0;
  readonly expectedAssertionRecords: 7;
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

async function record(
  client: AccountWorkspaceClient,
  records: MessageForwardAssertion[],
  identity: MessageForwardAssertion,
  observation: unknown,
): Promise<void> {
  assert.equal(identity, MESSAGE_FORWARD_ASSERTIONS[records.length],
    'Forward parity records stay in source order');
  await client.record(identity, { assertion: identity, observation });
  records.push(identity);
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomName }, 30_000);
  await client.tapCurrent('.channel', { text: roomName });
  await client.visible(COMPOSER, {}, 15_000);
}

async function assertCurrentRoom(
  client: AccountWorkspaceClient,
  roomId: string,
  userId: string,
): Promise<void> {
  const url = await waitForNativeShellState(
    () => evaluateNative(client.webview, 'location.href'),
    (value) => {
      if (typeof value !== 'string') return false;
      try { assertForwardRoomRoute(value, roomId, userId); return true; }
      catch { return false; }
    },
    'exact native Room route', client.signal, 15_000,
  );
  assert(typeof url === 'string', 'Native route is a URL');
  assertForwardRoomRoute(url, roomId, userId);
  await client.visible(COMPOSER, {}, 15_000);
}

async function readyRow(
  client: AccountWorkspaceClient,
  body: string,
  description: string,
): Promise<AccountElement> {
  const [row] = await client.waitElements(READY_ROW,
    (rows) => rows.length === 1 && rows[0]!.visible &&
      rows[0]!.attributes['data-mid']?.startsWith('$') === true &&
      rows[0]!.text.includes(body),
    description, { text: body }, 30_000);
  assert(row);
  return row;
}

async function readPickerResults(
  client: AccountWorkspaceClient,
): Promise<readonly ForwardPickerResult[]> {
  const value = await evaluateNative(client.webview, `(() =>
    [...document.querySelectorAll('[data-testid="switcher-result"]')].map(row => {
      const rect=row.getBoundingClientRect();
      return {
        title:row.querySelector('span.block.truncate.text-sm.font-medium')?.textContent?.trim()??'',
        kind:row.querySelector('trn-icon.qs-kind + span')?.textContent?.trim()??'',
        visible:rect.width>0&&rect.height>0&&getComputedStyle(row).visibility==='visible'
      };
    })
  )()`);
  assert(Array.isArray(value), 'Room picker observation is an array');
  for (const result of value) {
    assert(result !== null && typeof result === 'object' &&
      'title' in result && typeof result.title === 'string' &&
      'kind' in result && typeof result.kind === 'string' &&
      'visible' in result && typeof result.visible === 'boolean',
    'Room picker result has read-only title/kind/visibility');
  }
  return value as ForwardPickerResult[];
}

async function runStage(
  client: AccountWorkspaceClient,
  fixtures: ReturnType<typeof createAccountFixtures>,
  account: NodeWorkspaceAccount,
  source: WorkspaceRoom,
  target: WorkspaceRoom,
  body: string,
  secrets: Record<string, string>,
  records: MessageForwardAssertion[],
): Promise<void> {
  await client.login(account);
  await openRoom(client, source.name);
  await assertCurrentRoom(client, source.id, account.userId);
  await record(client, records, 'message-forward.source-room-ready', {
    composerVisible: true,
  });

  await client.fill('[data-testid="composer-input"]', body);
  await client.key('enter');
  const sourceRow = await readyRow(client, body, 'source row reconciled to server event');
  const sourceEventId = sourceRow.attributes['data-mid'];
  assert(sourceEventId?.startsWith('$'), 'Source row has a real event ID');
  secrets.SECRET_FORWARD_SOURCE_EVENT_ID = sourceEventId;
  await record(client, records, 'message-forward.source-row-visible', {
    visible: sourceRow.visible,
    serverId: true,
  });
  const sourceEvent = await fixtures.roomEvent(account, source.id, sourceEventId);
  assertReadySourceEvent(sourceEvent, {
    eventId: sourceEventId,
    roomId: source.id,
    sender: account.userId,
    body,
  });
  await record(client, records, 'message-forward.source-server-ready', {
    exactSourceEvent: true,
  });

  await client.longPressCurrent('.scroll .msg[data-mid^="$"]', { text: body });
  const dialogs = await client.waitElements(SHEET,
    (values) => values.length === 1 && values[0]!.visible,
    'Android message-action sheet', {}, 15_000);
  const actions = await client.elements(FORWARD);
  assertNativeSheetReady(dialogs, actions);
  await record(client, records, 'message-forward.sheet-ready', {
    oneNativeSheet: true,
    oneForwardAction: true,
  });
  await client.tapCurrent('[data-testid="sheet-forward"]');

  await client.visible(PICKER, {}, 10_000);
  await record(client, records, 'message-forward.picker-visible', {
    searchVisible: true,
  });
  await client.fill('[data-testid="switcher-input"]', target.name);
  await client.waitElements(PICKER_RESULT,
    (rows) => rows.length === 1 && rows[0]!.visible &&
      rows[0]!.text.includes(target.name),
    'one matching Room picker result', {}, 15_000);
  await waitForNativeShellState(
    () => readPickerResults(client),
    (results) => {
      try { assertExactPickerResult(results, target.name); return true; }
      catch { return false; }
    },
    'one exact target Room picker result', client.signal, 15_000,
  );
  assertExactPickerResult(await readPickerResults(client), target.name);
  await client.tapCurrent(PICKER_RESULT, { text: target.name });

  await client.tapCurrent('[data-testid="back-to-rooms"]');
  await openRoom(client, target.name);
  await assertCurrentRoom(client, target.id, account.userId);
  await record(client, records, 'message-forward.target-room-ready', {
    composerVisible: true,
  });
  const targetRow = await readyRow(client, body, 'forwarded target row reconciled');
  const targetEventId = targetRow.attributes['data-mid'];
  assert(targetEventId?.startsWith('$'), 'Target row has a real event ID');
  assert.notEqual(targetEventId, sourceEventId, 'Forwarded row is a new event');
  secrets.SECRET_FORWARD_TARGET_EVENT_ID = targetEventId;
  const targetEvent = await fixtures.roomEvent(account, target.id, targetEventId);
  assert.equal(targetEvent['event_id'], targetEventId,
    'Target server event matches the observed Room row');
  assertForwardTargetEvent(targetEvent, {
    sourceEventId,
    roomId: target.id,
    sender: account.userId,
    body,
  });
  await record(client, records, 'message-forward.target-row-and-event', {
    visible: targetRow.visible,
    distinctServerEvent: true,
    exactRoomSenderBody: true,
    noStaleRelation: true,
  });
  assertForwardRecords(records);
}

export async function runMessageForwardSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({
    testId: testContext.name,
    signal: testContext.signal,
  }, async ({ matrixResources, signal }) => {
    effectiveSignal = signal;
    const session = readSession();
    const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
      join(session.workspaceRoot, 'dist/.playwright'), 'message-forward');
    await mkdir(output, { recursive: true });
    const publication = join(output, 'publication-safe');
    await rm(publication, { force: true });
    const secrets: Record<string, string> = {};
    const stages: StageReport[] = [];
    const report: {
      status: 'running' | 'passed' | 'failed';
      expectedStages: 1;
      expectedUniqueAssertions: 7;
      expectedAssertionRecords: 7;
      attempt: 1;
      retries: 0;
      readonly applications: readonly string[];
      readonly stages: StageReport[];
    } = {
      status: 'running', expectedStages: 1,
      expectedUniqueAssertions: 7, expectedAssertionRecords: 7,
      attempt: 1, retries: 0, applications: [APPLICATION_ID], stages,
    };
    revokeOnAbort = () => revokeForwardPublicationOnAbort(output, report, signal);
    const save = async (): Promise<void> =>
      writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
    await save();
    const safety = {
      unsafeSecrets: false,
      cleanupFailed: false,
      scrubFailed: false,
    };
    const guardedCleanup = (
      label: string,
      work: () => Promise<void>,
    ): void => matrixResources.cleanup(label, async () => {
      try { await work(); }
      catch (error) {
        safety.cleanupFailed = true;
        report.status = 'failed';
        const stage = stages.at(-1);
        if (stage) {
          stage.status = 'failed';
          stage.failureCount++;
          stage.error = `Cleanup failed: ${label}`;
        }
        await save();
        throw error;
      }
    });
    guardedCleanup('Scan forward diagnostics', async () => {
      await markForwardDiagnosticsSafe(output, secrets, safety, signal);
    });
    guardedCleanup('Scrub forward diagnostics', async () => {
      try { await scrubForwardArtifacts(output, secrets); }
      catch (error) { safety.scrubFailed = true; throw error; }
    });
    try {
      const device = await openMaestroDevice({
        workspaceRoot: session.workspaceRoot,
        signal,
        artifactDirectory: output,
        serial: process.env['TRINITY_ANDROID_SERIAL'],
      });
      guardedCleanup('Forward Android device', () => device.close());
      const resources = new MatrixTestResources(matrixResources.namespace);
      resources.cleanup = guardedCleanup;
      const fixtures = createAccountFixtures(resources, signal);
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

      const sourceName = resources.roomName('forward-source');
      const targetName = resources.roomName('forward-target');
      const body = `Forward this ${resources.userLocalpart('forward-body')}`;
      const directory = join(output, 'forward-to-room');
      await mkdir(directory, { recursive: true });
      const client = new AccountWorkspaceClient(device,
        session.workspaceRoot, directory, signal, APPLICATION_ID);
      const records: MessageForwardAssertion[] = [];
      const stage: StageReport = {
        id: 'forward-to-room',
        source: 'e2e/browser/journeys/conversations/message-forward.spec.mts:30-94',
        status: 'running', durationMs: 0, artifact: 'forward-to-room/**',
        attempt: 1, retries: 0, expectedAssertionRecords: 7,
        assertionRecords: 0, assertions: [], failureCount: 0,
      };
      stages.push(stage);
      await save();
      const started = performance.now();
      const failures: unknown[] = [];
      let active = false;
      console.info('[message-forward] forward-to-room start');
      try {
        await client.reset(PIXEL_5_ACCOUNT_PROFILE);
        active = true;
        safety.unsafeSecrets = true;
        const account = await fixtures.account('forward');
        Object.assign(secrets,
          forwardSecrets(account, sourceName, targetName, body));
        const source = await fixtures.createRoom(account, { name: sourceName });
        secrets.SECRET_FORWARD_SOURCE_ROOM_ID = source.id;
        secrets.SECRET_FORWARD_SOURCE_ROOM_SEGMENT = Buffer.from(source.id).toString('base64url');
        const target = await fixtures.createRoom(account, { name: targetName });
        Object.assign(secrets, forwardRoomSecrets(source.id, target.id));
        safety.unsafeSecrets = false;
        await runStage(client, fixtures, account, source, target, body,
          secrets, records);
        await client.capture('passed');
      } catch (error) {
        failures.push(error);
        try { if (active) await client.capture('failed'); }
        catch (captureError) { failures.push(captureError); }
      } finally {
        await runForwardStageCleanup([
          () => client.close(),
          () => device.clearApplicationData(APPLICATION_ID),
        ], safety, failures);
        stage.assertions = [...records];
        stage.assertionRecords = records.length;
        stage.durationMs = performance.now() - started;
        stage.failureCount = failures.length;
        stage.status = failures.length ? 'failed' : 'passed';
        if (failures.length) stage.error = failures.map(describeFailure).join('\n');
        await save();
        console.info(`[message-forward] forward-to-room end ${stage.status}`);
      }
      if (failures.length)
        throw new AggregateError(failures, 'Android message-forward stage failed');
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
  void test('Android message-forward journey', { timeout: 1_200_000 },
    runMessageForwardSuite);
}
