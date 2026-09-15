import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSession } from '../support/session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountWorkspaceCase,
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

const forYouSource =
  'e2e/browser/journeys/room-administration/room-settings-for-you-mobile.spec.mts:18-115';
const generalSource =
  'e2e/browser/journeys/room-administration/room-settings-general-mobile.spec.mts:18-149';

const assertions = {
  forYouSettingsVisible: 'for-you.settings-visible',
  forYouDirectoryVisible: 'for-you.directory-visible',
  forYouFormVisible: 'for-you.form-visible',
  forYouMuteEnabled: 'for-you.mute-enabled',
  forYouFavouriteEnabled: 'for-you.favourite-enabled',
  forYouMuteRetained: 'for-you.mute-retained',
  forYouFavouriteRetained: 'for-you.favourite-retained',
  forYouSavedFeedback: 'for-you.saved-feedback',
  generalSettingsVisible: 'general.settings-visible',
  generalFullWidth: 'general.full-width',
  generalFullHeight: 'general.full-height',
  generalDirectoryVisible: 'general.directory-visible',
  generalPanelInitiallyHidden: 'general.panel-initially-hidden',
  generalPanelVisible: 'general.panel-visible',
  generalHeadingFocused: 'general.heading-focused',
  generalAccountContained: 'general.account-contained',
  generalPristineActionsHidden: 'general.pristine-actions-hidden',
  generalDraftActionsVisible: 'general.draft-actions-visible',
  generalActionsSticky: 'general.actions-sticky',
  generalDiscardVisible: 'general.discard-visible',
  generalSaveVisible: 'general.save-visible',
  generalDraftRetained: 'general.draft-retained',
  generalDiscardDirectoryVisible: 'general.discard-directory-visible',
  generalRoomNameContained: 'general.room-name-contained',
  generalTabTouchTarget: 'general-tab.touch-target',
  addressesTabTouchTarget: 'addresses-tab.touch-target',
  accessPanelVisible: 'access.panel-visible',
  accessHeadingFocused: 'access.heading-focused',
  accessActionsHidden: 'access.actions-hidden',
  accessBackDirectoryVisible: 'access.back-directory-visible',
  generalReopenedVisible: 'general.reopened-visible',
  generalSettingsClosed: 'general.settings-closed',
  generalComposerVisible: 'general.composer-visible',
} as const;

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function observedElements(
  client: AccountWorkspaceClient,
  assertion: string,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: { readonly text?: string; readonly exactText?: string } = {},
  timeoutMs = 30_000,
): Promise<readonly AccountElement[]> {
  try {
    const elements = await client.waitElements(
      selector,
      accepts,
      assertion,
      filter,
      timeoutMs,
    );
    await client.record(assertion, { assertion, observation: elements });
    return elements;
  } catch (error) {
    const failures: unknown[] = [error];
    let observation: readonly AccountElement[] | null = null;
    try {
      observation = await client.elements(selector, filter);
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
    try {
      await client.record(assertion, {
        assertion,
        observation,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
    throw new AggregateError(
      failures,
      `${assertion}: ${describeFailure(error)}`,
    );
  }
}

async function observedValue(
  client: AccountWorkspaceClient,
  assertion: string,
  expression: string,
  accepts: (value: unknown) => boolean,
  timeoutMs = 30_000,
): Promise<unknown> {
  try {
    const value = await waitForNativeShellState(
      () => evaluateNative(client.webview, expression),
      accepts,
      assertion,
      client.signal,
      timeoutMs,
    );
    await client.record(assertion, { assertion, observation: value });
    return value;
  } catch (error) {
    const failures: unknown[] = [error];
    let observation: unknown = null;
    try {
      observation = await evaluateNative(client.webview, expression);
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
    try {
      await client.record(assertion, {
        assertion,
        observation,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
    throw new AggregateError(
      failures,
      `${assertion}: ${describeFailure(error)}`,
    );
  }
}

async function recordReadOnlyWebviewSession(
  client: AccountWorkspaceClient,
): Promise<void> {
  const connection = await client.webview.openSession();
  try {
    const title = await connection.send('Runtime.evaluate', {
      expression: 'document.title',
      returnByValue: true,
    });
    await client.record('readonly-webview-session', title);
  } finally {
    connection.close();
  }
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel__name', { exactText: roomName }, 30_000);
  await client.tapCurrent('.channel', { text: roomName });
  await client.visible('[data-testid="composer-input"]', {}, 30_000);
}

async function openRoomSettings(client: AccountWorkspaceClient): Promise<void> {
  await client.tapCurrent('[data-testid="room-actions-overflow"]');
  await client.tapCurrent('[data-testid="overflow-open-room-settings"]');
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'for-you-preferences',
    source: forYouSource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('settings-for-you-owner');
      const member = await fixtures.account('settings-for-you-member');
      const room = await fixtures.createRoom(owner, {
        name: `Mobile For you ${resources.roomName('settings-for-you')}`,
        preset: 'private_chat',
        invite: [member.userId],
      });
      await fixtures.join(member, room.id);
      assert.equal(
        await fixtures.roomMembership(owner, room.id, member),
        'join',
        'ordinary member fixture joined the private room',
      );

      await client.login(member);
      await recordReadOnlyWebviewSession(client);
      await openRoom(client, room.name);
      await openRoomSettings(client);
      await observedElements(
        client,
        assertions.forYouSettingsVisible,
        '[data-testid="room-settings"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await observedElements(
        client,
        assertions.forYouDirectoryVisible,
        '[data-testid="room-settings-directory"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await client.tapCurrent('[data-testid="room-settings-tab-for-you"]');
      await observedElements(
        client,
        assertions.forYouFormVisible,
        '[data-testid="room-settings-for-you-form"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await observedElements(
        client,
        assertions.forYouMuteEnabled,
        '[data-testid="room-settings-notify-mute"] input[role="radio"]',
        (elements) =>
          elements.length === 1 && elements[0]!.visible && !elements[0]!.disabled,
      );
      await observedElements(
        client,
        assertions.forYouFavouriteEnabled,
        '[data-testid="room-settings-favourite"] input[role="checkbox"]',
        (elements) =>
          elements.length === 1 && elements[0]!.visible && !elements[0]!.disabled,
      );
      await client.tapCurrent('[data-testid="room-settings-notify-mute"]');
      await client.tapCurrent('[data-testid="room-settings-favourite"]');
      await client.tapCurrent('[data-testid="room-settings-mobile-back"]');
      await client.visible('[data-testid="alert-surface"]');
      await client.tapCurrent('[data-testid="alert-cancel"]');
      await observedValue(
        client,
        assertions.forYouMuteRetained,
        `document.querySelector('[data-testid="room-settings-notify-mute"] input')?.checked === true`,
        (value) => value === true,
      );
      await observedValue(
        client,
        assertions.forYouFavouriteRetained,
        `document.querySelector('[data-testid="room-settings-favourite"] input')?.checked === true`,
        (value) => value === true,
      );
      await client.scrollIntoViewIfNeeded(
        '[data-testid="room-settings-for-you-save"]',
        '[data-testid="room-settings-detail"]',
      );
      await client.tapCurrent('[data-testid="room-settings-for-you-save"]');
      await observedElements(
        client,
        assertions.forYouSavedFeedback,
        '[data-testid="room-settings-for-you-feedback"]',
        (elements) =>
          elements.length === 1 &&
          elements[0]!.visible &&
          elements[0]!.text ===
            'Notifications and favourite saved for the opening Account.',
      );
    },
  },
  {
    id: 'general-navigation-and-drafts',
    source: generalSource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('settings-general-owner');
      const room = await fixtures.createRoom(owner, {
        name: `Mobile settings ${resources.roomName('settings-general')}`,
        preset: 'private_chat',
      });

      await client.login(owner);
      await recordReadOnlyWebviewSession(client);
      await openRoom(client, room.name);
      await openRoomSettings(client);
      await observedElements(
        client,
        assertions.generalSettingsVisible,
        '[data-testid="room-settings"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      const surfaceGeometry = `(() => {
        const element = document.querySelector('[data-testid="room-settings"]');
        const viewport = window.visualViewport;
        if (!(element instanceof HTMLElement)) return null;
        const rect = element.getBoundingClientRect();
        return {
          surface: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom },
          viewport: { width: viewport?.width ?? innerWidth, height: viewport?.height ?? innerHeight },
        };
      })()`;
      await observedValue(
        client,
        assertions.generalFullWidth,
        surfaceGeometry,
        (value) => {
          const geometry = value as {
            readonly surface?: { readonly width?: number };
            readonly viewport?: { readonly width?: number };
          } | null;
          return (
            typeof geometry?.surface?.width === 'number' &&
            typeof geometry.viewport?.width === 'number' &&
            geometry.surface.width >= geometry.viewport.width - 1
          );
        },
      );
      await observedValue(
        client,
        assertions.generalFullHeight,
        surfaceGeometry,
        (value) => {
          const geometry = value as {
            readonly surface?: { readonly height?: number };
            readonly viewport?: { readonly height?: number };
          } | null;
          return (
            typeof geometry?.surface?.height === 'number' &&
            typeof geometry.viewport?.height === 'number' &&
            geometry.surface.height >= geometry.viewport.height - 1
          );
        },
      );
      await observedElements(
        client,
        assertions.generalDirectoryVisible,
        '[data-testid="room-settings-directory"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await observedElements(
        client,
        assertions.generalPanelInitiallyHidden,
        '[data-testid="room-settings-panel-general"]',
        (elements) => elements.length === 1 && !elements[0]!.visible,
      );
      await client.tapCurrent('[data-testid="room-settings-tab-general"]');
      await observedElements(
        client,
        assertions.generalPanelVisible,
        '[data-testid="room-settings-panel-general"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await observedValue(
        client,
        assertions.generalHeadingFocused,
        `document.activeElement?.getAttribute('data-testid')`,
        (value) => value === 'room-settings-section-heading',
      );
      await observedValue(
        client,
        assertions.generalAccountContained,
        `(() => {
          const surface = document.querySelector('[data-testid="room-settings"]')?.getBoundingClientRect();
          const account = document.querySelector('[data-testid="room-settings-account"]')?.getBoundingClientRect();
          return surface && account ? { surfaceRight: surface.right, accountRight: account.right } : null;
        })()`,
        (value) => {
          const geometry = value as {
            readonly surfaceRight?: number;
            readonly accountRight?: number;
          } | null;
          return (
            typeof geometry?.surfaceRight === 'number' &&
            typeof geometry.accountRight === 'number' &&
            geometry.accountRight <= geometry.surfaceRight
          );
        },
      );
      await observedElements(
        client,
        assertions.generalPristineActionsHidden,
        '[data-testid="room-settings-general-actions"]',
        (elements) => elements.length === 0,
      );
      await client.fill('[data-testid="room-settings-topic"]', 'A mobile draft');
      await observedElements(
        client,
        assertions.generalDraftActionsVisible,
        '[data-testid="room-settings-general-actions"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await observedValue(
        client,
        assertions.generalActionsSticky,
        `(() => {
          const element = document.querySelector('[data-testid="room-settings-general-actions"]');
          return element instanceof HTMLElement && getComputedStyle(element).position === 'sticky';
        })()`,
        (value) => value === true,
      );
      await observedElements(
        client,
        assertions.generalDiscardVisible,
        '[data-testid="room-settings-discard"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await observedElements(
        client,
        assertions.generalSaveVisible,
        '[data-testid="room-settings-save"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await client.tapCurrent('[data-testid="room-settings-mobile-back"]');
      await client.visible('[data-testid="alert-surface"]');
      await client.tapCurrent('[data-testid="alert-cancel"]');
      await observedValue(
        client,
        assertions.generalDraftRetained,
        `document.querySelector('[data-testid="room-settings-topic"]')?.value`,
        (value) => value === 'A mobile draft',
      );
      await client.tapCurrent('[data-testid="room-settings-mobile-back"]');
      await client.visible('[data-testid="alert-surface"]');
      await client.tapCurrent('[data-testid="alert-confirm"]');
      await observedElements(
        client,
        assertions.generalDiscardDirectoryVisible,
        '[data-testid="room-settings-directory"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await observedValue(
        client,
        assertions.generalRoomNameContained,
        `(() => {
          const surface = document.querySelector('[data-testid="room-settings"]')?.getBoundingClientRect();
          const name = document.querySelector('[data-testid="room-settings-room-name"]')?.getBoundingClientRect();
          return surface && name ? { surfaceRight: surface.right, nameRight: name.right } : null;
        })()`,
        (value) => {
          const geometry = value as {
            readonly surfaceRight?: number;
            readonly nameRight?: number;
          } | null;
          return (
            typeof geometry?.surfaceRight === 'number' &&
            typeof geometry.nameRight === 'number' &&
            geometry.nameRight <= geometry.surfaceRight
          );
        },
      );
      await observedElements(
        client,
        assertions.generalTabTouchTarget,
        '[data-testid="room-settings-tab-general"]',
        (elements) =>
          elements.length === 1 && elements[0]!.rect.height >= 44,
      );
      await observedElements(
        client,
        assertions.addressesTabTouchTarget,
        '[data-testid="room-settings-tab-addresses"]',
        (elements) =>
          elements.length === 1 && elements[0]!.rect.height >= 44,
      );
      await client.tapCurrent('[data-testid="room-settings-tab-access"]');
      await observedElements(
        client,
        assertions.accessPanelVisible,
        '[data-testid="room-settings-panel-access"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await observedValue(
        client,
        assertions.accessHeadingFocused,
        `document.activeElement?.getAttribute('data-testid')`,
        (value) => value === 'room-settings-section-heading',
      );
      await observedElements(
        client,
        assertions.accessActionsHidden,
        '[data-testid="room-settings-access-actions"]',
        (elements) => elements.length === 0,
      );
      await client.tapCurrent('[data-testid="room-settings-mobile-back"]');
      await observedElements(
        client,
        assertions.accessBackDirectoryVisible,
        '[data-testid="room-settings-directory"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await client.tapCurrent('[data-testid="room-settings-tab-general"]');
      await observedElements(
        client,
        assertions.generalReopenedVisible,
        '[data-testid="room-settings-panel-general"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await client.tapCurrent('[data-testid="room-settings-cancel"]');
      await observedElements(
        client,
        assertions.generalSettingsClosed,
        '[data-testid="room-settings"]',
        (elements) => elements.length === 0,
      );
      await observedElements(
        client,
        assertions.generalComposerVisible,
        '[data-testid="composer-input"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
    },
  },
];

assert.equal(
  cases.length,
  2,
  'Exactly two mobile Room Settings stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  33,
  'Exactly thirty-three direct assertions are required',
);

void test(
  'Android mobile Room Settings journeys',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-settings-mobile',
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
          'Redact mobile Room Settings diagnostics',
          () => redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Mobile Room Settings Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Mobile Room Settings Android WebView',
          async () => client?.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
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
          console.info(`[room-settings-mobile] ${entry.id} start`);
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
            await save();
            console.info(
              `[room-settings-mobile] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Mobile Room Settings journey ${entry.id} failed`,
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
