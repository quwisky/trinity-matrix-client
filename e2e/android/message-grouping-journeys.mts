import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, type TestContext } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import { MatrixTestResources } from '../support/test-resources.mts';
import { AccountWorkspaceClient, PIXEL_5_ACCOUNT_PROFILE } from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import { readNativeAppearanceDensityPreference } from './appearance-density-preference.mts';
import {
  MESSAGE_GROUPING_ASSERTIONS,
  assertCompactGrouping,
  assertCosyGrouping,
  assertExactRows,
  assertGroupingRecords,
  assertGroupingRoomRoute,
  parseGroupingGeometry,
  type GroupingEvent,
  type GroupingGeometry,
  type MessageGroupingAssertion,
} from './message-grouping-contract.mts';
import {
  markGroupingDiagnosticsSafe,
  revokeGroupingPublicationOnAbort,
  runGroupingStageCleanup,
  scanGroupingArtifacts,
  scrubGroupingArtifacts,
  type GroupingPublicationSafety,
} from './message-grouping-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { evaluateNative, waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const BODIES = [
  'First message',
  'Second message with enough text to reach the trailing action track without the reserved inset',
  'Third message',
] as const;
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

interface StageReport {
  readonly id: 'message-grouping';
  readonly source: string;
  status: 'running' | 'passed' | 'failed';
  durationMs: number;
  readonly artifact: 'message-grouping/**';
  readonly attempt: 1;
  readonly retries: 0;
  readonly expectedAssertionRecords: 22;
  assertionRecords: number;
  assertions: MessageGroupingAssertion[];
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
  records: MessageGroupingAssertion[],
  identity: MessageGroupingAssertion,
  observation: Readonly<Record<string, boolean | number | string>>,
): Promise<void> {
  assert.equal(identity, MESSAGE_GROUPING_ASSERTIONS[records.length],
    'Grouping parity records stay in source order');
  await client.record(identity, { assertion: identity, observation });
  records.push(identity);
}

/** Renderer observation only: exact event IDs are scoped in memory and never written. */
async function observeGrouping(
  client: AccountWorkspaceClient,
  events: readonly GroupingEvent[],
): Promise<GroupingGeometry> {
  const expression = `(() => {
    const wanted = new Set(${JSON.stringify(events.map((event) => event.id))});
    const rows = [...document.querySelectorAll('.msg[data-mid]')]
      .filter(row => wanted.has(row.getAttribute('data-mid')))
      .map(row => {
        const box = row.getBoundingClientRect();
        const style = getComputedStyle(row);
        const lead = row.querySelector('.msg__avatar, .msg__gutter');
        const text = row.querySelector('.msg__text');
        const body = row.querySelector('.msg__body');
        if (!lead || !text || !body) return null;
        const bodyBox = body.getBoundingClientRect();
        const textBox = text.getBoundingClientRect();
        const textStyle = getComputedStyle(text);
        return {
          id: row.getAttribute('data-mid'),
          body: text.textContent?.trim() ?? '',
          visible: box.width > 0 && box.height > 0 && style.visibility === 'visible' &&
            textBox.width > 0 && textBox.height > 0 && textStyle.visibility === 'visible',
          continuation: row.classList.contains('msg--cont'),
          avatarCount: row.querySelectorAll('.msg__avatar').length,
          leadWidth: lead.getBoundingClientRect().width,
          textLeft: textBox.left,
          paddingTop: parseFloat(style.paddingTop),
          marginTop: parseFloat(style.marginTop),
          height: box.height,
          columnGap: parseFloat(style.columnGap),
          bodyEndGap: box.right - parseFloat(style.paddingInlineEnd) - bodyBox.right,
        };
      });
    return { rows, toolbarCount: document.querySelectorAll('.msg__toolbar').length };
  })()`;
  const observed = await waitForNativeShellState(
    () => evaluateNative(client.webview, expression),
    (value) => {
      try {
        const geometry = parseGroupingGeometry(value);
        return geometry.rows.every((row, index) =>
          row.id === events[index]?.id && row.body === events[index]?.body && row.visible);
      } catch { return false; }
    },
    'three exact visible grouping rows', client.signal, 30_000,
  );
  return parseGroupingGeometry(observed);
}

async function runStage(
  client: AccountWorkspaceClient,
  fixtures: ReturnType<typeof createAccountFixtures>,
  resources: MatrixTestResources,
  secrets: Record<string, string>,
  safety: GroupingPublicationSafety,
  records: MessageGroupingAssertion[],
): Promise<void> {
  safety.unsafeSecrets = true;
  const roomName = resources.roomName('grouping');
  secrets.SECRET_GROUPING_ROOM_NAME = roomName;
  const account = await fixtures.account('grouping');
  secrets.SECRET_GROUPING_USERNAME = account.username;
  secrets.SECRET_GROUPING_USER_ID = account.userId;
  secrets.SECRET_GROUPING_PASSWORD = account.password;
  const room = await fixtures.createRoom(account, { name: roomName, preset: 'private_chat' });
  secrets.SECRET_GROUPING_ROOM_ID = room.id;
  secrets.SECRET_GROUPING_ROOM_SEGMENT = Buffer.from(room.id).toString('base64url');
  const events: GroupingEvent[] = [];
  for (const [index, body] of BODIES.entries()) {
    secrets[`SECRET_GROUPING_BODY_${index}`] = body;
    const id = await fixtures.sendMessage(account, room.id, body, `grouping-${index}`);
    assert(id.startsWith('$'), 'Fixture send returned a real Matrix event ID');
    secrets[`SECRET_GROUPING_EVENT_${index}`] = id;
    events.push({ id, body });
  }
  safety.unsafeSecrets = false;

  await client.login(account);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: room.name }, 30_000);
  await client.tapCurrent('.channel', { text: room.name });
  await client.visible(COMPOSER, {}, 15_000);
  assertGroupingRoomRoute(
    (await evaluateNative(client.webview, 'location.href')) as string,
    room.id, account.userId,
  );
  const cosy = await observeGrouping(client, events);
  assertExactRows(cosy.rows, events);
  const nativeCosy = await readNativeAppearanceDensityPreference(client, 'cosy');
  assert.equal(nativeCosy.value, 'cosy');
  assert.equal(await waitForNativeShellState(
    () => evaluateNative(client.webview,
      "document.documentElement.getAttribute('data-density') ?? 'cosy'"),
    (value) => value === 'cosy',
    'rendered Cosy density', client.signal, 15_000,
  ), 'cosy');
  assertCosyGrouping(cosy);
  await record(client, records, 'message-grouping.room-visible', {
    exactRoom: true, roomDigest: digest(room.id),
  });
  await record(client, records, 'message-grouping.body-first', {
    exactBody: true, eventIndex: 0, eventDigest: digest(events[0]!.id),
  });
  await record(client, records, 'message-grouping.body-second', {
    exactBody: true, eventIndex: 1, eventDigest: digest(events[1]!.id),
  });
  await record(client, records, 'message-grouping.body-third', {
    exactBody: true, eventIndex: 2, eventDigest: digest(events[2]!.id),
  });
  await record(client, records, 'message-grouping.avatar-count', { count: cosy.rows[0]!.avatarCount });
  await record(client, records, 'message-grouping.continuation-count', { count: 2 });
  for (const [index, identity] of MESSAGE_GROUPING_ASSERTIONS.slice(6, 9).entries())
    await record(client, records, identity, { usedLeadWidth: cosy.rows[index]!.leadWidth });
  for (const [index, identity] of MESSAGE_GROUPING_ASSERTIONS.slice(9, 12).entries())
    await record(client, records, identity, { textLeft: cosy.rows[index]!.textLeft });
  await record(client, records, 'message-grouping.cosy-start-padding', { usedPaddingTop: cosy.rows[0]!.paddingTop });
  await record(client, records, 'message-grouping.cosy-continuation-padding', { bothZero: true });
  await record(client, records, 'message-grouping.cosy-start-margin', { usedMarginTop: cosy.rows[0]!.marginTop });
  await record(client, records, 'message-grouping.phone-no-toolbar', { count: cosy.toolbarCount });

  const flowRoot = join(client.workspaceRoot, 'e2e/android/flows');
  await client.tapCurrent('[data-testid="back-to-rooms"]');
  await client.visible('[data-testid="rail-rooms"]', {}, 15_000);
  await client.device.runFlow(join(flowRoot, 'native-shell-settings.yaml'), { APP_ID: client.applicationId });
  await client.device.runFlow(join(flowRoot, 'native-shell-appearance.yaml'), { APP_ID: client.applicationId });
  const trigger = await evaluateNative(client.webview,
    `document.querySelector('[data-testid="density-select"] button')?.id`);
  assert(typeof trigger === 'string' && trigger.length > 0,
    'Density trigger has a native-accessible ID');
  await client.device.runFlow(join(flowRoot, 'native-shell-appearance-compact.yaml'), {
    APP_ID: client.applicationId, DENSITY_TRIGGER_ID: trigger,
  });
  assert.deepEqual(await readNativeAppearanceDensityPreference(client, 'compact'),
    { present: true, version: 1, value: 'compact' });
  assert.equal(await waitForNativeShellState(
    () => evaluateNative(client.webview,
      "document.documentElement.getAttribute('data-density')"),
    (value) => value === 'compact',
    'rendered Compact density', client.signal, 15_000,
  ), 'compact');
  await client.device.runFlow(join(flowRoot, 'native-shell-back.yaml'), { APP_ID: client.applicationId });
  await client.device.runFlow(join(flowRoot, 'native-shell-back.yaml'), { APP_ID: client.applicationId });
  await client.visible('[data-testid="rail-rooms"]', {}, 15_000);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: room.name }, 30_000);
  await client.tapCurrent('.channel', { text: room.name });
  await client.visible(COMPOSER, {}, 15_000);
  assertGroupingRoomRoute(
    (await evaluateNative(client.webview, 'location.href')) as string,
    room.id, account.userId,
  );
  const compact = await observeGrouping(client, events);
  assertExactRows(compact.rows, events);
  assertCompactGrouping(cosy, compact);
  await record(client, records, 'message-grouping.compact-column-gap', {
    usedColumnGap: compact.rows[0]!.columnGap,
    nativeSelection: true,
    persistedCompact: true,
    persistenceVersion: 1,
  });
  await record(client, records, 'message-grouping.compact-total-height', {
    cosy: cosy.rows.reduce((sum, row) => sum + row.height, 0),
    compact: compact.rows.reduce((sum, row) => sum + row.height, 0),
  });
  await record(client, records, 'message-grouping.compact-start-padding', { usedPaddingTop: compact.rows[0]!.paddingTop });
  await record(client, records, 'message-grouping.compact-start-margin', { usedMarginTop: compact.rows[0]!.marginTop });
  await record(client, records, 'message-grouping.compact-continuation-padding', { bothZero: true });
  await record(client, records, 'message-grouping.compact-body-end-gap', { usedGap: compact.rows[1]!.bodyEndGap ?? NaN });
  assertGroupingRecords(records);
}

export async function runMessageGroupingSuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'message-grouping');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        const stages: StageReport[] = [];
        const report = {
          status: 'running' as 'running' | 'passed' | 'failed',
          expectedStages: 1 as const,
          expectedUniqueAssertions: 22 as const,
          expectedAssertionRecords: 22 as const,
          attempt: 1 as const,
          retries: 0 as const,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeGroupingPublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: GroupingPublicationSafety = {
          unsafeSecrets: false, cleanupFailed: false, scrubFailed: false,
        };
        const guardedCleanup = (label: string, action: () => Promise<void>): void =>
          matrixResources.cleanup(label, async () => {
            try { await action(); }
            catch (error) {
              safety.cleanupFailed = true;
              report.status = 'failed';
              const stage = stages.at(-1);
              if (stage) {
                stage.status = 'failed';
                stage.failureCount++;
                stage.error = stage.error
                  ? `${stage.error}\nCleanup failed: ${label}`
                  : `Cleanup failed: ${label}`;
              }
              await save();
              throw error;
            }
          });
        guardedCleanup('Scan grouping diagnostics', () =>
          report.status === 'passed'
            ? markGroupingDiagnosticsSafe(output, secrets, safety, signal)
            : scanGroupingArtifacts(output, secrets));
        guardedCleanup('Scrub grouping diagnostics', async () => {
          try { await scrubGroupingArtifacts(output, secrets); }
          catch (error) { safety.scrubFailed = true; throw error; }
        });
        try {
          const device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          guardedCleanup('Grouping Android device', () => device.close());
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
          const directory = join(output, 'message-grouping');
          await mkdir(directory, { recursive: true });
          const client = new AccountWorkspaceClient(device,
            session.workspaceRoot, directory, signal, APPLICATION_ID);
          const records: MessageGroupingAssertion[] = [];
          const stage: StageReport = {
            id: 'message-grouping',
            source: 'e2e/browser/journeys/conversations/message-grouping.spec.mts:25-234',
            status: 'running', durationMs: 0, artifact: 'message-grouping/**',
            attempt: 1, retries: 0, expectedAssertionRecords: 22,
            assertionRecords: 0, assertions: [], failureCount: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          let active = false;
          console.info('[message-grouping] stage start');
          try {
            await client.reset(PIXEL_5_ACCOUNT_PROFILE);
            active = true;
            await runStage(client, fixtures, resources, secrets, safety, records);
            await client.capture('passed');
          } catch (error) {
            failures.push(error);
            try { if (active) await client.capture('failed'); }
            catch (captureError) { failures.push(captureError); }
          } finally {
            await runGroupingStageCleanup([
              () => client.close(),
              () => device.clearApplicationData(APPLICATION_ID),
            ], failures);
            if (failures.length) safety.cleanupFailed = true;
            stage.assertions = [...records];
            stage.assertionRecords = records.length;
            stage.durationMs = performance.now() - started;
            stage.failureCount = failures.length;
            stage.status = failures.length ? 'failed' : 'passed';
            if (failures.length) stage.error = failures.map(describeFailure).join('\n');
            await save();
            console.info(`[message-grouping] stage end ${stage.status}`);
          }
          if (failures.length)
            throw new AggregateError(failures, 'Android message-grouping stage failed');
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void test('Android message-grouping journey', { timeout: 1_200_000 },
    runMessageGroupingSuite);
}
