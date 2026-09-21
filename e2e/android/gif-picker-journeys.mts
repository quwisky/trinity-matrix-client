import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
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
  type WorkspaceImageEvent,
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import {
  GIF_PICKER_ASSERTION_RECORDS,
  GIF_PICKER_SOURCES,
  gifPickerAssertions as assertions,
  gifPickerStageAssertions,
  type GifPickerAssertion,
} from './gif-picker-contract.mts';
import {
  createGifProviderFixture,
  type GifProviderFixture,
} from './gif-provider-fixture.mts';
import {
  readNativeGifPreference,
  seedNativeGifPreference,
  type GifConfig,
  type NativeGifPreferenceObservation,
} from './gif-native-preference.mts';
import {
  nativeStorageMethodDataIsRedacted,
  openMaestroDevice,
  redactMaestroArtifacts,
} from './maestro-session.mts';

const APPLICATION_ID = 'eu.qwky.trinity';
const COMPOSER = '[data-testid="composer-input"]';
const READY_MEDIA =
  '[data-testid="media-bubble"][data-media-state="ready"]';
const KLIPY_CONFIG = { provider: 'klipy', apiKey: 'e2e-key' } as const;
const textArtifactExtensions = new Set([
  '.json',
  '.jsonl',
  '.log',
  '.txt',
  '.xml',
  '.yaml',
]);
const imageArtifactExtensions = new Set(['.jpeg', '.jpg', '.png', '.webp']);
const allAssertionIds = Object.values(assertions) as readonly GifPickerAssertion[];

type GifPickerCaseId =
  | 'settings-lifecycle'
  | 'unconfigured-tray'
  | 'send-image'
  | 'active-account-send';
type Fixtures = ReturnType<typeof createAccountFixtures>;
type ExpectedAssertionRecords = 10 | 4 | 3 | 7;

interface GifPickerStageContext {
  readonly client: AccountWorkspaceClient;
  readonly fixtures: Fixtures;
  readonly resources: MatrixTestResources;
  readonly signal: AbortSignal;
  readonly secrets: Record<string, string>;
  readonly unique: Set<GifPickerAssertion>;
  readonly records: Set<GifPickerAssertion>;
  readonly stageRecords: Set<GifPickerAssertion>;
}

interface GifPickerCase {
  readonly id: GifPickerCaseId;
  readonly source: string;
  readonly expectedAssertionRecords: ExpectedAssertionRecords;
  run(context: GifPickerStageContext): Promise<void>;
}

interface GifRoomFixture {
  readonly account: NodeWorkspaceAccount;
  readonly room: WorkspaceRoom;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function recordAssertion(
  context: GifPickerStageContext,
  identity: GifPickerAssertion,
  observation: unknown,
): Promise<void> {
  assert(!context.records.has(identity), `${identity} is recorded exactly once`);
  context.records.add(identity);
  context.stageRecords.add(identity);
  context.unique.add(identity);
  await context.client.record(identity, { assertion: identity, observation });
}

async function scanGifPickerArtifacts(
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
      assert(entry.isFile(), `GIF picker artifact is a file: ${path}`);
      const extension = extname(path);
      assert(
        !imageArtifactExtensions.has(extension),
        `GIF picker raster diagnostics are removed: ${path}`,
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
        nativeStorageMethodDataIsRedacted(text, 'Preferences'),
        `Preferences method data is redacted in ${path}`,
      );
      assert(
        nativeStorageMethodDataIsRedacted(text, 'SecureStorage'),
        `SecureStorage method data is redacted in ${path}`,
      );
    }
  }
  await scan(output);
}

function trackAccountSecrets(
  context: GifPickerStageContext,
  prefix: string,
  account: NodeWorkspaceAccount,
): void {
  Object.assign(context.secrets, {
    [`SECRET_${prefix}_USERNAME`]: account.username,
    [`SECRET_${prefix}_PASSWORD`]: account.password,
    [`SECRET_${prefix}_USER_ID`]: account.userId,
  });
}

async function createRoomFixture(
  context: GifPickerStageContext,
  tag: string,
): Promise<GifRoomFixture> {
  const account = await context.fixtures.account(`gif-${tag}`);
  const roomName = `GIF ${context.resources.roomName(`${tag}-room`)}`;
  const room = await context.fixtures.createRoom(account, {
    name: roomName,
    preset: 'private_chat',
  });
  trackAccountSecrets(context, tag.replaceAll('-', '_').toUpperCase(), account);
  context.secrets[`SECRET_${tag.replaceAll('-', '_').toUpperCase()}_ROOM`] =
    roomName;
  context.secrets[`SECRET_${tag.replaceAll('-', '_').toUpperCase()}_ROOM_ID`] =
    room.id;
  return { account, room };
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomName }, 60_000);
  await client.tapCurrent('.channel', { text: roomName });
  await client.visible(COMPOSER, {}, 60_000);
}

async function openGifSettings(client: AccountWorkspaceClient): Promise<void> {
  await client.tapCurrent('[data-testid="open-settings"]');
  await client.visible('[aria-label="Settings sections"]', {}, 30_000);
  await client.scrollIntoViewIfNeeded(
    '[data-testid="settings-nav-gifs"]',
    '[aria-label="Settings sections"]',
  );
  await client.tapCurrent('[data-testid="settings-nav-gifs"]');
  await client.visible('[data-testid="settings-detail"]', {}, 30_000);
  const surface = await client.surface();
  assert.equal(new URL(surface.url).pathname, '/settings/gifs');
}

async function pressNativeBack(client: AccountWorkspaceClient): Promise<void> {
  await client.device.runFlow(
    join(client.workspaceRoot, 'e2e/android/flows/native-shell-back.yaml'),
    { APP_ID: APPLICATION_ID },
  );
}

async function waitForNativePreference(
  client: AccountWorkspaceClient,
  expected: GifConfig,
  accepts: (value: NativeGifPreferenceObservation) => boolean,
): Promise<NativeGifPreferenceObservation> {
  const deadline = performance.now() + 20_000;
  do {
    const observation = await readNativeGifPreference(
      client,
      expected.provider,
      expected.apiKey,
    );
    if (accepts(observation)) return observation;
    await delay(250, undefined, { signal: client.signal });
  } while (performance.now() < deadline);
  throw new Error('Native GIF preference did not reach the expected state');
}

async function prepareConfiguredClient(
  context: GifPickerStageContext,
  config: GifConfig,
): Promise<NativeGifPreferenceObservation> {
  const { client } = context;
  await client.close();
  await client.device.clearApplicationData(APPLICATION_ID);
  await client.device.adb(
    'shell',
    'pm',
    'grant',
    APPLICATION_ID,
    'android.permission.POST_NOTIFICATIONS',
  );
  await seedNativeGifPreference(client.device, APPLICATION_ID, config);
  await client.relaunch(PIXEL_5_ACCOUNT_PROFILE);
  const observation = await readNativeGifPreference(
    client,
    config.provider,
    config.apiKey,
  );
  assert.deepEqual(observation, {
    present: true,
    providerMatches: true,
    apiKeyMatches: true,
    apiKeyLength: config.apiKey.length,
  });
  await client.record('native-gif-preference', observation);
  return observation;
}

async function withGifProvider(
  context: GifPickerStageContext,
  run: (provider: GifProviderFixture) => Promise<void>,
): Promise<void> {
  const provider = await createGifProviderFixture(context.client.webview);
  const failures: unknown[] = [];
  try {
    await run(provider);
  } catch (error) {
    failures.push(error);
  }
  try {
    await provider.close();
  } catch (error) {
    failures.push(error);
  }
  try {
    await context.client.record('gif-provider-requests', {
      requests: provider.requests,
    });
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) {
    throw new AggregateError(failures, 'GIF provider-controlled stage failed');
  }
}

async function waitForLatestImage(
  context: GifPickerStageContext,
  observer: NodeWorkspaceAccount,
  roomId: string,
): Promise<WorkspaceImageEvent> {
  const { fixtures } = context;
  const deadline = performance.now() + 30_000;
  do {
    const event = await fixtures.latestImageEvent(observer, roomId);
    if (event?.msgtype === 'm.image') return event;
    await delay(500, undefined, { signal: context.signal });
  } while (performance.now() < deadline);
  throw new Error('Real Matrix m.image event did not appear');
}

async function runSettingsLifecycle(
  context: GifPickerStageContext,
): Promise<void> {
  const { client } = context;
  await client.reset(PIXEL_5_ACCOUNT_PROFILE);
  const { account } = await createRoomFixture(context, 'settings');
  const secretKey = 'e2e-secret-key';
  context.secrets.SECRET_GIF_SETTINGS_KEY = secretKey;
  await client.login(account);
  const rooms = new URL((await client.surface()).url);
  assert(rooms.pathname.startsWith('/rooms'));
  assert.equal(rooms.searchParams.get('account'), account.userId);
  await recordAssertion(context, assertions.settingsRoomsRouteReady, {
    roomsRoute: true,
    accountQualified: true,
  });

  await client.tapCurrent('[data-testid="open-settings"]');
  const navigation = await client.visible(
    '[aria-label="Settings sections"]',
    {},
    30_000,
  );
  await recordAssertion(context, assertions.settingsSectionsVisible, {
    visible: navigation.visible,
  });
  await client.scrollIntoViewIfNeeded(
    '[data-testid="settings-nav-gifs"]',
    '[aria-label="Settings sections"]',
  );
  await client.tapCurrent('[data-testid="settings-nav-gifs"]');
  const detail = await client.visible(
    '[data-testid="settings-detail"]',
    {},
    30_000,
  );
  const settings = new URL((await client.surface()).url);
  assert.equal(settings.pathname, '/settings/gifs');
  await recordAssertion(context, assertions.settingsDetailReady, {
    visible: detail.visible,
    pathname: settings.pathname,
  });

  const absent = await readNativeGifPreference(client, 'giphy', secretKey);
  assert.equal(absent.present, false);
  await recordAssertion(context, assertions.settingsNativePreferenceAbsent, absent);

  await client.tapCurrent('[data-testid="gif-provider-giphy"]');
  await client.fill('[data-testid="gif-api-key"]', secretKey);
  await client.tapCurrent('[data-testid="gif-save"]');
  const persisted = await waitForNativePreference(
    client,
    { provider: 'giphy', apiKey: secretKey },
    (value) => value.present,
  );
  await recordAssertion(context, assertions.settingsPreferencePersisted, {
    present: persisted.present,
  });
  assert(
    persisted.providerMatches &&
      persisted.apiKeyMatches &&
      persisted.apiKeyLength === secretKey.length,
  );
  await recordAssertion(context, assertions.settingsExactConfig, persisted);
  const clear = await client.visible('[data-testid="gif-clear"]');
  await recordAssertion(context, assertions.settingsClearVisible, {
    visible: clear.visible,
  });

  await client.tapCurrent('[data-testid="gif-clear"]');
  const cleared = await waitForNativePreference(
    client,
    { provider: 'giphy', apiKey: '' },
    (value) =>
      value.present && value.providerMatches && value.apiKeyMatches,
  );
  await recordAssertion(context, assertions.settingsClearedConfig, cleared);
  const hidden = await client.waitElements(
    '[data-testid="gif-clear"]',
    (elements) => elements.length === 0,
    'GIF Clear action hidden after clearing the key',
    {},
    20_000,
  );
  await recordAssertion(context, assertions.settingsClearHidden, {
    count: hidden.length,
  });

  await client.relaunch(PIXEL_5_ACCOUNT_PROFILE);
  const surface = new URL((await client.surface()).url);
  if (surface.pathname.startsWith('/settings')) {
    await pressNativeBack(client);
    await client.activeAccountRooms(account);
  }
  await openGifSettings(client);
  const label = await client.visible('label[for="gif-api-key"]', {
    exactText: 'GIPHY API key',
  });
  await recordAssertion(context, assertions.settingsGiphyLabelAfterRelaunch, {
    visible: label.visible,
    exactLabel: true,
  });
}

async function runUnconfiguredTray(
  context: GifPickerStageContext,
): Promise<void> {
  const { client } = context;
  await client.reset(PIXEL_5_ACCOUNT_PROFILE);
  const { account, room } = await createRoomFixture(context, 'unconfigured');
  await client.login(account);
  await openRoom(client, room.name);
  const activeRoom = await client.visible('trn-channel-sidebar .channel.active', {
    text: room.name,
  });
  await recordAssertion(context, assertions.unconfiguredRoomReady, {
    visible: activeRoom.visible,
  });
  const composer = await client.visible(COMPOSER);
  await recordAssertion(context, assertions.unconfiguredComposerReady, {
    visible: composer.visible,
    measured: composer.rect.width > 0 && composer.rect.height > 0,
  });
  await client.tapCurrent('[data-testid="composer-insert"]');
  const attach = await client.visible('[data-testid="insert-attach"]');
  await recordAssertion(context, assertions.unconfiguredAttachVisible, {
    visible: attach.visible,
  });
  const gifs = await client.elements('[data-testid="insert-gif"]');
  assert.equal(gifs.length, 0);
  await recordAssertion(context, assertions.unconfiguredGifAbsent, {
    count: gifs.length,
  });
}

async function runSendImage(context: GifPickerStageContext): Promise<void> {
  const { client } = context;
  const { account, room } = await createRoomFixture(context, 'send');
  context.secrets.SECRET_GIF_SEND_KEY = KLIPY_CONFIG.apiKey;
  await prepareConfiguredClient(context, KLIPY_CONFIG);
  await withGifProvider(context, async () => {
    await client.login(account);
    await openRoom(client, room.name);
    const activeRoom = await client.visible(
      'trn-channel-sidebar .channel.active',
      { text: room.name },
    );
    await recordAssertion(context, assertions.sendRoomReady, {
      visible: activeRoom.visible,
    });
    await client.tapCurrent('[data-testid="composer-insert"]');
    await client.tapCurrent('[data-testid="insert-gif"]');
    const search = await client.visible('[data-testid="gif-search"]');
    await recordAssertion(context, assertions.sendSearchVisible, {
      visible: search.visible,
    });
    const result = await client.visible(
      '[data-testid="gif-result"]',
      { exactText: '' },
      20_000,
    );
    await recordAssertion(context, assertions.sendResultVisible, {
      visible: result.visible,
      description: result.attributes['aria-label'] === 'e2e gif',
    });
    await client.tapCurrent('[data-testid="gif-result"]');
    await client.visible(
      '[data-testid="media-bubble"][data-media-state="ready"]',
      {},
      60_000,
    );
    const event = await waitForLatestImage(context, account, room.id);
    assert(event.msgtype === 'm.image');
    assert.equal(event.sender, account.userId);
  });
}

async function runActiveAccountSend(
  context: GifPickerStageContext,
): Promise<void> {
  const { client, fixtures } = context;
  const accountA = await fixtures.account('gif-account-a');
  const { account: accountB, room } = await createRoomFixture(
    context,
    'account-b',
  );
  trackAccountSecrets(context, 'ACCOUNT_A', accountA);
  context.secrets.SECRET_GIF_ACCOUNT_KEY = KLIPY_CONFIG.apiKey;
  await prepareConfiguredClient(context, KLIPY_CONFIG);
  await withGifProvider(context, async () => {
    await client.login(accountA);
    const activeA = await client.visible('.userbar__handle', {
      text: accountA.userId,
    });
    await recordAssertion(context, assertions.accountAActive, {
      visible: activeA.visible,
    });

    await client.openMenu();
    await client.tapCurrent('[data-testid="add-account"]');
    const cancel = await client.visible('[data-testid="cancel-add"]');
    await recordAssertion(context, assertions.accountAddReady, {
      visible: cancel.visible,
    });
    await client.login(accountB);
    const activeB = await client.visible('.userbar__handle', {
      text: accountB.userId,
    });
    await recordAssertion(context, assertions.accountBActive, {
      visible: activeB.visible,
    });

    await openRoom(client, room.name);
    const activeRoom = await client.visible(
      'trn-channel-sidebar .channel.active',
      { text: room.name },
    );
    await recordAssertion(context, assertions.accountRoomReady, {
      visible: activeRoom.visible,
    });
    await client.tapCurrent('[data-testid="composer-insert"]');
    const gif = await client.visible('[data-testid="insert-gif"]');
    await recordAssertion(context, assertions.accountGifVisible, {
      visible: gif.visible,
    });
    await client.tapCurrent('[data-testid="insert-gif"]');
    const result = await client.visible(
      '[data-testid="gif-result"]',
      {},
      20_000,
    );
    await recordAssertion(context, assertions.accountResultVisible, {
      visible: result.visible,
      description: result.attributes['aria-label'] === 'e2e gif',
    });
    await client.tapCurrent('[data-testid="gif-result"]');
    await client.visible(READY_MEDIA, {}, 60_000);
    const event = await waitForLatestImage(context, accountB, room.id);
    assert(event.msgtype === 'm.image');
    assert(event.sender === accountB.userId);
    await recordAssertion(context, assertions.accountExactSenderB, {
      readyMedia: true,
      imageMessage: true,
      exactSender: true,
    });
  });
}

const cases: readonly GifPickerCase[] = [
  {
    id: 'settings-lifecycle',
    source: `${GIF_PICKER_SOURCES.settingsLifecycle}; ${GIF_PICKER_SOURCES.navigation}; ${GIF_PICKER_SOURCES.app}; ${GIF_PICKER_SOURCES.account}`,
    expectedAssertionRecords: 10,
    run: runSettingsLifecycle,
  },
  {
    id: 'unconfigured-tray',
    source: `${GIF_PICKER_SOURCES.unconfiguredTray}; ${GIF_PICKER_SOURCES.helpers}; ${GIF_PICKER_SOURCES.app}; ${GIF_PICKER_SOURCES.account}`,
    expectedAssertionRecords: 4,
    run: runUnconfiguredTray,
  },
  {
    id: 'send-image',
    source: `${GIF_PICKER_SOURCES.sendImage}; ${GIF_PICKER_SOURCES.helpers}; ${GIF_PICKER_SOURCES.app}; ${GIF_PICKER_SOURCES.account}`,
    expectedAssertionRecords: 3,
    run: runSendImage,
  },
  {
    id: 'active-account-send',
    source: `${GIF_PICKER_SOURCES.activeAccountSend}; ${GIF_PICKER_SOURCES.helpers}; ${GIF_PICKER_SOURCES.app}; ${GIF_PICKER_SOURCES.account}`,
    expectedAssertionRecords: 7,
    run: runActiveAccountSend,
  },
];

assert.equal(cases.length, 4, 'Exactly four GIF picker stages exist');
assert.equal(allAssertionIds.length, 24);
assert.equal(GIF_PICKER_ASSERTION_RECORDS, 24);
assert.deepEqual(
  cases.map((entry) => entry.expectedAssertionRecords),
  [10, 4, 3, 7],
);
assert.deepEqual(
  Object.values(gifPickerStageAssertions).map((ids) => ids.length),
  [10, 4, 3, 7],
);

void test(
  'Android GIF picker journeys',
  { timeout: 1_200_000 },
  async (testContext) => {
    await withNodeTestResources(
      { testId: testContext.name, signal: testContext.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'gif-picker',
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
        matrixResources.cleanup('Scan GIF picker diagnostics', () =>
          scanGifPickerArtifacts(output, secrets),
        );
        matrixResources.cleanup('Redact GIF picker diagnostics', () =>
          redactMaestroArtifacts(output, secrets, true),
        );

        const unique = new Set<GifPickerAssertion>();
        const records = new Set<GifPickerAssertion>();
        const stages: Array<{
          readonly id: GifPickerCaseId;
          readonly source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          attempt: 1;
          retries: 0;
          expectedAssertionRecords: ExpectedAssertionRecords;
          assertionRecords: number;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = async (): Promise<void> =>
          writeFile(
            join(output, 'journeys.json'),
            `${JSON.stringify(
              {
                expectedStages: 4,
                expectedUniqueAssertions: 24,
                expectedAssertionRecords: 24,
                attempt: 1,
                retries: 0,
                applications: [APPLICATION_ID],
                profile: PIXEL_5_ACCOUNT_PROFILE,
                sources: GIF_PICKER_SOURCES,
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
        matrixResources.cleanup('GIF picker Android device', () =>
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
          const stageRecords = new Set<GifPickerAssertion>();
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
          const failures: unknown[] = [];
          console.info(`[gif-picker] ${entry.id} start`);
          try {
            await entry.run({
              client,
              fixtures,
              resources: matrixResources,
              signal,
              secrets,
              unique,
              records,
              stageRecords,
            });
            stage.assertionRecords = stageRecords.size;
            assert.equal(
              stage.assertionRecords,
              entry.expectedAssertionRecords,
            );
            await client.record('passed', {
              stage: entry.id,
              assertionRecords: stage.assertionRecords,
            });
          } catch (error) {
            failures.push(error);
            try {
              await client.record('failed', {
                stage: entry.id,
                error: describeFailure(error),
              });
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
              `[gif-picker] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `GIF picker journey ${entry.id} failed`,
            );
          }
        }

        assert.equal(unique.size, 24);
        assert.equal(records.size, GIF_PICKER_ASSERTION_RECORDS);
      },
    );
  },
);
