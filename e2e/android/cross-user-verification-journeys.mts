import assert from 'node:assert/strict';
import {
  mkdir,
  readFile,
  readdir,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import type { DevtoolsEventConnection } from '../support/devtools-connection.mts';
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
  CROSS_USER_VERIFICATION_ASSERTION_RECORDS,
  CROSS_USER_VERIFICATION_SOURCES,
  crossUserVerificationAssertions as assertions,
  type CrossUserVerificationAssertion,
} from './cross-user-verification-contract.mts';
import {
  installCrossUserIdentityQueryDelay,
  type CrossUserIdentityQueryDelay,
} from './cross-user-verification-query-delay.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';
import { captureSecretSafe } from './recovery-reset-diagnostics.mts';

const PRIMARY_APPLICATION_ID = 'eu.qwky.trinity';
const SECONDARY_APPLICATION_ID = 'eu.qwky.trinity.secondary';
const textArtifactExtensions = new Set([
  '.json',
  '.jsonl',
  '.log',
  '.txt',
  '.xml',
  '.yaml',
]);
const imageArtifactExtensions = new Set(['.jpeg', '.jpg', '.png', '.webp']);
const allAssertionIds = [
  ...Object.values(assertions.shared),
  ...Object.values(assertions.delayed),
] as readonly CrossUserVerificationAssertion[];

type Fixtures = ReturnType<typeof createAccountFixtures>;

interface VerificationPageObservation {
  readonly visible: boolean;
  readonly stage: string | null;
}

interface CrossUserVerificationCase {
  readonly id: 'member-panel-verification' | 'delayed-counterpart-identity';
  readonly source: string;
  readonly delayIdentity: boolean;
  readonly expectedAssertionRecords: number;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

function oneVisible(elements: readonly AccountElement[]): boolean {
  return elements.length === 1 && elements[0]!.visible;
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  unique: Set<CrossUserVerificationAssertion>,
  records: Set<string>,
  identity: CrossUserVerificationAssertion,
  stageId: CrossUserVerificationCase['id'],
  observation: unknown,
): Promise<void> {
  const recordKey = `${identity}-${stageId}`;
  assert(!records.has(recordKey), `${recordKey} is recorded exactly once`);
  records.add(recordKey);
  unique.add(identity);
  await client.record(recordKey, {
    assertion: identity,
    stage: stageId,
    observation,
  });
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomName }, 60_000);
  await client.tapCurrent('.channel', { text: roomName });
  await client.visible('textarea.composer__input', {}, 30_000);
}

async function openSecuritySettings(
  client: AccountWorkspaceClient,
): Promise<void> {
  await client.tapCurrent('[data-testid="open-settings"]');
  await client.visible('[aria-label="Settings sections"]', {}, 30_000);
  await client.tapCurrent('[data-testid="settings-nav-security"]');
  await client.visible('[data-testid="security-settings"]', {}, 30_000);
}

async function answerPasswordUiaIfAsked(
  client: AccountWorkspaceClient,
  password: string,
): Promise<void> {
  const outcome = await waitForNativeShellState(
    async () => ({
      prompt: await client.elements('trn-alert-dialog h2', {
        exactText: 'Confirm your password',
      }),
      recovery: await client.elements('[data-testid="recovery-key"]'),
    }),
    ({ prompt, recovery }) => oneVisible(prompt) || oneVisible(recovery),
    'conditional cross-user encryption-setup password UIA',
    client.signal,
    60_000,
  );
  if (!oneVisible(outcome.prompt)) return;
  await client.tapCurrent('trn-alert-dialog input');
  await client.fillFocused('trn-alert-dialog input', password);
  await client.tapCurrent('[data-testid="alert-confirm"]');
  await client.visible('[data-testid="recovery-key"]', {}, 60_000);
}

async function establishRecovery(
  client: AccountWorkspaceClient,
  account: NodeWorkspaceAccount,
): Promise<void> {
  await openSecuritySettings(client);
  await client.visible('[data-testid="security-setup"]', {}, 30_000);
  await client.tapCurrent('[data-testid="security-setup"]');
  await waitForNativeShellState(
    () => client.surface(),
    (surface) => new URL(surface.url).pathname === '/encryption/setup',
    'native cross-user encryption setup route',
    client.signal,
    30_000,
  );
  await client.tapCurrent('button', { exactText: 'Set up encryption' });
  await answerPasswordUiaIfAsked(client, account.password);
  await client.visible('[data-testid="recovery-key"]', {}, 60_000);
  await client.tapCurrent(
    '[data-testid="recovery-key-saved"] input[role="checkbox"]',
  );
  await client.tapCurrent('button', { exactText: 'Continue to Trinity' });
  await client.activeAccountRooms(account);
}

async function activatePrimary(
  client: AccountWorkspaceClient,
  account: NodeWorkspaceAccount,
): Promise<void> {
  await client.device.launch();
  await client.activeAccountRooms(account);
}

async function observeVerificationPage(
  client: AccountWorkspaceClient,
): Promise<VerificationPageObservation> {
  const value = await evaluateNative(
    client.webview,
    `(() => {
      const element = document.querySelector('[data-testid="verify-page"]');
      if (!element) return { visible: false, stage: null };
      const rect = element.getBoundingClientRect();
      return {
        visible:
          rect.width > 0 && rect.height > 0 &&
          getComputedStyle(element).visibility === 'visible',
        stage: element.getAttribute('data-stage'),
      };
    })()`,
  );
  assert(value && typeof value === 'object');
  return value as VerificationPageObservation;
}

async function scanCrossUserVerificationArtifacts(
  output: string,
  secrets: Readonly<Record<string, string>>,
): Promise<void> {
  const values = [...new Set(Object.values(secrets).filter(Boolean))].sort(
    (left, right) => right.length - left.length,
  );
  async function scan(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await scan(path);
        continue;
      }
      assert(entry.isFile(), `Cross-user artifact is a file: ${path}`);
      if (!textArtifactExtensions.has(extname(path))) continue;
      const text = await readFile(path, 'utf8');
      for (const secret of values) {
        assert(!text.includes(secret), `Secret is absent from ${path}`);
      }
      assert(!/\bBearer\s+\S+/u.test(text), `Bearer token is absent from ${path}`);
      assert(
        !/\bsyt_[A-Za-z0-9._~-]+/u.test(text),
        `Matrix access token is absent from ${path}`,
      );
    }
  }
  await scan(output);
}

async function removeCrossUserVerificationMaestroImages(
  output: string,
): Promise<void> {
  async function remove(directory: string, insideFlow: boolean): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    const ownsFlow =
      insideFlow ||
      entries.some((entry) => entry.isFile() && entry.name === 'maestro.log');
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await remove(path, ownsFlow);
      } else if (
        ownsFlow &&
        entry.isFile() &&
        imageArtifactExtensions.has(extname(path))
      ) {
        await unlink(path);
      }
    }
  }
  await remove(output, false);
}

async function openCounterpartFromMembers(
  client: AccountWorkspaceClient,
  counterpartName: string,
  stageId: CrossUserVerificationCase['id'],
  unique: Set<CrossUserVerificationAssertion>,
  records: Set<string>,
): Promise<void> {
  const membersBefore = await client.elements('.chat-members');
  assert.equal(membersBefore.some((element) => element.visible), false);
  await recordAssertion(
    client,
    unique,
    records,
    assertions.shared.membersPanelInitiallyHidden,
    stageId,
    { visible: false },
  );

  const memberToggle = await client.elements('[data-testid="toggle-members"]');
  if (oneVisible(memberToggle)) {
    await client.tapCurrent('[data-testid="toggle-members"]');
  } else {
    await client.tapCurrent('[data-testid="room-actions-overflow"]');
    await client.tapCurrent('[data-testid="overflow-toggle-members"]');
  }
  const members = await client.visible('.chat-members', {}, 15_000);
  await recordAssertion(
    client,
    unique,
    records,
    assertions.shared.membersPanelVisible,
    stageId,
    { visible: members.visible },
  );

  const member = await client.visible(
    '[data-testid="member-row"]',
    { text: counterpartName },
    20_000,
  );
  await recordAssertion(
    client,
    unique,
    records,
    assertions.shared.counterpartMemberVisible,
    stageId,
    { exactCounterpartName: member.text.includes(counterpartName) },
  );
  await client.tapCurrent('[data-testid="member-row"]', {
    text: counterpartName,
  });
  const memberInfo = await client.visible('[data-testid="member-info"]', {}, 10_000);
  await client.visible('[data-testid="member-info-verify"]', {}, 10_000);
  await recordAssertion(
    client,
    unique,
    records,
    assertions.shared.memberInfoVisible,
    stageId,
    { visible: memberInfo.visible, exactCounterpartName: counterpartName },
  );
}

async function runVerificationStage(
  entry: CrossUserVerificationCase,
  context: {
    readonly primary: AccountWorkspaceClient;
    readonly secondary: AccountWorkspaceClient;
    readonly fixtures: Fixtures;
    readonly secrets: Record<string, string>;
    readonly unique: Set<CrossUserVerificationAssertion>;
    readonly records: Set<string>;
  },
): Promise<void> {
  const { primary, secondary, fixtures, secrets, unique, records } = context;
  const account = await fixtures.account(`cross-user-primary-${entry.id}`);
  const counterpart = await fixtures.account(
    `cross-user-counterpart-${entry.id}`,
  );
  const counterpartName = `Verification counterpart ${Date.now()}`;
  secrets.PRIMARY_PASSWORD = account.password;
  secrets.COUNTERPART_PASSWORD = counterpart.password;
  await fixtures.setDisplayName(counterpart, counterpartName);
  const room = await fixtures.createRoom(account, {
    name: `Verify ${Date.now()}`,
    preset: 'private_chat',
    invite: [counterpart.userId],
  });
  await fixtures.join(counterpart, room.id);

  await primary.login(account);
  await establishRecovery(primary, account);

  let delayConnection: DevtoolsEventConnection | undefined;
  let delayController: CrossUserIdentityQueryDelay | undefined;
  const stageFailures: unknown[] = [];
  try {
    if (entry.delayIdentity) {
      delayConnection = await primary.webview.openSession();
      delayController = await installCrossUserIdentityQueryDelay(delayConnection, {
        counterpartUserId: counterpart.userId,
        delayMs: 15_000,
        signal: primary.signal,
      });
    }
    await secondary.reset(PIXEL_5_ACCOUNT_PROFILE);
    await secondary.login(counterpart);
    await establishRecovery(secondary, counterpart);
    await activatePrimary(primary, account);
    await openRoom(primary, room.name);
    await openCounterpartFromMembers(
      primary,
      counterpartName,
      entry.id,
      unique,
      records,
    );

    await primary.tapCurrent('[data-testid="member-info-verify"]');
    delayController?.markVerificationStarted();
    const verification = await waitForNativeShellState(
      () => observeVerificationPage(primary),
      ({ visible, stage }) =>
        visible && (stage === 'requested' || stage === 'waiting'),
      'requested or waiting cross-user verification page',
      primary.signal,
      45_000,
    );
    await recordAssertion(
      primary,
      unique,
      records,
      assertions.shared.verificationPageVisible,
      entry.id,
      { visible: verification.visible, stage: verification.stage },
    );

    if (delayController) {
      assert(delayController.matchingRequests > 0);
      await recordAssertion(
        primary,
        unique,
        records,
        assertions.delayed.identityQueryObserved,
        entry.id,
        { matchingRequests: delayController.matchingRequests, delayMs: 15_000 },
      );
    }
  } catch (error) {
    stageFailures.push(error);
  } finally {
    if (delayController) {
      try {
        await delayController.close();
      } catch (error) {
        stageFailures.push(error);
      }
    }
    if (delayConnection) {
      try {
        delayConnection.close();
      } catch (error) {
        stageFailures.push(error);
      }
    }
  }
  if (stageFailures.length === 1) throw stageFailures[0];
  if (stageFailures.length) {
    throw new AggregateError(
      stageFailures,
      `Cross-user stage ${entry.id} cleanup failed`,
    );
  }
}

const cases: readonly CrossUserVerificationCase[] = [
  {
    id: 'member-panel-verification',
    source: `${CROSS_USER_VERIFICATION_SOURCES.ordinary}; ${CROSS_USER_VERIFICATION_SOURCES.helpers}; ${CROSS_USER_VERIFICATION_SOURCES.app}; ${CROSS_USER_VERIFICATION_SOURCES.account}`,
    delayIdentity: false,
    expectedAssertionRecords: 5,
  },
  {
    id: 'delayed-counterpart-identity',
    source: `${CROSS_USER_VERIFICATION_SOURCES.delayed}; ${CROSS_USER_VERIFICATION_SOURCES.helpers}; ${CROSS_USER_VERIFICATION_SOURCES.app}; ${CROSS_USER_VERIFICATION_SOURCES.account}`,
    delayIdentity: true,
    expectedAssertionRecords: 6,
  },
];

assert.equal(cases.length, 2, 'Exactly two cross-user verification stages exist');
assert.equal(allAssertionIds.length, 6);
assert.equal(CROSS_USER_VERIFICATION_ASSERTION_RECORDS, 11);

void test(
  'Android cross-user verification journeys',
  { timeout: 1_800_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'cross-user-verification',
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
        matrixResources.cleanup(
          'Scan cross-user verification diagnostics',
          () => scanCrossUserVerificationArtifacts(output, secrets),
        );
        matrixResources.cleanup(
          'Redact cross-user verification diagnostics',
          () => redactMaestroArtifacts(output, secrets),
        );
        matrixResources.cleanup(
          'Remove secret-bearing cross-user Maestro images',
          () => removeCrossUserVerificationMaestroImages(output),
        );

        const unique = new Set<CrossUserVerificationAssertion>();
        const records = new Set<string>();
        const stages: Array<{
          readonly id: CrossUserVerificationCase['id'];
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: number;
          assertionRecords: number;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: 2,
                expectedUniqueAssertions: 6,
                expectedAssertionRecords: 11,
                attempt: 1,
                retries: 0,
                applications: [
                  PRIMARY_APPLICATION_ID,
                  SECONDARY_APPLICATION_ID,
                ],
                sources: CROSS_USER_VERIFICATION_SOURCES,
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
        matrixResources.cleanup('Cross-user verification Android device', () =>
          device.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
          PRIMARY_APPLICATION_ID,
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/secondaryDebug/app-secondaryDebug.apk',
          ),
          SECONDARY_APPLICATION_ID,
        );

        for (const entry of cases) {
          const directory = join(output, entry.id);
          await mkdir(directory, { recursive: true });
          const primary = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            join(directory, 'primary'),
            signal,
            PRIMARY_APPLICATION_ID,
          );
          const secondary = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            join(directory, 'secondary'),
            signal,
            SECONDARY_APPLICATION_ID,
          );
          await mkdir(primary.output, { recursive: true });
          await mkdir(secondary.output, { recursive: true });
          const stage: (typeof stages)[number] = {
            id: entry.id,
            source: entry.source,
            status: 'running',
            durationMs: 0,
            artifact: `${entry.id}/**`,
            attempt: 1,
            retries: 0,
            expectedAssertionRecords: entry.expectedAssertionRecords,
            assertionRecords: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const recordsBefore = records.size;
          const failures: unknown[] = [];
          console.info(`[cross-user-verification] ${entry.id} start`);
          try {
            await primary.reset(PIXEL_5_ACCOUNT_PROFILE);
            await runVerificationStage(entry, {
              primary,
              secondary,
              fixtures,
              secrets,
              unique,
              records,
            });
            stage.assertionRecords = records.size - recordsBefore;
            assert.equal(
              stage.assertionRecords,
              entry.expectedAssertionRecords,
            );
            await primary.capture('passed');
          } catch (error) {
            failures.push(error);
            for (const [client, name] of [
              [primary, 'failed-primary'],
              [secondary, 'failed-secondary'],
            ] as const) {
              try {
                await captureSecretSafe(client, name);
              } catch (diagnosticError) {
                failures.push(diagnosticError);
              }
            }
          } finally {
            try {
              await primary.close();
            } catch (error) {
              failures.push(error);
            }
            try {
              await secondary.close();
            } catch (error) {
              failures.push(error);
            }
            for (const applicationId of [
              PRIMARY_APPLICATION_ID,
              SECONDARY_APPLICATION_ID,
            ] as const) {
              try {
                await device.clearApplicationData(applicationId);
              } catch (error) {
                failures.push(error);
              }
            }
            stage.status = failures.length ? 'failed' : 'passed';
            stage.failureCount = failures.length;
            stage.durationMs = performance.now() - started;
            if (failures.length) {
              stage.error = failures.map(describeFailure).join('\n');
            }
            await save();
            console.info(
              `[cross-user-verification] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Cross-user verification journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, 6);
        assert.equal(records.size, CROSS_USER_VERIFICATION_ASSERTION_RECORDS);
      },
    );
  },
);
