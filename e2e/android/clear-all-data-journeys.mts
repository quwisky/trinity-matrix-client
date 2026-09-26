import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountWorkspaceCase,
  type AccountWorkspaceCaseContext,
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import {
  CLEAR_ALL_DATA_HOVER_EXCLUSION,
  CLEAR_ALL_DATA_SOURCES,
  clearAllDataAssertions as assertions,
  type ClearAllDataAssertion,
} from './clear-all-data-contract.mts';
import {
  AA_NORMAL_TEXT,
  observeVisual,
  seedPreference,
  snapshot,
  waitForRestartedEmptyState,
  type ClearAllDataSnapshot,
} from './clear-all-data-observer.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

const MISTYPED_MESSAGE =
  'Nothing was erased. Type RESET TRINITY exactly to confirm.';
const DEAD_PUSH_GATEWAY = 'https://dead.example/_matrix/push/v1/notify';

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function recordAssertion(
  client: AccountWorkspaceClient,
  recorded: Set<ClearAllDataAssertion>,
  identity: ClearAllDataAssertion,
  observation: unknown,
): Promise<void> {
  assert(!recorded.has(identity), `${identity} is recorded exactly once`);
  recorded.add(identity);
  await client.record(identity, { assertion: identity, observation });
}

async function waitForSnapshot(
  client: AccountWorkspaceClient,
  accepts: (value: ClearAllDataSnapshot) => boolean,
  description: string,
): Promise<ClearAllDataSnapshot> {
  return waitForNativeShellState(
    () => snapshot(client),
    accepts,
    description,
    client.signal,
    30_000,
  );
}

async function confirmErase(
  client: AccountWorkspaceClient,
  confirmation: string,
  replacesDocument = false,
): Promise<void> {
  await client.visible('trn-alert-dialog', {
    text: 'Erase all Trinity data',
  });
  await client.fillFocused('trn-alert-dialog input', confirmation);
  if (!replacesDocument) {
    await client.tapCurrent('[data-testid="alert-confirm"]');
  } else {
    const immediatelyBefore = await snapshot(client);
    await client.tapCurrentReplacingDocument(
      '[data-testid="alert-confirm"]',
      immediatelyBefore.documentTimeOrigin,
    );
  }
}

async function signedInWipe(
  context: AccountWorkspaceCaseContext,
  recorded: Set<ClearAllDataAssertion>,
): Promise<void> {
  const { client, fixtures } = context;
  const account = await fixtures.account('clear-all-data-signed-in');
  await client.login(account);

  const before = await waitForSnapshot(
    client,
    (value) =>
      value.preferenceKeys.includes('matrix.accounts') &&
      value.databases.some((name) =>
        name.startsWith('matrix-js-sdk:trinity-sync:@'),
      ) &&
      value.databases.some((name) => name.endsWith('::matrix-sdk-crypto')),
    'non-vacuous signed-in native preferences and Matrix databases',
  );

  await recordAssertion(
    client,
    recorded,
    assertions.signedInSecureTokenWebviewExclusion,
    {
      platform: 'android',
      authoritativeSecureStorage: 'native',
      webviewStorageClaimed: false,
    },
  );
  assert(before.preferenceKeys.includes('matrix.accounts'));
  await recordAssertion(
    client,
    recorded,
    assertions.signedInNativeAccountPreferencePresent,
    { present: true, key: 'matrix.accounts' },
  );
  const syncDatabases = before.databases.filter((name) =>
    name.startsWith('matrix-js-sdk:trinity-sync:@'),
  );
  assert(syncDatabases.length > 0, 'Signed-in sync database exists');
  await recordAssertion(
    client,
    recorded,
    assertions.signedInSyncDatabasePresent,
    { present: true, count: syncDatabases.length },
  );
  const cryptoDatabases = before.databases.filter((name) =>
    name.endsWith('::matrix-sdk-crypto'),
  );
  assert(cryptoDatabases.length > 0, 'Signed-in crypto database exists');
  await recordAssertion(
    client,
    recorded,
    assertions.signedInCryptoDatabasePresent,
    { present: true, count: cryptoDatabases.length },
  );

  await client.openMenu();
  await client.tap('[data-testid="add-account"]');
  const escapeHatch = await client.visible(
    '[data-testid="clear-all-data"]',
  );
  const addSurface = await client.surface();
  const addUrl = new URL(addSurface.url);
  assert.equal(addUrl.pathname, '/login');
  assert.equal(addUrl.searchParams.has('add'), true);
  await recordAssertion(
    client,
    recorded,
    assertions.signedInEscapeHatchVisible,
    {
      visible: escapeHatch.visible,
      pathname: addUrl.pathname,
      addMode: addUrl.searchParams.has('add'),
    },
  );

  await client.tapCurrent('[data-testid="clear-all-data"]');
  await confirmErase(client, 'yes please');
  const feedback = await client.waitElements(
    '[role="alert"]',
    (elements) =>
      elements.length === 1 &&
      elements[0]!.visible &&
      elements[0]!.text === MISTYPED_MESSAGE,
    'exact clear-all-data mistype feedback',
    {},
    20_000,
  );
  assert.equal(feedback[0]!.text, MISTYPED_MESSAGE);
  await recordAssertion(
    client,
    recorded,
    assertions.signedInMistypeFeedback,
    { exact: feedback[0]!.text },
  );

  const afterMistype = await snapshot(client);
  const preferencesPreserved = before.preferenceKeys.every((key) =>
    afterMistype.preferenceKeys.includes(key),
  );
  const databasesPreserved = before.databases.every((name) =>
    afterMistype.databases.includes(name),
  );
  assert(preferencesPreserved, 'Mistyped confirmation preserves preferences');
  assert(databasesPreserved, 'Mistyped confirmation preserves databases');
  assert.equal(
    afterMistype.documentTimeOrigin,
    before.documentTimeOrigin,
    'Mistyped confirmation preserves the current document',
  );
  await recordAssertion(
    client,
    recorded,
    assertions.signedInMistypePreservesState,
    {
      preferencesPreserved,
      databasesPreserved,
      documentPreserved: true,
    },
  );

  await client.tapCurrent('[data-testid="clear-all-data"]');
  await confirmErase(client, 'reset trinity', true);
  const after = await waitForRestartedEmptyState(
    client,
    before.databases,
    before.documentTimeOrigin,
  );
  assert.equal(after.preferenceKeys.length, 0);
  await recordAssertion(
    client,
    recorded,
    assertions.signedInNativePreferencesEmpty,
    { keys: after.preferenceKeys, documentRestarted: true },
  );
  await recordAssertion(
    client,
    recorded,
    assertions.signedInDatabaseEnumerationReady,
    {
      enumerationReady: true,
      documentRestarted:
        after.documentTimeOrigin !== before.documentTimeOrigin,
      count: after.databases.length,
    },
  );
  const databasesRemoved = before.databases.every(
    (name) => !after.databases.includes(name),
  );
  assert(databasesRemoved, 'Every observed signed-in database is removed');
  await recordAssertion(
    client,
    recorded,
    assertions.signedInDatabasesRemoved,
    { databasesRemoved, observedBefore: before.databases.length },
  );
  const homeserver = await client.visible('#homeserver', {}, 20_000);
  const signedOutSurface = await client.surface();
  assert.equal(new URL(signedOutSurface.url).pathname, '/login');
  await recordAssertion(
    client,
    recorded,
    assertions.signedInSignedOutSurfaceVisible,
    {
      homeserverVisible: homeserver.visible,
      pathname: new URL(signedOutSurface.url).pathname,
    },
  );
}

async function signedOutWipe(
  context: AccountWorkspaceCaseContext,
  recorded: Set<ClearAllDataAssertion>,
): Promise<void> {
  const { client } = context;
  const initial = await snapshot(client);
  await seedPreference(client, 'trinity.push.gateway', DEAD_PUSH_GATEWAY);
  const before = await waitForSnapshot(
    client,
    (value) => value.preferenceKeys.includes('trinity.push.gateway'),
    'dead push gateway persisted in native preferences',
  );
  await recordAssertion(
    client,
    recorded,
    assertions.signedOutDeadPushPreferencePresent,
    { present: true, key: 'trinity.push.gateway' },
  );

  await client.tapCurrent('[data-testid="clear-all-data"]');
  await confirmErase(client, 'RESET TRINITY', true);
  const after = await waitForRestartedEmptyState(
    client,
    before.databases,
    initial.documentTimeOrigin,
  );
  const homeserver = await client.visible('#homeserver', {}, 20_000);
  const surface = await client.surface();
  assert.equal(after.preferenceKeys.length, 0);
  assert.equal(new URL(surface.url).pathname, '/login');
  await recordAssertion(
    client,
    recorded,
    assertions.signedOutNativePreferencesEmpty,
    {
      keys: after.preferenceKeys,
      documentRestarted:
        after.documentTimeOrigin !== initial.documentTimeOrigin,
      homeserverVisible: homeserver.visible,
    },
  );
}

interface VisualStage {
  readonly theme: 'trinity' | 'amethyst';
  readonly mode: 'light' | 'dark';
  readonly applied: ClearAllDataAssertion;
  readonly dangerToken: ClearAllDataAssertion;
  readonly aaContrast: ClearAllDataAssertion;
}

async function visualStage(
  context: AccountWorkspaceCaseContext,
  recorded: Set<ClearAllDataAssertion>,
  stage: VisualStage,
): Promise<void> {
  const { client } = context;
  await seedPreference(client, 'trinity.appearance.mode', stage.mode);
  await seedPreference(client, 'trinity.appearance.theme', stage.theme);
  await client.reload();
  await client.visible('[data-testid="clear-all-data"]', {}, 20_000);
  const observation = await observeVisual(client);
  const expectedTheme = stage.theme === 'trinity' ? null : 'amethyst';
  assert.deepEqual(observation.applied, {
    dark: stage.mode === 'dark',
    theme: expectedTheme,
  });
  assert.deepEqual(observation.media, {
    hoverNone: true,
    coarsePointer: true,
  });
  await recordAssertion(client, recorded, stage.applied, {
    ...observation.applied,
    media: observation.media,
    hoverExclusion: CLEAR_ALL_DATA_HOVER_EXCLUSION,
  });
  assert.deepEqual(
    observation.text,
    observation.danger,
    `${stage.theme}/${stage.mode}: rendered text is the danger token`,
  );
  await recordAssertion(client, recorded, stage.dangerToken, {
    text: observation.text,
    danger: observation.danger,
    equal: true,
  });
  assert(
    observation.ratio >= AA_NORMAL_TEXT,
    `${stage.theme}/${stage.mode}: ${observation.ratio.toFixed(2)}:1`,
  );
  await recordAssertion(client, recorded, stage.aaContrast, {
    ratio: observation.ratio,
    minimum: AA_NORMAL_TEXT,
    layers: observation.layers,
  });
}

const visualStages: readonly VisualStage[] = [
  {
    theme: 'trinity',
    mode: 'light',
    applied: assertions.trinityLightApplied,
    dangerToken: assertions.trinityLightDangerToken,
    aaContrast: assertions.trinityLightAaContrast,
  },
  {
    theme: 'trinity',
    mode: 'dark',
    applied: assertions.trinityDarkApplied,
    dangerToken: assertions.trinityDarkDangerToken,
    aaContrast: assertions.trinityDarkAaContrast,
  },
  {
    theme: 'amethyst',
    mode: 'light',
    applied: assertions.amethystLightApplied,
    dangerToken: assertions.amethystLightDangerToken,
    aaContrast: assertions.amethystLightAaContrast,
  },
  {
    theme: 'amethyst',
    mode: 'dark',
    applied: assertions.amethystDarkApplied,
    dangerToken: assertions.amethystDarkDangerToken,
    aaContrast: assertions.amethystDarkAaContrast,
  },
];

const recorded = new Set<ClearAllDataAssertion>();
const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'signed-in-wipe',
    source: CLEAR_ALL_DATA_SOURCES.signedIn,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    run: (context) => signedInWipe(context, recorded),
  },
  {
    id: 'signed-out-wedged-preference-wipe',
    source: CLEAR_ALL_DATA_SOURCES.signedOut,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    run: (context) => signedOutWipe(context, recorded),
  },
  ...visualStages.map(
    (stage): AccountWorkspaceCase => ({
      id: `visual-${stage.theme}-${stage.mode}`,
      source: CLEAR_ALL_DATA_SOURCES.visual,
      profile: PIXEL_5_ACCOUNT_PROFILE,
      run: (context) => visualStage(context, recorded, stage),
    }),
  ),
];

assert.equal(cases.length, 6, 'Exactly six clear-all-data stages are required');
assert.equal(
  Object.keys(assertions).length,
  25,
  'Exactly 25 clear-all-data assertions are required',
);

void test(
  'Android clear-all-data journeys',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        recorded.clear();
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'clear-all-data',
        );
        await mkdir(output, { recursive: true });
        const secrets: Record<string, string> = {};
        const baseFixtures = createAccountFixtures(matrixResources, signal);
        const fixtures: typeof baseFixtures = {
          ...baseFixtures,
          account: async (...args) => {
            const account = await baseFixtures.account(...args);
            secrets.ACCOUNT_PASSWORD = account.password;
            return account;
          },
        };
        matrixResources.cleanup('Redact clear-all-data diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const stages: Array<{
          readonly id: string;
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: 6,
                expectedAssertions: 25,
                recordedAssertions: [...recorded],
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
        matrixResources.cleanup('Clear-all-data Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup('Clear-all-data Android WebView', async () =>
          client?.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
        );

        for (const entry of cases) {
          const directory = join(output, entry.id);
          await mkdir(directory, { recursive: true });
          client = new AccountWorkspaceClient(
            device,
            session.workspaceRoot,
            directory,
            signal,
          );
          const stage: (typeof stages)[number] = {
            id: entry.id,
            source: entry.source,
            status: 'running',
            durationMs: 0,
            artifact: `${entry.id}/*`,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[clear-all-data] ${entry.id} start`);
          try {
            await client.reset(entry.profile ?? PIXEL_5_ACCOUNT_PROFILE);
            await entry.run({
              client,
              fixtures,
              resources: matrixResources,
              signal,
            });
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
            stage.status = failures.length ? 'failed' : 'passed';
            stage.failureCount = failures.length;
            stage.durationMs = performance.now() - started;
            if (failures.length) {
              stage.error = failures.map(describeFailure).join('\n');
            }
            try {
              await save();
            } catch (error) {
              failures.push(error);
            }
            console.info(
              `[clear-all-data] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Clear-all-data journey ${entry.id} failed`,
            );
          }
        }

        assert.deepEqual(
          [...recorded].sort(),
          [...Object.values(assertions)].sort(),
          'Every clear-all-data identity is recorded exactly once',
        );
        await save();
      },
    );
  },
);
