import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSession } from '../support/session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import {
  AccountWorkspaceClient,
  DESKTOP_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountElementFilter,
  type AccountWorkspaceCase,
  type AccountWorkspaceCaseContext,
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import { pickAndroidDocument } from './maestro-document-picker.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  installFirstMatrixHttpFailure,
  installMatrixRoomStateDelay,
  type MatrixHttpDelay,
  type MatrixHttpFault,
} from './matrix-http-fault.mts';
import {
  ROOM_PROFILE_SETTINGS_SOURCES,
  roomProfileSettingsAssertions as assertions,
  type RoomProfileSettingsAssertion,
} from './room-profile-settings-contract.mts';
import { switchBlockedRoomSettingsAccount } from './room-profile-settings-account-transition.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { withSpaceSettingsVisualFixture } from './space-settings-visual-fixture.mts';

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

const visibleOne = (elements: readonly AccountElement[]): boolean =>
  elements.length === 1 && elements[0]!.visible;

async function observedValue<T>(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomProfileSettingsAssertion,
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  let observation: T | null = null;
  let value: T;
  try {
    value = await waitForNativeShellState(
      async () => {
        const latest = await read();
        observation = latest;
        return latest;
      },
      accepts,
      assertionIdentity,
      client.signal,
      timeoutMs,
    );
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await client.record(assertionIdentity, {
        assertion: assertionIdentity,
        observation,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
    throw new AggregateError(
      failures,
      `${assertionIdentity}: ${describeFailure(error)}`,
    );
  }
  await client.record(assertionIdentity, {
    assertion: assertionIdentity,
    observation: value,
  });
  return value;
}

function observedElements(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomProfileSettingsAssertion,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: AccountElementFilter = {},
  timeoutMs = 30_000,
): Promise<readonly AccountElement[]> {
  return observedValue(
    client,
    assertionIdentity,
    () => client.elements(selector, filter),
    accepts,
    timeoutMs,
  );
}

function observedServerValue<T>(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomProfileSettingsAssertion,
  read: () => Promise<T>,
  accepts: (value: T) => boolean,
): Promise<T> {
  return observedValue(client, assertionIdentity, read, accepts);
}

async function recordCount(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomProfileSettingsAssertion,
  actual: number,
  expected: number,
): Promise<void> {
  assert.equal(actual, expected, `${assertionIdentity}: exact request count`);
  await client.record(assertionIdentity, {
    assertion: assertionIdentity,
    actual,
    expected,
  });
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
  assertionIdentity: RoomProfileSettingsAssertion,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomName }, 30_000);
  await client.tapCurrent('.channel', { text: roomName });
  await observedElements(
    client,
    assertionIdentity,
    '[data-testid="composer-input"]',
    visibleOne,
  );
}

async function openRoomSettings(client: AccountWorkspaceClient): Promise<void> {
  await client.tapCurrent('[data-testid="open-room-settings"]');
  await client.visible('[data-testid="room-settings"]', {}, 30_000);
}

async function pressNativeBack(client: AccountWorkspaceClient): Promise<void> {
  await client.device.runFlow(
    join(client.workspaceRoot, 'e2e/android/flows/native-shell-back.yaml'),
    { APP_ID: 'eu.qwky.trinity' },
  );
  await client.resize(
    DESKTOP_ACCOUNT_PROFILE.width,
    DESKTOP_ACCOUNT_PROFILE.height,
  );
}

async function withTopicFailure<T>(
  context: AccountWorkspaceCaseContext,
  roomId: string,
  operation: (fault: MatrixHttpFault) => Promise<T>,
): Promise<T> {
  const { client, resources } = context;
  const connection = await client.webview.openSession();
  let fault: MatrixHttpFault | undefined;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    const failures: unknown[] = [];
    try {
      await fault?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      connection.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        'Room topic transport instrumentation cleanup failed',
      );
    }
  };
  resources.cleanup('Room topic transport instrumentation', cleanup);
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    fault = await installFirstMatrixHttpFailure(connection, {
      kind: 'room-state',
      roomId,
      eventType: 'm.room.topic',
      status: 500,
      responseError: 'retry me',
    });
    result = await operation(fault);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await client.record('partial-transport', {
        target: { roomId, eventType: 'm.room.topic' },
        injectedStatus: 500,
        responseError: 'retry me',
        matchingAttempts: fault?.attempts ?? 0,
        nameAttempts: fault?.roomStateAttempts('m.room.name') ?? 0,
        topicAttempts: fault?.roomStateAttempts('m.room.topic') ?? 0,
        firstOutcome: fault?.firstOutcome,
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(failures, 'Room topic transport operation failed');
  }
  return result as T;
}

async function withNameDelay<T>(
  context: AccountWorkspaceCaseContext,
  roomId: string,
  operation: (delay: MatrixHttpDelay) => Promise<T>,
): Promise<T> {
  const { client, resources } = context;
  const connection = await client.webview.openSession();
  let controller: MatrixHttpDelay | undefined;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    const failures: unknown[] = [];
    try {
      await controller?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      connection.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(failures, 'Room name delay cleanup failed');
    }
  };
  resources.cleanup('Room name transport delay', cleanup);
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    controller = await installMatrixRoomStateDelay(connection, {
      roomId,
      eventType: 'm.room.name',
    });
    result = await operation(controller);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await client.record('continuity-name-delay', {
        target: { roomId, eventType: 'm.room.name' },
        matchingAttempts: controller?.attempts ?? 0,
        released: controller?.released ?? false,
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(failures, 'Room name delay operation failed');
  }
  return result as T;
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'rename-room',
    source: ROOM_PROFILE_SETTINGS_SOURCES.rename,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('room-profile-rename-owner');
      const suffix = resources.roomName('room-profile-rename');
      const priorName = `Prior ${suffix}`;
      const originalName = `Before ${suffix}`;
      const newName = `After-${suffix}`;
      await fixtures.createRoom(owner, {
        name: priorName,
        preset: 'private_chat',
      });
      await fixtures.createRoom(owner, {
        name: originalName,
        preset: 'private_chat',
      });

      await client.login(owner);
      await openRoom(
        client,
        priorName,
        assertions.renamePriorRoomTimelineVisible,
      );
      await openRoom(
        client,
        originalName,
        assertions.renameOriginalRoomTimelineVisible,
      );
      await openRoomSettings(client);
      await observedElements(
        client,
        assertions.renameSettingsVisible,
        '[data-testid="room-settings"]',
        visibleOne,
      );
      await observedElements(
        client,
        assertions.renameDirectoryVisible,
        '[data-testid="room-settings-directory"]',
        visibleOne,
      );
      await observedElements(
        client,
        assertions.renameOpeningAccount,
        '[data-testid="room-settings-account"]',
        (elements) =>
          visibleOne(elements) && elements[0]!.text.includes(owner.username),
      );
      await observedElements(
        client,
        assertions.renameHeadingFocused,
        '[data-testid="room-settings"] h1',
        (elements) =>
          visibleOne(elements) &&
          elements[0]!.text === 'Room settings' &&
          elements[0]!.focused,
      );
      await observedElements(
        client,
        assertions.renameDesktopWidthMinimum,
        '[data-testid="room-settings"]',
        (elements) => visibleOne(elements) && elements[0]!.rect.width > 700,
      );
      await observedElements(
        client,
        assertions.renameDesktopWidthMaximum,
        '[data-testid="room-settings"]',
        (elements) =>
          visibleOne(elements) &&
          elements[0]!.rect.width < DESKTOP_ACCOUNT_PROFILE.width,
      );

      try {
        await client.resize(700, 800);
        await observedElements(
          client,
          assertions.renameCompactDirectoryHidden,
          '[data-testid="room-settings-directory"]',
          (elements) =>
            elements.length === 1 && elements.every((element) => !element.visible),
        );
        await observedElements(
          client,
          assertions.renameCompactBackVisible,
          '[data-testid="room-settings-mobile-back"]',
          visibleOne,
        );
        await observedElements(
          client,
          assertions.renameCompactGeneralVisible,
          '[data-testid="room-settings-panel-general"]',
          visibleOne,
        );
      } finally {
        await client.resize(
          DESKTOP_ACCOUNT_PROFILE.width,
          DESKTOP_ACCOUNT_PROFILE.height,
        );
      }
      await observedElements(
        client,
        assertions.renameDesktopDirectoryRestored,
        '[data-testid="room-settings-directory"]',
        visibleOne,
      );
      await observedElements(
        client,
        assertions.renameDesktopBackHidden,
        '[data-testid="room-settings-mobile-back"]',
        (elements) => elements.every((element) => !element.visible),
      );

      await withSpaceSettingsVisualFixture(
        client,
        { fontSize: '125%' },
        async () => {
          await observedElements(
            client,
            assertions.renameScaledCancelVisible,
            '[data-testid="room-settings-cancel"]',
            visibleOne,
          );
          await observedElements(
            client,
            assertions.renameScaledActionsAbsent,
            '[data-testid="room-settings-general-actions"]',
            (elements) => elements.length === 0,
          );
        },
      );

      await client.replace('[data-testid="room-settings-name"]', newName);
      await pressNativeBack(client);
      await observedElements(
        client,
        assertions.renameBackDiscardVisible,
        '[data-testid="alert-surface"]',
        (elements) =>
          visibleOne(elements) &&
          elements[0]!.text.includes('Discard Room settings changes?'),
      );
      await client.tapCurrent('[data-testid="alert-cancel"]');
      await observedElements(
        client,
        assertions.renameBackDraftRetained,
        '[data-testid="room-settings-name"]',
        (elements) => visibleOne(elements) && elements[0]!.value === newName,
      );

      await client.tapCurrent('[data-testid="room-settings-tab-access"]');
      await observedElements(
        client,
        assertions.renameTabDiscardVisible,
        '[data-testid="alert-surface"]',
        (elements) =>
          visibleOne(elements) &&
          elements[0]!.text.includes('Discard Room settings changes?'),
      );
      await client.tapCurrent('[data-testid="alert-cancel"]');
      await observedElements(
        client,
        assertions.renameTabDraftRetained,
        '[data-testid="room-settings-name"]',
        (elements) => visibleOne(elements) && elements[0]!.value === newName,
      );
      await observedElements(
        client,
        assertions.renameGeneralPanelRetained,
        '[data-testid="room-settings-panel-general"]',
        visibleOne,
      );

      await withSpaceSettingsVisualFixture(
        client,
        { dark: false, theme: null },
        () => client.capture('room-settings-desktop-general-light'),
      );
      await withSpaceSettingsVisualFixture(
        client,
        { dark: true, theme: 'amethyst' },
        () => client.capture('room-settings-desktop-general-dark-amethyst'),
      );
      await client.tapCurrent('[data-testid="room-settings-save"]');
      await observedElements(
        client,
        assertions.renameNewChannelVisible,
        '.channel',
        visibleOne,
        { text: newName },
        90_000,
      );
      await observedElements(
        client,
        assertions.renameOldChannelAbsent,
        '.channel',
        (elements) => elements.length === 0,
        { text: originalName },
        90_000,
      );
    },
  },
  {
    id: 'change-photo',
    source: ROOM_PROFILE_SETTINGS_SOURCES.photo,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('room-profile-photo-owner');
      const room = await fixtures.createRoom(owner, {
        name: `Photo ${resources.roomName('room-profile-photo')}`,
        preset: 'private_chat',
      });
      await client.login(owner);
      await openRoom(
        client,
        room.name,
        assertions.photoRoomTimelineVisible,
      );
      await openRoomSettings(client);
      await observedElements(
        client,
        assertions.photoSettingsVisible,
        '[data-testid="room-settings"]',
        visibleOne,
      );

      const photoPath = join(client.output, 'photo.png');
      await writeFile(
        photoPath,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      await client.tapDocumentTrigger(
        '[data-testid="room-settings-avatar"]',
        'trn-avatar-field:has([data-testid="room-settings-avatar"]) input[type="file"]',
      );
      await pickAndroidDocument(
        client.device,
        client.workspaceRoot,
        photoPath,
        'room-photo.png',
      );
      await observedValue(
        client,
        assertions.photoUpdated,
        async () => ({
          feedback: await client.elements(
            '[aria-label="Notifications alt+T"] [data-sonner-toast]',
          ),
          avatar: await fixtures.roomState(owner, room.id, 'm.room.avatar'),
        }),
        ({ feedback, avatar }) =>
          feedback.some(
            (element) =>
              element.visible && element.text.includes('Room photo updated.'),
          ) &&
          typeof avatar?.['url'] === 'string' &&
          avatar['url'].startsWith('mxc://'),
      );
    },
  },
  {
    id: 'partial-general-retry',
    source: ROOM_PROFILE_SETTINGS_SOURCES.partialFailure,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run(context) {
      const { client, fixtures, resources, signal } = context;
      const owner = await fixtures.account('room-profile-partial-owner');
      const room = await fixtures.createRoom(owner, {
        name: `Partial ${resources.roomName('room-profile-partial')}`,
        preset: 'private_chat',
      });
      await client.login(owner);
      await openRoom(
        client,
        room.name,
        assertions.partialRoomTimelineVisible,
      );
      await openRoomSettings(client);

      await withTopicFailure(context, room.id, async (fault) => {
        const renamed = 'PartialRoomRenamed';
        const topic = 'Eventually saved';
        await client.replace('[data-testid="room-settings-name"]', renamed);
        await client.fill('[data-testid="room-settings-topic"]', topic);
        await client.tapCurrent('[data-testid="room-settings-save"]');
        await fault.waitForAttempts(
          1,
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        );
        await observedElements(
          client,
          assertions.partialFailureFeedback,
          '[data-testid="room-settings-general-feedback"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('still unsaved'),
        );
        await recordCount(
          client,
          assertions.partialNameFirstAttempts,
          fault.roomStateAttempts('m.room.name'),
          1,
        );
        await recordCount(
          client,
          assertions.partialTopicFirstAttempts,
          fault.roomStateAttempts('m.room.topic'),
          1,
        );

        await client.tapCurrent('[data-testid="room-settings-save"]');
        await observedValue(
          client,
          assertions.partialRetryFeedback,
          async () => ({
            feedback: await client.elements(
              '[data-testid="room-settings-general-feedback"]',
            ),
            name: await fixtures.roomState(owner, room.id, 'm.room.name'),
            topicState: await fixtures.roomState(owner, room.id, 'm.room.topic'),
          }),
          ({ feedback, name, topicState }) =>
            visibleOne(feedback) &&
            feedback[0]!.text.includes('Topic saved') &&
            name?.['name'] === renamed &&
            topicState?.['topic'] === topic,
        );
        await fault.waitForAttempts(
          2,
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        );
        await recordCount(
          client,
          assertions.partialNameTotalAttempts,
          fault.roomStateAttempts('m.room.name'),
          1,
        );
        await recordCount(
          client,
          assertions.partialTopicTotalAttempts,
          fault.roomStateAttempts('m.room.topic'),
          2,
        );
      });
    },
  },
  {
    id: 'opening-account-continuity',
    source: ROOM_PROFILE_SETTINGS_SOURCES.accountContinuity,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run(context) {
      const { client, fixtures, resources, signal } = context;
      const owner = await fixtures.account('room-profile-continuity-owner');
      const member = await fixtures.account('room-profile-continuity-member');
      const room = await fixtures.createRoom(owner, {
        name: `Shared ${resources.roomName('room-profile-continuity')}`,
        preset: 'private_chat',
        invite: [member.userId],
      });
      await fixtures.join(member, room.id);

      await client.login(owner);
      await client.addAccount(member);
      await client.openMenu();
      await client.tapCurrent('[data-testid="account-row"]', {
        text: owner.userId,
      });
      await client.rooms(owner);
      await openRoom(
        client,
        room.name,
        assertions.continuityRoomTimelineVisible,
      );
      await openRoomSettings(client);
      await observedElements(
        client,
        assertions.continuityOpeningAccount,
        '[data-testid="room-settings-account"]',
        (elements) =>
          visibleOne(elements) && elements[0]!.text.includes(owner.username),
      );

      await withNameDelay(context, room.id, async (nameDelay) => {
        await client.replace(
          '[data-testid="room-settings-name"]',
          'OpeningAccountRoomRenamed',
        );
        await client.tapCurrent('[data-testid="room-settings-save"]');
        await nameDelay.waitForAttempts(
          1,
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        );
        await observedElements(
          client,
          assertions.continuityNameSaving,
          '[data-testid="room-settings-save"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Saving'),
        );

        await switchBlockedRoomSettingsAccount(
          client,
          member.userId,
          assertions.continuityMemberRowVisible,
          assertions.continuityActiveMember,
        );
        await observedElements(
          client,
          assertions.continuityAccountRetained,
          '[data-testid="room-settings-account"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes(owner.username),
        );
        await nameDelay.release();
        await observedElements(
          client,
          assertions.continuityNameSaved,
          '[data-testid="room-settings-general-feedback"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Name saved'),
        );

        await client.fill(
          '[data-testid="room-settings-topic"]',
          'Owned by account A',
        );
        await client.tapCurrent('[data-testid="room-settings-save"]');
        await observedElements(
          client,
          assertions.continuityTopicSaved,
          '[data-testid="room-settings-general-feedback"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Topic saved'),
        );
        await observedServerValue(
          client,
          assertions.continuityTopicPersisted,
          () => fixtures.roomState(member, room.id, 'm.room.topic'),
          (value) => value?.['topic'] === 'Owned by account A',
        );
      });
    },
  },
];

assert.equal(
  cases.length,
  4,
  'Exactly four Room profile settings stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  41,
  'Exactly 41 Room profile settings assertions are required',
);

void test(
  'Android Room profile settings journeys',
  { timeout: 2_100_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-profile-settings',
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
        matrixResources.cleanup('Redact Room profile settings diagnostics', () =>
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
            `${JSON.stringify({ expectedStages: cases.length, stages }, null, 2)}\n`,
          );
        await save();

        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Room profile settings Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Room profile settings Android WebView',
          async () => client?.close(),
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
          console.info(`[room-profile-settings] ${entry.id} start`);
          try {
            await client.reset(entry.profile ?? DESKTOP_ACCOUNT_PROFILE);
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
              `[room-profile-settings] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Room profile settings journey ${entry.id} failed`,
            );
          }
        }
        assert.equal(
          stages.filter((stage) => stage.status === 'passed').length,
          cases.length,
        );
      },
    );
  },
);
