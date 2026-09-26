import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountElement,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';
import {
  JUMP_TO_DATE_ASSERTION_RECORDS,
  JUMP_TO_DATE_BROWSER_ONLY,
  JUMP_TO_DATE_FILLER_COUNT,
  JUMP_TO_DATE_SOURCES,
  jumpToDateAssertions as assertions,
  type JumpToDateAssertion,
} from './jump-to-date-contract.mts';
import {
  openJumpToDateNetworkObserver,
  readDeviceLocalDate,
  type JumpToDateNetworkObserver,
} from './jump-to-date-network-observer.mts';
import {
  nativeStorageMethodDataIsRedacted,
  openMaestroDevice,
  redactMaestroArtifacts,
  type MaestroDevice,
} from './maestro-session.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const textArtifactExtensions = new Set([
  '.json',
  '.jsonl',
  '.log',
  '.txt',
  '.xml',
  '.yaml',
]);
const rasterArtifactExtensions = new Set([
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
]);
const allAssertionIds = Object.values(
  assertions,
) as readonly JumpToDateAssertion[];

interface JumpToDateCase {
  readonly id: 'history-backfill';
  readonly source: string;
}

interface JumpToDateStageContext {
  readonly client: AccountWorkspaceClient;
  readonly device: MaestroDevice;
  readonly fixtures: ReturnType<typeof createAccountFixtures>;
  readonly secrets: Record<string, string>;
  readonly unique: Set<JumpToDateAssertion>;
  readonly records: Set<JumpToDateAssertion>;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  unique: Set<JumpToDateAssertion>,
  records: Set<JumpToDateAssertion>,
  identity: JumpToDateAssertion,
  observation: unknown,
): Promise<void> {
  assert(!records.has(identity), `${identity} is recorded exactly once`);
  records.add(identity);
  unique.add(identity);
  await client.record(identity, { assertion: identity, observation });
}

function eventRows(
  candidates: readonly AccountElement[],
  eventId: string,
): readonly AccountElement[] {
  return candidates.filter(
    (candidate) => candidate.attributes['data-mid'] === eventId,
  );
}

async function observeEventVisible(
  client: AccountWorkspaceClient,
  eventId: string,
  exactBody: string,
  description: string,
  timeoutMs: number,
): Promise<AccountElement> {
  const rows = await client.waitElements(
    '.scroll .msg',
    (candidates) => {
      const matches = eventRows(candidates, eventId);
      return (
        matches.length === 1 &&
        matches[0]!.visible &&
        matches[0]!.text.includes(exactBody)
      );
    },
    description,
    {},
    timeoutMs,
  );
  const matches = eventRows(rows, eventId);
  assert.equal(matches.length, 1);
  return matches[0]!;
}

async function scanJumpToDateArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const secretValues = [...new Set(Object.values(secrets).filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      assert(entry.isFile(), `Jump-to-date artifact is a file: ${path}`);
      const extension = extname(path).toLowerCase();
      assert(
        !rasterArtifactExtensions.has(extension),
        `Raster artifact was removed from ${path}`,
      );
      if (!textArtifactExtensions.has(extension)) continue;
      const text = await readFile(path, 'utf8');
      for (const secret of secretValues) {
        assert(!text.includes(secret), `Secret is absent from ${path}`);
      }
      assert(!/\bBearer\s+\S+/u.test(text), `Bearer token is absent from ${path}`);
      assert(
        !/\bsyt_[A-Za-z0-9._~-]+/u.test(text),
        `Matrix access token is absent from ${path}`,
      );
      assert(
        !/[?&](?:api_)?key=/iu.test(text),
        `Query-string secret key is absent from ${path}`,
      );
      assert(
        nativeStorageMethodDataIsRedacted(text, 'Preferences'),
        `Preferences method data is redacted in ${path}`,
      );
    }
  }
  await scan(output);
}

async function runJumpToDateStage(
  context: JumpToDateStageContext,
): Promise<void> {
  const { client, device, fixtures, secrets, unique, records } = context;
  const account: NodeWorkspaceAccount = await fixtures.account(
    'jump-to-date-owner',
  );
  const roomName = `Jump ${account.username}`;
  const markerBody = `first-of-the-day ${account.username}`;
  const fillerPrefix = `filler ${account.username}`;
  const transactionPrefix = `jump-${account.username}`;
  secrets['SECRET_ROOM_NAME'] = roomName;
  secrets['SECRET_MARKER_BODY'] = markerBody;
  secrets['SECRET_FILLER_PREFIX'] = fillerPrefix;

  const history = await fixtures.createJumpToDateHistory(
    account,
    roomName,
    markerBody,
    fillerPrefix,
    transactionPrefix,
  );
  assert.equal(history.fillerEventIds.length, JUMP_TO_DATE_FILLER_COUNT);
  assert.equal(
    history.fillerEventIds.at(-1),
    history.newestFillerEventId,
  );
  await client.record('ordered-events', {
    markerEventId: history.markerEventId,
    fillerCount: history.fillerEventIds.length,
    firstFillerEventId: history.fillerEventIds[0],
    newestFillerEventId: history.newestFillerEventId,
    markerBeforeEveryFiller: true,
    newestFillerSentLast: true,
  });

  await client.login(account);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: history.roomName }, 60_000);
  await client.tapCurrent('.channel', { text: history.roomName });
  const composer = await client.visible(
    '[data-testid="composer-input"]',
    {},
    30_000,
  );
  await recordAssertion(
    client,
    unique,
    records,
    assertions.roomReady,
    { visible: composer.visible, enabled: !composer.disabled },
  );

  const newest = await observeEventVisible(
    client,
    history.newestFillerEventId,
    history.newestFillerBody,
    'exact newest filler event in the initial timeline window',
    30_000,
  );
  await recordAssertion(
    client,
    unique,
    records,
    assertions.initialNewestVisible,
    {
      visible: newest.visible,
      eventIdMatches: newest.attributes['data-mid'] === history.newestFillerEventId,
      bodyMatches: newest.text.includes(history.newestFillerBody),
    },
  );

  const initialRows = await client.waitElements(
    '.scroll .msg',
    (candidates) =>
      eventRows(candidates, history.newestFillerEventId).length === 1 &&
      eventRows(candidates, history.markerEventId).length === 0,
    'newest filler loaded while the exact marker event is outside the initial window',
    {},
    30_000,
  );
  await recordAssertion(
    client,
    unique,
    records,
    assertions.initialMarkerAbsent,
    {
      markerEventMatches: eventRows(initialRows, history.markerEventId).length,
      newestEventMatches: eventRows(
        initialRows,
        history.newestFillerEventId,
      ).length,
    },
  );

  const expectedDate = await readDeviceLocalDate(device);
  let observer: JumpToDateNetworkObserver | undefined;
  let operationFailure: unknown;
  try {
    observer = await openJumpToDateNetworkObserver(
      client,
      account.homeserver,
      history.roomId,
      client.signal,
    );
    await client.tapCurrent('[data-testid="room-actions-overflow"]');
    await client.tapCurrent('[data-testid="overflow-jump-to-date"]');
    const input = await client.visible(
      '[data-testid="jump-to-date-input"]',
      {},
      10_000,
    );
    assert.equal(input.value, expectedDate);
    assert.equal(input.attributes['max'], expectedDate);
    await recordAssertion(
      client,
      unique,
      records,
      assertions.dialogCurrentDate,
      {
        visible: input.visible,
        enabled: !input.disabled,
        valueMatchesDeviceDate: input.value === expectedDate,
        maximumMatchesDeviceDate: input.attributes['max'] === expectedDate,
        usedExistingValue: true,
      },
    );

    await client.tapCurrent('[data-testid="jump-to-date-confirm"]');
    const lookup = await observer.waitForLookup();
    assert.equal(observer.matchCount, 1);
    await client.record('timestamp-to-event', {
      ...lookup,
      exactRoom: lookup.roomId === history.roomId,
      boundedObserver: true,
    });

    const marker = await observeEventVisible(
      client,
      history.markerEventId,
      history.markerBody,
      'exact arranged marker event rendered after timestamp lookup and backfill',
      60_000,
    );
    await recordAssertion(
      client,
      unique,
      records,
      assertions.resultMarkerVisible,
      {
        visible: marker.visible,
        eventIdMatches: marker.attributes['data-mid'] === history.markerEventId,
        bodyMatches: marker.text.includes(history.markerBody),
        initialMarkerMatches: 0,
        lookupRequestCount: observer.matchCount,
      },
    );
  } catch (error) {
    operationFailure = error;
  } finally {
    const failures: unknown[] = [];
    if (observer) {
      try {
        await observer.close();
      } catch (error) {
        failures.push(error);
      }
      try {
        assert.equal(observer.closed, true, 'Network observer closed');
      } catch (error) {
        failures.push(error);
      }
    }
    if (operationFailure !== undefined) failures.unshift(operationFailure);
    if (failures.length === 1) throw failures[0];
    if (failures.length) {
      throw new AggregateError(
        failures,
        'Jump-to-date stage and Network observer cleanup failed',
      );
    }
  }
}

const cases: readonly JumpToDateCase[] = [
  {
    id: 'history-backfill',
    source: `${JUMP_TO_DATE_SOURCES.applicable}; ${JUMP_TO_DATE_SOURCES.helper}; ${JUMP_TO_DATE_SOURCES.app}; ${JUMP_TO_DATE_SOURCES.account}`,
  },
];

assert.equal(cases.length, 1, 'Exactly one jump-to-date stage exists');
assert.equal(allAssertionIds.length, 5);
assert.equal(JUMP_TO_DATE_ASSERTION_RECORDS, 5);

void test(
  'Android jump-to-date journey',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'jump-to-date',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        const baseFixtures = createAccountFixtures(matrixResources, signal);
        const fixtures: typeof baseFixtures = {
          ...baseFixtures,
          account: async (...args) => {
            const account = await baseFixtures.account(...args);
            secrets[`PASSWORD_${account.username}`] = account.password;
            return account;
          },
        };
        matrixResources.cleanup('Scan jump-to-date diagnostics', () =>
          scanJumpToDateArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact jump-to-date diagnostics', () =>
          redactMaestroArtifacts(output, secrets, true),
        );

        const unique = new Set<JumpToDateAssertion>();
        const records = new Set<JumpToDateAssertion>();
        const stages: Array<{
          readonly id: JumpToDateCase['id'];
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: 5;
          assertionRecords: number;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: 1,
                expectedUniqueAssertions: 5,
                expectedAssertionRecords: 5,
                attempt: 1,
                retries: 0,
                applications: [APPLICATION_ID],
                sources: JUMP_TO_DATE_SOURCES,
                browserOnly: JUMP_TO_DATE_BROWSER_ONLY,
                fillerCount: JUMP_TO_DATE_FILLER_COUNT,
                stages,
              },
              null,
              2,
            )}\n`,
          );
        await save();

        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Jump-to-date Android device', () =>
          device.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
          APPLICATION_ID,
        );

        for (const entry of cases) {
          const directory = join(output, entry.id);
          await mkdir(directory, { recursive: true });
          const client = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            directory,
            signal,
            APPLICATION_ID,
          );
          const stage: (typeof stages)[number] = {
            id: entry.id,
            source: entry.source,
            status: 'running',
            durationMs: 0,
            artifact: `${entry.id}/**`,
            attempt: 1,
            retries: 0,
            expectedAssertionRecords: 5,
            assertionRecords: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[jump-to-date] ${entry.id} start`);
          try {
            await client.reset(PIXEL_5_ACCOUNT_PROFILE);
            await runJumpToDateStage({
              client,
              device,
              fixtures,
              secrets,
              unique,
              records,
            });
            stage.assertionRecords = records.size;
            assert.equal(stage.assertionRecords, 5);
            await client.capture('passed');
          } catch (error) {
            failures.push(error);
            try {
              await client.capture('failed');
            } catch (diagnosticError) {
              failures.push(diagnosticError);
            }
          } finally {
            try {
              await client.close();
            } catch (error) {
              failures.push(error);
            }
            try {
              await device.clearApplicationData(APPLICATION_ID);
            } catch (error) {
              failures.push(error);
            }
            stage.status = failures.length ? 'failed' : 'passed';
            stage.failureCount = failures.length;
            stage.durationMs = performance.now() - started;
            if (failures.length) {
              stage.error = failures.map(describeFailure).join('\n');
            }
            await save();
            console.info(
              `[jump-to-date] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Jump-to-date journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, 5);
        assert.equal(records.size, JUMP_TO_DATE_ASSERTION_RECORDS);
      },
    );
  },
);
