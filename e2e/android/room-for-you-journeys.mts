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
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  installFirstMatrixHttpFailure,
  type MatrixHttpFault,
  type MatrixHttpFaultOptions,
  type MatrixPushRulesTarget,
  type MatrixRoomTagTarget,
} from './matrix-http-fault.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import {
  ROOM_FOR_YOU_SOURCES,
  roomForYouAssertions as assertions,
  type RoomForYouAssertion,
} from './room-for-you-contract.mts';
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
  assertionIdentity: RoomForYouAssertion,
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
  assertionIdentity: RoomForYouAssertion,
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

async function recordAssertion<T>(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomForYouAssertion,
  observation: T,
  accepts: (value: T) => boolean,
): Promise<void> {
  assert(
    accepts(observation),
    `${assertionIdentity}: observed value satisfies the pinned assertion`,
  );
  await client.record(assertionIdentity, {
    assertion: assertionIdentity,
    observation,
  });
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
  assertionIdentity: RoomForYouAssertion,
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

interface ForYouObservation {
  readonly settings: AccountElement;
  readonly form: AccountElement;
  readonly heading: AccountElement;
}

async function openForYou(
  client: AccountWorkspaceClient,
): Promise<ForYouObservation> {
  await openRoomSettings(client);
  const settings = await client.visible('[data-testid="room-settings"]');
  await client.tapCurrent('[data-testid="room-settings-tab-for-you"]');
  const form = await client.visible(
    '[data-testid="room-settings-for-you-form"]',
    {},
    30_000,
  );
  const heading = await client.visible(
    '[data-testid="room-settings-section-heading"]',
  );
  await client.focused('[data-testid="room-settings-section-heading"]');
  return { settings, form, heading };
}

function accountPickerRow(userId: string): string {
  return `[data-testid^=${JSON.stringify(`show-account-${userId}`)}]`;
}

async function switchAccount(
  client: AccountWorkspaceClient,
  account: Parameters<AccountWorkspaceClient['rooms']>[0],
): Promise<void> {
  await client.openMenu();
  await client.tapCurrent('[data-testid="account-row"]', {
    text: account.userId,
  });
  await client.rooms(account);
}

async function mixInAccount(
  client: AccountWorkspaceClient,
  userId: string,
): Promise<void> {
  await client.openMenu();
  await client.tapCurrent('[data-testid="show-accounts"]');
  await client.tapCurrent(accountPickerRow(userId), { text: userId });
  await client.key('escape');
  await client.key('escape');
  await client.focused('[data-testid="user-menu-trigger"]');
}

type NotificationMode = 'all' | 'mentions' | 'mute';

interface ModeObservation {
  readonly expected: NotificationMode;
  readonly radios: Readonly<Record<NotificationMode, AccountElement>>;
}

async function observeMode(
  client: AccountWorkspaceClient,
  expected: NotificationMode,
): Promise<ModeObservation> {
  const read = async (): Promise<ModeObservation> => {
    const entries = await Promise.all(
      (['all', 'mentions', 'mute'] as const).map(async (mode) => [
        mode,
        await client.visible(
          `[data-testid="room-settings-notify-${mode}"] [role="radio"]`,
        ),
      ] as const),
    );
    return {
      expected,
      radios: Object.fromEntries(entries) as Record<
        NotificationMode,
        AccountElement
      >,
    };
  };
  return waitForNativeShellState(
    read,
    (value) =>
      value.radios[expected].attributes['aria-checked'] === 'true' &&
      (['all', 'mentions', 'mute'] as const)
        .filter((mode) => mode !== expected)
        .every(
          (mode) => value.radios[mode].attributes['aria-checked'] === 'false',
        ),
    `Room For-you ${expected} radio mode`,
    client.signal,
    30_000,
  );
}

async function focusFavouriteWithNativeTab(
  client: AccountWorkspaceClient,
): Promise<void> {
  const selector =
    '[data-testid="room-settings-favourite"] [role="checkbox"]';
  for (let press = 0; press < 6; press++) {
    const elements = await client.elements(selector);
    if (visibleOne(elements) && elements[0]!.focused) return;
    await client.key('tab');
  }
  await client.focused(selector);
}

async function withMatrixFault<T>(
  context: AccountWorkspaceCaseContext,
  label: string,
  artifact: string,
  options: MatrixHttpFaultOptions,
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
      throw new AggregateError(failures, `${label} cleanup failed`);
    }
  };
  resources.cleanup(label, cleanup);
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    fault = await installFirstMatrixHttpFailure(connection, options);
    result = await operation(fault);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await client.record(artifact, {
        target: options,
        matchingAttempts: fault?.attempts ?? 0,
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
    throw new AggregateError(failures, `${label} operation failed`);
  }
  return result as T;
}

async function waitForExactFaultOutcome(
  fault: MatrixHttpFault,
  status: number,
  signal: AbortSignal,
): Promise<void> {
  await waitForNativeShellState(
    async () => fault.firstOutcome,
    (outcome) =>
      outcome?.responseStatus === status &&
      outcome.finished === true &&
      outcome.bodyMatchesInjected === true,
    `Matrix HTTP ${status} fault outcome`,
    signal,
    30_000,
  );
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'failed-read-retry',
    source: ROOM_FOR_YOU_SOURCES.failedRead,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run(context) {
      const { client, fixtures, resources, signal } = context;
      const owner = await fixtures.account('room-for-you-load-owner');
      const room = await fixtures.createRoom(owner, {
        name: `For you load ${resources.roomName('room-for-you-load')}`,
        preset: 'private_chat',
      });
      await client.login(owner);
      await openRoom(client, room.name, assertions.loadRoomTimelineVisible);

      await withMatrixFault(
        context,
        'Room For-you push-rules read fault',
        'load-transport',
        {
          kind: 'push-rules',
          method: 'GET',
          status: 500,
          responseError: 'offline',
        },
        async (fault) => {
          await openRoomSettings(client);
          await observedElements(
            client,
            assertions.loadSettingsVisible,
            '[data-testid="room-settings"]',
            visibleOne,
          );
          await client.tapCurrent('[data-testid="room-settings-tab-for-you"]');
          const alertSelector =
            '[data-testid="room-settings-panel-for-you"] [role="alert"]';
          await observedElements(
            client,
            assertions.loadErrorHeadingVisible,
            `${alertSelector} h3`,
            (elements) =>
              visibleOne(elements) &&
              elements[0]!.text === 'Couldn’t read Room preferences',
          );
          const alert = await client.visible(alertSelector);
          const retry = await client.visible(
            '[data-testid="room-settings-for-you-retry"]',
          );
          await recordAssertion(
            client,
            assertions.loadAlertNotLive,
            alert,
            (element) => element.attributes['aria-live'] === undefined,
          );
          await recordAssertion(
            client,
            assertions.loadRetryEnabled,
            retry,
            (element) =>
              !element.disabled &&
              element.attributes['aria-disabled'] !== 'true',
          );
          await recordAssertion(
            client,
            assertions.loadAlertBoxPresent,
            alert.rect,
            (rect) => rect.width > 0 && rect.height > 0,
          );
          await recordAssertion(
            client,
            assertions.loadRetryBoxPresent,
            retry.rect,
            (rect) => rect.width > 0 && rect.height > 0,
          );
          await recordAssertion(
            client,
            assertions.loadRetryLeftContained,
            { alert: alert.rect, retry: retry.rect },
            ({ alert: alertRect, retry: retryRect }) =>
              retryRect.x >= alertRect.x,
          );
          await recordAssertion(
            client,
            assertions.loadRetryTopContained,
            { alert: alert.rect, retry: retry.rect },
            ({ alert: alertRect, retry: retryRect }) =>
              retryRect.y >= alertRect.y,
          );
          await recordAssertion(
            client,
            assertions.loadRetryRightContained,
            { alert: alert.rect, retry: retry.rect },
            ({ alert: alertRect, retry: retryRect }) =>
              retryRect.right <= alertRect.right,
          );
          await recordAssertion(
            client,
            assertions.loadRetryBottomContained,
            { alert: alert.rect, retry: retry.rect },
            ({ alert: alertRect, retry: retryRect }) =>
              retryRect.bottom <= alertRect.bottom,
          );
          await client.capture('room-preferences-load-failure');
          await client.tapCurrent('[data-testid="room-settings-for-you-retry"]');
          await observedElements(
            client,
            assertions.loadFormVisible,
            '[data-testid="room-settings-for-you-form"]',
            visibleOne,
          );
          await fault.waitForAttempts(
            2,
            AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          );
          await recordAssertion(
            client,
            assertions.loadReadAttemptsMinimum,
            fault.pushRulesAttempts({ method: 'GET' }),
            (attempts) => attempts >= 2,
          );
          await waitForExactFaultOutcome(fault, 500, signal);
        },
      );
    },
  },
  {
    id: 'account-isolation-partial-retry',
    source: ROOM_FOR_YOU_SOURCES.accountIsolation,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run(context) {
      const { client, fixtures, resources, signal } = context;
      const owner = await fixtures.account('room-for-you-owner');
      const member = await fixtures.account('room-for-you-member');
      const room = await fixtures.createRoom(owner, {
        name: `For you ${resources.roomName('room-for-you-preferences')}`,
        preset: 'private_chat',
        invite: [member.userId],
      });
      await fixtures.join(member, room.id);
      await fixtures.setRoomNotificationMode(member, room.id, 'mentions');
      await fixtures.setRoomTag(member, room.id, 'm.favourite');

      await client.login(owner);
      await client.addAccount(member);
      await switchAccount(client, owner);
      await mixInAccount(client, member.userId);
      await openRoom(
        client,
        room.name,
        assertions.preferencesOwnerRoomTimelineVisible,
      );
      const openObservations: ForYouObservation[] = [await openForYou(client)];
      const modeObservations: ModeObservation[] = [
        await observeMode(client, 'all'),
      ];

      await observedElements(
        client,
        assertions.preferencesOpeningAccount,
        '[data-testid="room-settings-account"]',
        (elements) =>
          visibleOne(elements) && elements[0]!.text.includes(owner.username),
      );
      await observedElements(
        client,
        assertions.preferencesInitialFavouriteUnchecked,
        '[data-testid="room-settings-favourite"] [role="checkbox"]',
        (elements) =>
          visibleOne(elements) &&
          elements[0]!.attributes['aria-checked'] === 'false',
      );

      await client.tapCurrent(
        '[data-testid="room-settings-notify-all"]',
      );
      await client.key('arrowDown');
      await client.key('arrowDown');
      await client.key('space');
      modeObservations.push(await observeMode(client, 'mute'));
      await focusFavouriteWithNativeTab(client);
      await client.key('space');
      await client.visible(
        '[data-testid="room-settings-favourite"] [role="checkbox"]',
      );
      await client.tapCurrent(
        '[data-testid="room-settings-low-priority"] [role="checkbox"]',
      );

      const lowPriorityTarget: MatrixRoomTagTarget = {
        method: 'PUT',
        userId: owner.userId,
        roomId: room.id,
        tag: 'm.lowpriority',
      };
      const notificationPut: MatrixPushRulesTarget = {
        method: 'PUT',
        roomId: room.id,
      };
      const notificationDelete: MatrixPushRulesTarget = {
        method: 'DELETE',
        roomId: room.id,
      };
      const favouriteTarget: MatrixRoomTagTarget = {
        method: 'PUT',
        userId: owner.userId,
        roomId: room.id,
        tag: 'm.favourite',
      };

      await withMatrixFault(
        context,
        'Room For-you low-priority write fault',
        'preferences-transport',
        {
          kind: 'room-tag',
          ...lowPriorityTarget,
          status: 500,
          responseError: 'retry me',
        },
        async (fault) => {
          await client.tapCurrent('[data-testid="room-settings-for-you-save"]');
          await observedElements(
            client,
            assertions.preferencesPartialFeedback,
            '[data-testid="room-settings-for-you-feedback"]',
            (elements) =>
              visibleOne(elements) &&
              elements[0]!.text ===
                'Notifications and favourite saved. Low priority is still unsaved; retry saves only what remains.',
          );
          await fault.waitForAttempts(
            1,
            AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          );
          const firstNotificationWrites =
            fault.pushRulesAttempts(notificationPut) +
            fault.pushRulesAttempts(notificationDelete);
          const firstFavouriteWrites =
            fault.roomTagAttempts(favouriteTarget);
          const firstLowPriorityWrites =
            fault.roomTagAttempts(lowPriorityTarget);
          await recordAssertion(
            client,
            assertions.preferencesNotificationFirstWrites,
            firstNotificationWrites,
            (attempts) => attempts > 0,
          );
          await recordAssertion(
            client,
            assertions.preferencesFavouriteFirstWrites,
            firstFavouriteWrites,
            (attempts) => attempts === 1,
          );
          await recordAssertion(
            client,
            assertions.preferencesLowPriorityFirstWrites,
            firstLowPriorityWrites,
            (attempts) => attempts >= 1,
          );

          const visualObservations: Array<{
            readonly dark: boolean;
            readonly theme: string | null;
            readonly form: AccountElement;
            readonly save: AccountElement;
            readonly settings: AccountElement;
          }> = [];
          for (const theme of [null, 'amethyst', 'onyx'] as const) {
            for (const dark of [false, true]) {
              await withSpaceSettingsVisualFixture(
                client,
                { dark, theme },
                async () => {
                  const form = await client.visible(
                    '[data-testid="room-settings-for-you-form"]',
                  );
                  const save = await client.visible(
                    '[data-testid="room-settings-for-you-save"]',
                  );
                  const settings = await client.visible(
                    '[data-testid="room-settings"]',
                  );
                  assert(
                    save.rect.x >= settings.rect.x &&
                      save.rect.right <= settings.rect.right &&
                      save.rect.y >= settings.rect.y &&
                      save.rect.bottom <= settings.rect.bottom &&
                      save.unobstructedCenter,
                    'Room For-you save action remains reachable',
                  );
                  visualObservations.push({
                    dark,
                    theme,
                    form,
                    save,
                    settings,
                  });
                  await client.capture(
                    `room-for-you-${theme ?? 'default'}-${dark ? 'dark' : 'light'}`,
                  );
                },
              );
            }
          }
          await recordAssertion(
            client,
            assertions.preferencesThemeFormVisible,
            visualObservations,
            (observations) =>
              observations.length === 6 &&
              observations.every(({ form }) => form.visible),
          );
          await withSpaceSettingsVisualFixture(
            client,
            { fontSize: '125%' },
            async () => {
              const form = await client.visible(
                '[data-testid="room-settings-for-you-form"]',
              );
              const save = await client.visible(
                '[data-testid="room-settings-for-you-save"]',
              );
              await recordAssertion(
                client,
                assertions.preferencesScaledFormVisible,
                { form, save },
                (observation) =>
                  observation.form.visible &&
                  observation.save.visible &&
                  observation.save.unobstructedCenter,
              );
              await client.capture('room-for-you-125-percent');
            },
          );

          await client.tapCurrent('[data-testid="room-settings-for-you-save"]');
          await observedElements(
            client,
            assertions.preferencesRetryFeedback,
            '[data-testid="room-settings-for-you-feedback"]',
            (elements) =>
              visibleOne(elements) &&
              elements[0]!.text ===
                'Low priority saved for the opening Account.',
          );
          await fault.waitForAttempts(
            2,
            AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
          );
          await recordAssertion(
            client,
            assertions.preferencesNotificationTotalWrites,
            fault.pushRulesAttempts(notificationPut) +
              fault.pushRulesAttempts(notificationDelete),
            (attempts) => attempts === firstNotificationWrites,
          );
          await recordAssertion(
            client,
            assertions.preferencesFavouriteTotalWrites,
            fault.roomTagAttempts(favouriteTarget),
            (attempts) => attempts === firstFavouriteWrites,
          );
          assert.equal(
            fault.roomTagAttempts(lowPriorityTarget),
            2,
            'Only the exact low-priority field retries once',
          );
          await waitForExactFaultOutcome(fault, 500, signal);
        },
      );

      await observedValue(
        client,
        assertions.preferencesOwnerModePersisted,
        () => fixtures.roomNotificationMode(owner, room.id),
        (mode) => mode === 'mute',
      );
      await observedValue(
        client,
        assertions.preferencesOwnerTagsPersisted,
        () => fixtures.roomTags(owner, room.id),
        (tags) =>
          Object.keys(tags).sort().join(',') ===
          'm.favourite,m.lowpriority',
      );
      await observedValue(
        client,
        assertions.preferencesMemberModePersisted,
        () => fixtures.roomNotificationMode(member, room.id),
        (mode) => mode === 'mentions',
      );
      await observedValue(
        client,
        assertions.preferencesMemberTagsPersisted,
        () => fixtures.roomTags(member, room.id),
        (tags) =>
          Object.keys(tags).sort().join(',') === 'm.favourite',
      );

      await client.tapCurrent('[data-testid="room-settings-cancel"]');
      await switchAccount(client, member);
      await openRoom(
        client,
        room.name,
        assertions.preferencesMemberRoomTimelineVisible,
      );
      openObservations.push(await openForYou(client));
      modeObservations.push(await observeMode(client, 'mentions'));
      await observedElements(
        client,
        assertions.preferencesMemberAccount,
        '[data-testid="room-settings-account"]',
        (elements) =>
          visibleOne(elements) && elements[0]!.text.includes(member.username),
      );
      await observedElements(
        client,
        assertions.preferencesMemberFavouriteChecked,
        '[data-testid="room-settings-favourite"] [role="checkbox"]',
        (elements) =>
          visibleOne(elements) &&
          elements[0]!.attributes['aria-checked'] === 'true',
      );
      await observedElements(
        client,
        assertions.preferencesMemberLowPriorityUnchecked,
        '[data-testid="room-settings-low-priority"] [role="checkbox"]',
        (elements) =>
          visibleOne(elements) &&
          elements[0]!.attributes['aria-checked'] === 'false',
      );

      await recordAssertion(
        client,
        assertions.preferencesSettingsVisible,
        openObservations.map(({ settings }) => settings),
        (elements) => elements.length === 2 && elements.every(({ visible }) => visible),
      );
      await recordAssertion(
        client,
        assertions.preferencesFormVisible,
        openObservations.map(({ form }) => form),
        (elements) => elements.length === 2 && elements.every(({ visible }) => visible),
      );
      await recordAssertion(
        client,
        assertions.preferencesHeadingFocused,
        openObservations.map(({ heading }) => heading),
        (elements) => elements.length === 2 && elements.every(({ focused }) => focused),
      );
      await recordAssertion(
        client,
        assertions.preferencesExpectedModeChecked,
        modeObservations,
        (observations) =>
          observations.length === 3 &&
          observations.every(
            ({ expected, radios }) =>
              radios[expected].attributes['aria-checked'] === 'true',
          ),
      );
      await recordAssertion(
        client,
        assertions.preferencesOtherModesUnchecked,
        modeObservations,
        (observations) =>
          observations.length === 3 &&
          observations.every(({ expected, radios }) =>
            (['all', 'mentions', 'mute'] as const)
              .filter((mode) => mode !== expected)
              .every(
                (mode) => radios[mode].attributes['aria-checked'] === 'false',
              ),
          ),
      );
    },
  },
];

assert.equal(cases.length, 2, 'Exactly two Room For-you stages are required');
assert.equal(
  Object.keys(assertions).length,
  38,
  'Exactly 38 Room For-you assertions are required',
);

void test(
  'Android Room For-you preference journeys',
  { timeout: 1_800_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-for-you',
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
        matrixResources.cleanup('Redact Room For-you diagnostics', () =>
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
        matrixResources.cleanup('Room For-you Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Room For-you Android WebView',
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
          console.info(`[room-for-you] ${entry.id} start`);
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
              `[room-for-you] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Room For-you journey ${entry.id} failed`,
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
