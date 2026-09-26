import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
import type { MatrixTestResources } from '../support/test-resources.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
} from './account-workspace-fixtures.mts';
import {
  HIDE_SYSTEM_MESSAGES_ASSERTION_RECORDS,
  HIDE_SYSTEM_MESSAGES_SOURCES,
  hideSystemMessagesAssertions as assertions,
  type HideSystemMessagesAssertion,
} from './hide-system-messages-contract.mts';
import {
  nativeStorageMethodDataIsRedacted,
  openMaestroDevice,
  redactMaestroArtifacts,
} from './maestro-session.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { readNativeTimelineMembershipPreference } from './timeline-membership-preference.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const MEMBERSHIP_KEY = 'trinity.timeline.show-membership';
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
) as readonly HideSystemMessagesAssertion[];

interface HideSystemMessagesCase {
  readonly id: 'membership-filter-persistence';
  readonly source: string;
}

interface HideSystemMessagesStageContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: ReturnType<typeof createAccountFixtures>;
  readonly resources: MatrixTestResources;
  readonly secrets: Record<string, string>;
  readonly unique: Set<HideSystemMessagesAssertion>;
  readonly records: Set<HideSystemMessagesAssertion>;
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
  unique: Set<HideSystemMessagesAssertion>,
  records: Set<HideSystemMessagesAssertion>,
  identity: HideSystemMessagesAssertion,
  observation: unknown,
): Promise<void> {
  assert(!records.has(identity), `${identity} is recorded exactly once`);
  records.add(identity);
  unique.add(identity);
  await client.record(identity, { assertion: identity, observation });
}

async function observeComposerReady(
  client: AccountWorkspaceClient,
  unique: Set<HideSystemMessagesAssertion>,
  records: Set<HideSystemMessagesAssertion>,
  identity: HideSystemMessagesAssertion,
): Promise<void> {
  const composer = await client.visible(
    '[data-testid="composer-input"]',
    {},
    30_000,
  );
  await recordAssertion(client, unique, records, identity, {
    visible: composer.visible,
    enabled: !composer.disabled,
  });
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
  readinessIdentity: HideSystemMessagesAssertion,
  unique: Set<HideSystemMessagesAssertion>,
  records: Set<HideSystemMessagesAssertion>,
): Promise<void> {
  const backToRooms = await client.elements('[data-testid="back-to-rooms"]');
  if (backToRooms.length === 1 && backToRooms[0]!.visible) {
    await client.tapCurrent('[data-testid="back-to-rooms"]');
  } else {
    await client.tapCurrent('[data-testid="rail-rooms"]');
  }
  await client.visible('.channel', { text: roomName }, 60_000);
  await client.tapCurrent('.channel', { text: roomName });
  await observeComposerReady(
    client,
    unique,
    records,
    readinessIdentity,
  );
}

async function observeExactVisible(
  client: AccountWorkspaceClient,
  unique: Set<HideSystemMessagesAssertion>,
  records: Set<HideSystemMessagesAssertion>,
  identity: HideSystemMessagesAssertion,
  selector: string,
  filter: { readonly text?: string; readonly exactText?: string },
): Promise<void> {
  const elements = await client.waitElements(
    selector,
    (candidates) => candidates.length === 1 && candidates[0]!.visible,
    identity,
    filter,
    30_000,
  );
  await recordAssertion(client, unique, records, identity, {
    count: elements.length,
    visible: elements[0]!.visible,
    exactMatch: true,
  });
}

async function observeExactAbsent(
  client: AccountWorkspaceClient,
  unique: Set<HideSystemMessagesAssertion>,
  records: Set<HideSystemMessagesAssertion>,
  identity: HideSystemMessagesAssertion,
  selector: string,
  exactText: string,
): Promise<void> {
  const elements = await client.waitElements(
    selector,
    (candidates) => candidates.length === 0,
    identity,
    { exactText },
    30_000,
  );
  await recordAssertion(client, unique, records, identity, {
    count: elements.length,
    exactMatch: true,
  });
}

async function pressNativeBack(client: AccountWorkspaceClient): Promise<void> {
  await client.device.runFlow(
    join(client.workspaceRoot, 'e2e/android/flows/native-shell-back.yaml'),
    { APP_ID: APPLICATION_ID },
  );
}

async function scanHideSystemMessagesArtifacts(
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
      assert(entry.isFile(), `Hide-system-messages artifact is a file: ${path}`);
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
      assert(
        !text.includes('<string name="trinity.timeline.show-membership">'),
        `Raw membership Preferences XML is absent from ${path}`,
      );
    }
  }
  await scan(output);
}

async function runHideSystemMessagesStage(
  context: HideSystemMessagesStageContext,
): Promise<void> {
  const { client, fixtures, resources, secrets, unique, records } = context;
  const host: NodeWorkspaceAccount = await fixtures.account(
    'hide-system-messages-host',
  );
  const joiner: NodeWorkspaceAccount = await fixtures.account(
    'hide-system-messages-joiner',
  );
  const suffix = resources.roomName('hide-system-messages');
  const roomName = `System ${suffix}`;
  const joinerName = `Joiner ${suffix}`;
  const body = `still here ${suffix}`;
  const transactionId = `hide-system-messages-${suffix}`;
  Object.assign(secrets, {
    SECRET_HOST_USERNAME: host.username,
    SECRET_HOST_USER_ID: host.userId,
    SECRET_JOINER_USERNAME: joiner.username,
    SECRET_JOINER_USER_ID: joiner.userId,
    SECRET_ROOM_NAME: roomName,
    SECRET_JOINER_NAME: joinerName,
    SECRET_MESSAGE_BODY: body,
    SECRET_TRANSACTION_ID: transactionId,
  });

  await fixtures.setDisplayName(joiner, joinerName);
  const room = await fixtures.createRoom(host, {
    name: roomName,
    preset: 'private_chat',
    invite: [joiner.userId],
  });
  await fixtures.join(joiner, room.id);
  await fixtures.sendMessage(joiner, room.id, body, transactionId);

  await client.login(host);
  await openRoom(
    client,
    room.name,
    assertions.initialRoomReady,
    unique,
    records,
  );
  const joinLine = `${joinerName} joined the room`;
  await observeExactVisible(
    client,
    unique,
    records,
    assertions.initialJoinVisible,
    '[data-testid="timeline-event"]',
    { exactText: joinLine },
  );
  await observeExactVisible(
    client,
    unique,
    records,
    assertions.initialMessageVisible,
    'trn-message-row .msg__text',
    { exactText: body },
  );

  const defaultPreference =
    await readNativeTimelineMembershipPreference(client, true);
  assert.equal(defaultPreference.preferenceKeyPresent, false);
  assert.equal(defaultPreference.effectiveValue, true);
  await client.record('native-preference-default', {
    key: MEMBERSHIP_KEY,
    ...defaultPreference,
  });

  await client.tapCurrent('[data-testid="back-to-rooms"]');
  await client.activeAccountRooms(host);
  const roomsSurface = await waitForNativeShellState(
    () => client.surface(),
    (surface) => {
      const url = new URL(surface.url);
      return url.pathname.startsWith('/rooms') && url.searchParams.has('account');
    },
    assertions.settingsRoomsRouteReady,
    client.signal,
    30_000,
  );
  await recordAssertion(
    client,
    unique,
    records,
    assertions.settingsRoomsRouteReady,
    {
      pathname: new URL(roomsSurface.url).pathname,
      accountQualified: new URL(roomsSurface.url).searchParams.has('account'),
    },
  );
  await client.tapCurrent('[data-testid="open-settings"]');
  const settingsNavigation = await client.visible(
    'nav[aria-label="Settings sections"]',
    {},
    30_000,
  );
  await recordAssertion(
    client,
    unique,
    records,
    assertions.settingsSectionsVisible,
    { visible: settingsNavigation.visible },
  );
  await client.tapCurrent('[data-testid="settings-nav-appearance"]');
  const settingsDetail = await client.visible(
    '[data-testid="settings-detail"]',
    {},
    30_000,
  );
  await recordAssertion(
    client,
    unique,
    records,
    assertions.settingsDetailReady,
    { visible: settingsDetail.visible, hasContent: settingsDetail.text.length > 0 },
  );
  await client.scrollIntoViewIfNeeded(
    '[data-testid="timeline-show-membership"] trn-switch',
    '[data-testid="settings-detail"]',
  );
  const toggle = await client.waitElements(
    '[data-testid="timeline-show-membership"] trn-switch input',
    (elements) =>
      elements.length === 1 &&
      elements[0]!.visible &&
      !elements[0]!.disabled &&
      elements[0]!.attributes['aria-checked'] === 'true',
    assertions.settingsToggleVisible,
    {},
    30_000,
  );
  await recordAssertion(
    client,
    unique,
    records,
    assertions.settingsToggleVisible,
    {
      visible: toggle[0]!.visible,
      enabled: !toggle[0]!.disabled,
      checked: toggle[0]!.attributes['aria-checked'] === 'true',
      defaultPreference,
    },
  );
  await client.tapCurrent('[data-testid="timeline-show-membership"] trn-switch');
  await client.waitElements(
    '[data-testid="timeline-show-membership"] trn-switch input',
    (elements) =>
      elements.length === 1 &&
      elements[0]!.attributes['aria-checked'] === 'false',
    'membership switch unchecked after native tap',
    {},
    15_000,
  );
  const persistedPreference =
    await readNativeTimelineMembershipPreference(client, false);
  assert.equal(persistedPreference.preferenceKeyPresent, true);
  assert.equal(persistedPreference.effectiveValue, false);
  await client.record('native-preference-persisted', {
    key: MEMBERSHIP_KEY,
    ...persistedPreference,
  });

  await pressNativeBack(client);
  await client.visible('[data-testid="settings-nav-appearance"]', {}, 30_000);
  await pressNativeBack(client);
  await client.rooms(host);
  await openRoom(
    client,
    room.name,
    assertions.filteredRoomReady,
    unique,
    records,
  );
  await observeExactVisible(
    client,
    unique,
    records,
    assertions.filteredMessageVisible,
    'trn-message-row .msg__text',
    { exactText: body },
  );
  await observeExactAbsent(
    client,
    unique,
    records,
    assertions.filteredJoinAbsent,
    '[data-testid="timeline-event"]',
    joinLine,
  );

  await client.relaunch(PIXEL_5_ACCOUNT_PROFILE);
  await client.activeAccountRooms(host);
  const relaunchedPreference =
    await readNativeTimelineMembershipPreference(client, false);
  assert.equal(relaunchedPreference.preferenceKeyPresent, true);
  assert.equal(relaunchedPreference.effectiveValue, false);
  await client.record('native-preference-after-relaunch', {
    key: MEMBERSHIP_KEY,
    ...relaunchedPreference,
  });
  await openRoom(
    client,
    room.name,
    assertions.relaunchRoomReady,
    unique,
    records,
  );
  await observeExactVisible(
    client,
    unique,
    records,
    assertions.relaunchMessageVisible,
    'trn-message-row .msg__text',
    { exactText: body },
  );
  await observeExactAbsent(
    client,
    unique,
    records,
    assertions.relaunchJoinAbsent,
    '[data-testid="timeline-event"]',
    joinLine,
  );
}

const cases: readonly HideSystemMessagesCase[] = [
  {
    id: 'membership-filter-persistence',
    source: `${HIDE_SYSTEM_MESSAGES_SOURCES.definition}; ${HIDE_SYSTEM_MESSAGES_SOURCES.helpers}; ${HIDE_SYSTEM_MESSAGES_SOURCES.navigation}; ${HIDE_SYSTEM_MESSAGES_SOURCES.app}; ${HIDE_SYSTEM_MESSAGES_SOURCES.account}`,
  },
];

assert.equal(cases.length, 1, 'Exactly one hide-system-messages stage exists');
assert.equal(allAssertionIds.length, 13);
assert.equal(HIDE_SYSTEM_MESSAGES_ASSERTION_RECORDS, 13);

void test(
  'Android hide-system-messages journey',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'hide-system-messages',
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
        matrixResources.cleanup('Scan hide-system-messages diagnostics', () =>
          scanHideSystemMessagesArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact hide-system-messages diagnostics', () =>
          redactMaestroArtifacts(output, secrets, true),
        );

        const unique = new Set<HideSystemMessagesAssertion>();
        const records = new Set<HideSystemMessagesAssertion>();
        const stages: Array<{
          readonly id: HideSystemMessagesCase['id'];
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: 13;
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
                expectedUniqueAssertions: 13,
                expectedAssertionRecords: 13,
                attempt: 1,
                retries: 0,
                applications: [APPLICATION_ID],
                sources: HIDE_SYSTEM_MESSAGES_SOURCES,
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
        matrixResources.cleanup('Hide-system-messages Android device', () =>
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
            expectedAssertionRecords: 13,
            assertionRecords: 0,
          };
          stages.push(stage);
          await save();
          const started = performance.now();
          const failures: unknown[] = [];
          console.info(`[hide-system-messages] ${entry.id} start`);
          try {
            await client.reset(PIXEL_5_ACCOUNT_PROFILE);
            await runHideSystemMessagesStage({
              client,
              fixtures,
              resources: matrixResources,
              secrets,
              unique,
              records,
            });
            stage.assertionRecords = records.size;
            assert.equal(stage.assertionRecords, 13);
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
              `[hide-system-messages] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Hide-system-messages journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, 13);
        assert.equal(records.size, HIDE_SYSTEM_MESSAGES_ASSERTION_RECORDS);
      },
    );
  },
);
