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
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import {
  MESSAGE_LINKIFY_ASSERTIONS,
  MESSAGE_LINKIFY_BODY,
  MESSAGE_LINKIFY_URL,
  assertLinkifiedRendering,
  assertLinkifyRecords,
  assertLinkifyRoomRoute,
  assertPlainLinkifyEvent,
  parseLinkifyRendering,
  type LinkifyRendering,
  type MessageLinkifyAssertion,
} from './message-linkify-contract.mts';
import {
  markLinkifyDiagnosticsSafe,
  revokeLinkifyPublicationOnAbort,
  runLinkifyStageCleanup,
  scanLinkifyArtifacts,
  scrubLinkifyArtifacts,
  type LinkifyPublicationSafety,
} from './message-linkify-artifacts.mts';
import { openMaestroDevice } from './maestro-session.mts';
import { evaluateNative, waitForNativeShellState } from './native-shell-client.mts';
import { installWithAndroidRuntimeProvenance } from './runtime-provenance.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const READY_ROW = '.scroll .msg[data-mid^="$"]';
const digest = (value: string): string =>
  createHash('sha256').update(value).digest('hex');

interface StageReport {
  readonly id: 'message-linkify';
  readonly source: string;
  status: 'running' | 'passed' | 'failed';
  durationMs: number;
  readonly artifact: 'message-linkify/**';
  readonly attempt: 1;
  readonly retries: 0;
  readonly expectedAssertionRecords: 2;
  assertionRecords: number;
  assertions: MessageLinkifyAssertion[];
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
  records: MessageLinkifyAssertion[],
  identity: MessageLinkifyAssertion,
  observation: Readonly<Record<string, boolean | number | string>>,
): Promise<void> {
  assert.equal(identity, MESSAGE_LINKIFY_ASSERTIONS[records.length],
    'Linkify parity records stay in source order');
  await client.record(identity, { assertion: identity, observation });
  records.push(identity);
}

async function readyRow(client: AccountWorkspaceClient): Promise<AccountElement> {
  const [row] = await client.waitElements(READY_ROW,
    (rows) => rows.length === 1 && rows[0]!.visible &&
      rows[0]!.attributes['data-mid']?.startsWith('$') === true,
    'sent linkify row reconciled to a server event',
    { text: MESSAGE_LINKIFY_BODY }, 30_000);
  assert(row);
  return row;
}

/** Read-only renderer expression: it never activates the link or any handler. */
export function linkifyObservationExpression(eventId: string): string {
  return `(() => {
    const visible = (element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 &&
        getComputedStyle(element).visibility === 'visible';
    };
    const rows = [...document.querySelectorAll('.scroll .msg[data-mid]')]
      .filter(row => row.getAttribute('data-mid') === ${JSON.stringify(eventId)});
    const row = rows[0];
    const text = row?.querySelector('.msg__text');
    const outside = [];
    if (text) {
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        if (!node.parentElement?.closest('a')) outside.push(node.textContent ?? '');
    }
    return {
      rowCount: rows.length,
      rowId: row?.getAttribute('data-mid') ?? '',
      rowVisible: row ? visible(row) : false,
      text: text?.textContent ?? '',
      textOutsideAnchors: outside.join(''),
      anchors: text ? [...text.querySelectorAll('a')].map(anchor => ({
        text: anchor.textContent ?? '',
        href: anchor.getAttribute('href'),
        visible: visible(anchor),
      })) : [],
      // The link-preview card (#739) also links to the destination; it is a
      // separate feature, so it is counted as a receipt and excluded below.
      previewDestinations: row ? [...row.querySelectorAll('trn-link-preview a')]
        .filter(anchor => anchor.getAttribute('href') === ${JSON.stringify(MESSAGE_LINKIFY_URL)}).length : 0,
      rowDestinationMatches: row ? [...row.querySelectorAll('a')]
        .filter(anchor => !anchor.closest('trn-link-preview') &&
          anchor.getAttribute('href') === ${JSON.stringify(MESSAGE_LINKIFY_URL)}).length : 0,
      timelineMatches: [...document.querySelectorAll('.scroll .msg a')]
        .filter(anchor => !anchor.closest('trn-link-preview') &&
          anchor.getAttribute('href') === ${JSON.stringify(MESSAGE_LINKIFY_URL)}).length,
    };
  })()`;
}

async function observeLinkify(
  client: AccountWorkspaceClient,
  eventId: string,
): Promise<LinkifyRendering> {
  const expression = linkifyObservationExpression(eventId);
  const observed = await waitForNativeShellState(
    () => evaluateNative(client.webview, expression),
    (value) => {
      try {
        assertLinkifiedRendering(parseLinkifyRendering(value), eventId);
        return true;
      } catch { return false; }
    },
    'one exact visible linkified row', client.signal, 20_000,
  );
  return parseLinkifyRendering(observed);
}

/**
 * Android auto-capitalizes a sentence-initial word, and the focused-fill sentinel
 * removal relies on Home, which only reaches the start of the current visual line
 * once the URL wraps. Type the short single-line prefix through the sentinel, then
 * append the URL mid-sentence at the caret, where no capitalization applies.
 */
async function enterLinkifyBody(client: AccountWorkspaceClient): Promise<void> {
  const prefix = MESSAGE_LINKIFY_BODY.slice(0, MESSAGE_LINKIFY_BODY.indexOf(' https://'));
  assert.equal(prefix, 'look at', 'Linkify prefix is the plain sentence start');
  await client.focusCurrent(COMPOSER);
  await client.fillFocused(COMPOSER, prefix);
  await client.focused(COMPOSER);
  await client.device.runFlow(
    join(client.workspaceRoot, 'e2e/android/flows/message-linkify-append.yaml'),
    { APP_ID: client.applicationId, SECRET_TEXT: MESSAGE_LINKIFY_BODY.slice(prefix.length) },
  );
  await waitForNativeShellState(
    () => evaluateNative(client.webview,
      `document.querySelector(${JSON.stringify(COMPOSER)})?.value`),
    (value) => value === MESSAGE_LINKIFY_BODY,
    'exact native linkify composer text', client.signal, 15_000,
  );
}

async function runStage(
  client: AccountWorkspaceClient,
  fixtures: ReturnType<typeof createAccountFixtures>,
  resources: MatrixTestResources,
  secrets: Record<string, string>,
  safety: LinkifyPublicationSafety,
  records: MessageLinkifyAssertion[],
): Promise<void> {
  safety.unsafeSecrets = true;
  const roomName = resources.roomName('linkify');
  secrets.SECRET_LINKIFY_ROOM_NAME = roomName;
  const account = await fixtures.account('linkify');
  secrets.SECRET_LINKIFY_USERNAME = account.username;
  secrets.SECRET_LINKIFY_USER_ID = account.userId;
  secrets.SECRET_LINKIFY_PASSWORD = account.password;
  const room = await fixtures.createRoom(account, { name: roomName });
  secrets.SECRET_LINKIFY_ROOM_ID = room.id;
  secrets.SECRET_LINKIFY_ROOM_SEGMENT = Buffer.from(room.id).toString('base64url');
  safety.unsafeSecrets = false;

  await client.login(account);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: room.name }, 30_000);
  await client.tapCurrent('.channel', { text: room.name });
  await client.visible(COMPOSER, {}, 15_000);
  const route = await waitForNativeShellState(
    () => evaluateNative(client.webview, 'location.href'),
    (value) => {
      if (typeof value !== 'string') return false;
      try { assertLinkifyRoomRoute(value, room.id, account.userId); return true; }
      catch { return false; }
    },
    'exact native Room route', client.signal, 15_000,
  );
  assert(typeof route === 'string', 'Native route is a URL');
  assertLinkifyRoomRoute(route, room.id, account.userId);
  await record(client, records, 'message-linkify.room-ready', {
    exactRoom: true, roomDigest: digest(room.id), composerVisible: true,
  });

  await enterLinkifyBody(client);
  await client.key('enter');
  const row = await readyRow(client);
  const eventId = row.attributes['data-mid'];
  assert(eventId?.startsWith('$'), 'Sent row has a real event ID');
  secrets.SECRET_LINKIFY_EVENT_ID = eventId;
  assertPlainLinkifyEvent(await fixtures.roomEvent(account, room.id, eventId), {
    eventId, roomId: room.id, sender: account.userId,
  });
  const rendering = await observeLinkify(client, eventId);
  assertLinkifiedRendering(rendering, eventId);
  await record(client, records, 'message-linkify.link-visible', {
    serverReady: true,
    plainTextBody: true,
    eventDigest: digest(eventId),
    anchorCount: rendering.anchors.length,
    exactLinkText: true,
    exactDestination: true,
    surroundingTextPlain: true,
    rowDestinationMatches: rendering.rowDestinationMatches,
    previewDestinations: rendering.previewDestinations,
    timelineMatches: rendering.timelineMatches,
  });
  assertLinkifyRecords(records);
}

export async function runMessageLinkifySuite(testContext: TestContext): Promise<void> {
  let effectiveSignal = testContext.signal;
  let revokeOnAbort: (() => Promise<void>) | undefined;
  try {
    await withNodeTestResources({ testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        effectiveSignal = signal;
        const session = readSession();
        const output = join(process.env['TRINITY_E2E_REPORT_DIR'] ??
          join(session.workspaceRoot, 'dist/.playwright'), 'message-linkify');
        await mkdir(output, { recursive: true });
        await rm(join(output, 'publication-safe'), { force: true });
        const stages: StageReport[] = [];
        const report = {
          status: 'running' as 'running' | 'passed' | 'failed',
          expectedStages: 1 as const,
          expectedUniqueAssertions: 2 as const,
          expectedAssertionRecords: 2 as const,
          attempt: 1 as const,
          retries: 0 as const,
          applications: [APPLICATION_ID],
          stages,
        };
        const save = async (): Promise<void> =>
          writeFile(join(output, 'journeys.json'), `${JSON.stringify(report, null, 2)}\n`);
        await save();
        revokeOnAbort = () => revokeLinkifyPublicationOnAbort(output, report, signal);
        const secrets: Record<string, string> = {};
        const safety: LinkifyPublicationSafety = {
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
        guardedCleanup('Scan linkify diagnostics', () =>
          report.status === 'passed'
            ? markLinkifyDiagnosticsSafe(output, secrets, safety, signal)
            : scanLinkifyArtifacts(output, secrets));
        guardedCleanup('Scrub linkify diagnostics', async () => {
          try { await scrubLinkifyArtifacts(output, secrets); }
          catch (error) { safety.scrubFailed = true; throw error; }
        });
        try {
          const device = await openMaestroDevice({
            workspaceRoot: session.workspaceRoot,
            signal,
            artifactDirectory: output,
            serial: process.env['TRINITY_ANDROID_SERIAL'],
          });
          guardedCleanup('Linkify Android device', () => device.close());
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
          const directory = join(output, 'message-linkify');
          await mkdir(directory, { recursive: true });
          const client = new AccountWorkspaceClient(device,
            session.workspaceRoot, directory, signal, APPLICATION_ID);
          const records: MessageLinkifyAssertion[] = [];
          const stage: StageReport = {
            id: 'message-linkify',
            source: 'e2e/browser/journeys/conversations/message-linkify.spec.mts:14-72',
            status: 'running', durationMs: 0, artifact: 'message-linkify/**',
            attempt: 1, retries: 0, expectedAssertionRecords: 2,
            assertionRecords: 0, assertions: [], failureCount: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          let active = false;
          console.info('[message-linkify] stage start');
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
            await runLinkifyStageCleanup([
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
            console.info(`[message-linkify] stage end ${stage.status}`);
          }
          if (failures.length)
            throw new AggregateError(failures, 'Android message-linkify stage failed');
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
  void test('Android message-linkify journey', { timeout: 1_200_000 },
    runMessageLinkifySuite);
}
