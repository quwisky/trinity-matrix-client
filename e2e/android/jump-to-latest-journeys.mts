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
  JUMP_TO_LATEST_ANDROID_REPLACEMENT,
  JUMP_TO_LATEST_ASSERTION_RECORDS,
  JUMP_TO_LATEST_BOTTOM_BOUND_PX,
  JUMP_TO_LATEST_MESSAGE_COUNT,
  JUMP_TO_LATEST_MIN_RANGE_PX,
  JUMP_TO_LATEST_SOURCES,
  jumpToLatestAssertions as assertions,
} from './jump-to-latest-contract.mts';
import {
  nativeStorageMethodDataIsRedacted,
  openMaestroDevice,
  redactMaestroArtifacts,
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
const allAssertionIds = Object.values(assertions);
type JumpToLatestAssertion = (typeof allAssertionIds)[number];

interface JumpToLatestCase {
  readonly id: 'jump-to-latest';
  readonly source: string;
}

interface TimelineGeometry {
  readonly visible: boolean;
  readonly scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
  readonly scrollableRange: number;
  readonly bottomDistance: number;
}

interface JumpToLatestStageContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: ReturnType<typeof createAccountFixtures>;
  readonly secrets: Record<string, string>;
  readonly unique: Set<JumpToLatestAssertion>;
  readonly records: Set<JumpToLatestAssertion>;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

function geometry(element: AccountElement): TimelineGeometry {
  return {
    visible: element.visible,
    scrollTop: element.scrollTop,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    scrollableRange: element.scrollHeight - element.clientHeight,
    bottomDistance:
      element.scrollHeight - element.scrollTop - element.clientHeight,
  };
}

async function waitForGeometry(
  client: AccountWorkspaceClient,
  accepts: (value: TimelineGeometry) => boolean,
  description: string,
): Promise<TimelineGeometry> {
  const rows = await client.waitElements(
    '.scroll',
    (elements) =>
      elements.length === 1 &&
      elements[0]!.visible &&
      accepts(geometry(elements[0]!)),
    description,
    {},
    30_000,
  );
  assert.equal(rows.length, 1);
  return geometry(rows[0]!);
}

async function pillIsHidden(
  client: AccountWorkspaceClient,
  selector: string,
): Promise<{ readonly matches: number; readonly visibleMatches: number }> {
  const elements = await client.waitElements(
    selector,
    (candidates) => candidates.every((candidate) => !candidate.visible),
    'jump-to-latest pill hidden',
  );
  return {
    matches: elements.length,
    visibleMatches: elements.filter((element) => element.visible).length,
  };
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  unique: Set<JumpToLatestAssertion>,
  records: Set<JumpToLatestAssertion>,
  identity: JumpToLatestAssertion,
  observation: unknown,
): Promise<void> {
  assert(!records.has(identity), `${identity} is recorded exactly once`);
  records.add(identity);
  unique.add(identity);
  await client.record(identity, { assertion: identity, observation });
}

async function scanJumpToLatestArtifacts(
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
      assert(entry.isFile(), `Jump-to-latest artifact is a file: ${path}`);
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
      assert(
        !/\bBearer\s+\S+/u.test(text),
        `Bearer token is absent from ${path}`,
      );
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

async function runJumpToLatestStage(
  context: JumpToLatestStageContext,
): Promise<void> {
  const { client, fixtures, secrets, unique, records } = context;
  const account: NodeWorkspaceAccount = await fixtures.account(
    'jump-to-latest-owner',
  );
  const roomName = `Latest ${account.username}`;
  const longBody = `lorem ipsum dolor sit amet `.repeat(18);
  const transactionPrefix = `latest-${account.username}`;
  secrets['SECRET_ROOM_NAME'] = roomName;
  secrets['SECRET_LONG_BODY'] = longBody;

  const history = await fixtures.createJumpToLatestHistory(
    account,
    roomName,
    longBody,
    transactionPrefix,
  );
  assert.equal(history.messageCount, JUMP_TO_LATEST_MESSAGE_COUNT);
  assert.equal(history.eventIds.length, JUMP_TO_LATEST_MESSAGE_COUNT);
  assert.equal(history.eventIds.at(-1), history.newestEventId);
  await client.record('ordered-events', {
    eventIds: history.eventIds,
    messageCount: history.messageCount,
    newestEventId: history.newestEventId,
    readMarkerEventId: history.newestEventId,
    sequentialSendCompletion: true,
  });

  await client.login(account);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: history.roomName }, 60_000);
  await client.tapCurrent('.channel', { text: history.roomName });
  const scrollSelector = '.scroll';
  const pillSelector = '[data-testid="jump-to-latest"]';

  const roomScroll = await client.visible(scrollSelector, {}, 30_000);
  await recordAssertion(client, unique, records, assertions.roomReady, {
    visible: roomScroll.visible,
  });
  const timeline = await client.visible(scrollSelector);
  await recordAssertion(client, unique, records, assertions.timelineVisible, {
    visible: timeline.visible,
  });

  const initial = await waitForGeometry(
    client,
    (value) => value.bottomDistance < JUMP_TO_LATEST_BOTTOM_BOUND_PX,
    'timeline settled at its bottom bound',
  );
  assert(initial.bottomDistance < JUMP_TO_LATEST_BOTTOM_BOUND_PX);
  await recordAssertion(
    client,
    unique,
    records,
    assertions.initialBottomSettled,
    initial,
  );

  const initialPill = await pillIsHidden(client, pillSelector);
  await recordAssertion(
    client,
    unique,
    records,
    assertions.initialPillHidden,
    initialPill,
  );

  assert(initial.scrollableRange > JUMP_TO_LATEST_MIN_RANGE_PX);
  await recordAssertion(
    client,
    unique,
    records,
    assertions.initialScrollableRange,
    initial,
  );

  const swipe = await client.swipeCurrent(scrollSelector, {
    direction: 'decrease-scroll-top',
    durationMs: 600,
  });
  const scrolled = await waitForGeometry(
    client,
    (value) =>
      value.scrollTop < initial.scrollTop &&
      value.bottomDistance > initial.bottomDistance,
    'native swipe moved the timeline away from its bottom',
  );
  assert(scrolled.scrollTop < initial.scrollTop);
  assert(scrolled.bottomDistance > initial.bottomDistance);
  const visiblePill = await client.visible(pillSelector, {}, 15_000);
  await client.record('timeline-swipe', {
    ...swipe,
    initial,
    scrolled,
  });
  await recordAssertion(
    client,
    unique,
    records,
    assertions.scrolledPillVisible,
    { visible: visiblePill.visible, initial, scrolled },
  );

  await client.tapCurrent(pillSelector);
  const result = await waitForGeometry(
    client,
    (value) => value.bottomDistance < JUMP_TO_LATEST_BOTTOM_BOUND_PX,
    'native jump-to-latest returned the timeline to its bottom bound',
  );
  assert(result.bottomDistance < JUMP_TO_LATEST_BOTTOM_BOUND_PX);
  const resultPill = await pillIsHidden(client, pillSelector);
  await recordAssertion(
    client,
    unique,
    records,
    assertions.resultPillHidden,
    { ...resultPill, geometry: result },
  );
}

const cases: readonly JumpToLatestCase[] = [
  {
    id: 'jump-to-latest',
    source: `${JUMP_TO_LATEST_SOURCES.definition}; ${JUMP_TO_LATEST_SOURCES.helper}; ${JUMP_TO_LATEST_SOURCES.setup}; ${JUMP_TO_LATEST_SOURCES.app}; ${JUMP_TO_LATEST_SOURCES.account}`,
  },
];

assert.equal(cases.length, 1, 'Exactly one jump-to-latest stage exists');
assert.equal(allAssertionIds.length, JUMP_TO_LATEST_ASSERTION_RECORDS);

void test(
  'Android jump-to-latest journey',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'jump-to-latest',
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
        matrixResources.cleanup('Scan jump-to-latest diagnostics', () =>
          scanJumpToLatestArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact jump-to-latest diagnostics', () =>
          redactMaestroArtifacts(output, secrets, true),
        );

        const unique = new Set<JumpToLatestAssertion>();
        const records = new Set<JumpToLatestAssertion>();
        const stages: Array<{
          readonly id: JumpToLatestCase['id'];
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: 7;
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
                expectedUniqueAssertions: 7,
                expectedAssertionRecords: 7,
                attempt: 1,
                retries: 0,
                applications: [APPLICATION_ID],
                sources: JUMP_TO_LATEST_SOURCES,
                androidReplacement: JUMP_TO_LATEST_ANDROID_REPLACEMENT,
                messageCount: JUMP_TO_LATEST_MESSAGE_COUNT,
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
        matrixResources.cleanup('Jump-to-latest Android device', () =>
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
            expectedAssertionRecords: 7,
            assertionRecords: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[jump-to-latest] ${entry.id} start`);
          try {
            await client.reset(PIXEL_5_ACCOUNT_PROFILE);
            await runJumpToLatestStage({
              client,
              fixtures,
              secrets,
              unique,
              records,
            });
            stage.assertionRecords = records.size;
            assert.equal(stage.assertionRecords, 7);
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
              `[jump-to-latest] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Jump-to-latest journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, 7);
        assert.equal(records.size, JUMP_TO_LATEST_ASSERTION_RECORDS);
      },
    );
  },
);
