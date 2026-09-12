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
import { ANDROID_KEYCODES } from './maestro-keyboard.mts';

const source =
  'e2e/browser/journeys/room-library/sidebar-touch.spec.mts:32-164';
const assertions = {
  mediaProfile: 'touch.media-profile',
  menuVisible: 'account-menu.visible',
  menuSwitchCopy: 'account-menu.switch-account-copy',
  menuAddCopy: 'account-menu.add-account-copy',
  menuRemoveCopy: 'account-menu.remove-account-copy',
  menuViewport: 'account-menu.within-viewport',
  menuFocus: 'account-menu.escape-focus-restored',
  dockPosition: 'identity-dock.position',
  dockDisplay: 'identity-dock.display',
  dockFlow: 'identity-dock.flow',
  railWidth: 'touch-target.rail-rooms.width',
  railHeight: 'touch-target.rail-rooms.height',
  triggerWidth: 'touch-target.user-menu-trigger.width',
  triggerHeight: 'touch-target.user-menu-trigger.height',
  settingsWidth: 'touch-target.open-settings.width',
  settingsHeight: 'touch-target.open-settings.height',
  roomHeight: 'room-row.height',
  roomMenuOpacity: 'room-menu.opacity',
  roomMenuWidth: 'room-menu.width',
  roomMenuHeight: 'room-menu.height',
  roomMenuVisible: 'room-menu.low-priority-visible',
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
  timeoutMs = 15_000,
): Promise<readonly AccountElement[]> {
  try {
    const elements = await client.waitElements(
      selector,
      accepts,
      assertion,
      {},
      timeoutMs,
    );
    await client.record(assertion, { assertion, observation: elements });
    return elements;
  } catch (error) {
    const failures: unknown[] = [error];
    let observation: readonly AccountElement[] | null = null;
    try {
      observation = await client.elements(selector);
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

async function observedValue<T>(
  client: AccountWorkspaceClient,
  assertion: string,
  expression: string,
  accepts: (value: T) => boolean,
  timeoutMs = 15_000,
): Promise<T> {
  try {
    const value = await waitForNativeShellState(
      async () => (await evaluateNative(client.webview, expression)) as T,
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

async function assertMinimumDimension(
  client: AccountWorkspaceClient,
  selector: string,
  assertion: string,
  dimension: 'width' | 'height',
  filter: { readonly text?: string } = {},
): Promise<void> {
  try {
    const elements = await client.waitElements(
      selector,
      (values) =>
        values.length === 1 &&
        values[0]!.visible &&
        values[0]!.rect[dimension] >= 44,
      assertion,
      filter,
    );
    await client.record(assertion, {
      assertion,
      minimum: 44,
      observation: elements[0]!.rect[dimension],
    });
    assert(elements[0]!.rect[dimension] >= 44, assertion);
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
        dimension,
        minimum: 44,
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

async function assertExactRoomsRoute(
  client: AccountWorkspaceClient,
  username: string,
): Promise<void> {
  const surface = await waitForNativeShellState(
    () => client.surface(),
    (value) => {
      const url = new URL(value.url);
      return (
        url.pathname === '/rooms' &&
        url.searchParams.get('account') === `@${username}:localhost`
      );
    },
    'exact account-qualified /rooms pathname',
    client.signal,
    60_000,
  );
  await client.record('login.rooms-route', {
    assertion: 'login.rooms-route',
    pathname: new URL(surface.url).pathname,
    account: new URL(surface.url).searchParams.get('account'),
  });
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'sidebar-touch-targets',
    source,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('sidebar-touch-reader');
      const roomName = `Touch ${resources.roomName('sidebar-touch')}`;
      await fixtures.createRoom(reader, {
        name: roomName,
        preset: 'private_chat',
      });

      await client.login(reader);
      await assertExactRoomsRoute(client, reader.username);

      const media = await observedValue<{
        readonly noHover: boolean;
        readonly coarsePointer: boolean;
      }>(
        client,
        assertions.mediaProfile,
        `({
          noHover: matchMedia('(hover: none)').matches,
          coarsePointer: matchMedia('(pointer: coarse)').matches
        })`,
        (value) => value.noHover && value.coarsePointer,
      );
      assert.deepEqual(media, { noHover: true, coarsePointer: true });

      await client.tapCurrent('[data-testid="user-menu-trigger"]');
      await observedElements(
        client,
        assertions.menuVisible,
        '.account-menu[role="menu"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await observedElements(
        client,
        assertions.menuSwitchCopy,
        '.account-menu[role="menu"]',
        (elements) =>
          elements.length === 1 && elements[0]!.text.includes('Switch account'),
      );
      await observedElements(
        client,
        assertions.menuAddCopy,
        '[data-testid="add-account"]',
        (elements) =>
          elements.length === 1 && elements[0]!.text.includes('Add account'),
      );
      await observedElements(
        client,
        assertions.menuRemoveCopy,
        '[data-testid="logout"]',
        (elements) =>
          elements.length === 1 &&
          elements[0]!.text.includes('Remove account from this device'),
      );
      await observedValue<{ readonly withinViewport: boolean }>(
        client,
        assertions.menuViewport,
        `(() => {
          const element = document.querySelector('.account-menu[role="menu"]');
          if (!element) return { withinViewport: false };
          const box = element.getBoundingClientRect();
          return { withinViewport:
            box.top >= 0 && box.left >= 0 &&
            box.bottom <= innerHeight && box.right <= innerWidth };
        })()`,
        (value) => value.withinViewport,
      );
      await client.capture('account-menu-mobile');

      await client.key('escape');
      await client.record('account-menu.escape-native-dispatch', {
        assertion: 'account-menu.escape-native-dispatch',
        key: 'escape',
        keycode: ANDROID_KEYCODES.escape,
        completed: true,
      });
      await observedElements(
        client,
        assertions.menuFocus,
        '[data-testid="user-menu-trigger"]',
        (elements) => elements.length === 1 && elements[0]!.focused,
      );

      await observedValue<string>(
        client,
        assertions.dockPosition,
        `getComputedStyle(document.querySelector('trn-sidebar-user-panel')).position`,
        (value) => value === 'static',
      );
      await observedValue<string>(
        client,
        assertions.dockDisplay,
        `getComputedStyle(document.querySelector('trn-sidebar-user-panel')).display`,
        (value) => value === 'block',
      );
      await observedValue<boolean>(
        client,
        assertions.dockFlow,
        `(() => {
          const scroller = document.querySelector('.sidebar__scroll');
          const dock = document.querySelector('.userbar');
          if (!scroller || !dock) throw new Error('missing mobile identity dock');
          return scroller.getBoundingClientRect().bottom <=
            dock.getBoundingClientRect().top + 1;
        })()`,
        (value) => value,
      );

      await assertMinimumDimension(
        client,
        '[data-testid="rail-rooms"]',
        assertions.railWidth,
        'width',
      );
      await assertMinimumDimension(
        client,
        '[data-testid="rail-rooms"]',
        assertions.railHeight,
        'height',
      );
      await assertMinimumDimension(
        client,
        '[data-testid="user-menu-trigger"]',
        assertions.triggerWidth,
        'width',
      );
      await assertMinimumDimension(
        client,
        '[data-testid="user-menu-trigger"]',
        assertions.triggerHeight,
        'height',
      );
      await assertMinimumDimension(
        client,
        '[data-testid="open-settings"]',
        assertions.settingsWidth,
        'width',
      );
      await assertMinimumDimension(
        client,
        '[data-testid="open-settings"]',
        assertions.settingsHeight,
        'height',
      );

      await client.tapCurrent('[data-testid="rail-rooms"]');
      await observedElements(
        client,
        'setup.room-row-visible',
        '.channel-row',
        (elements) =>
          elements.length === 1 &&
          elements[0]!.visible &&
          elements[0]!.text.includes(roomName),
        30_000,
      );
      await assertMinimumDimension(
        client,
        '.channel',
        assertions.roomHeight,
        'height',
        { text: roomName },
      );
      await observedElements(
        client,
        assertions.roomMenuOpacity,
        '.channel__menu',
        (elements) =>
          elements.length === 1 && Number(elements[0]!.style.opacity) === 1,
        10_000,
      );
      await assertMinimumDimension(
        client,
        '.channel__menu',
        assertions.roomMenuWidth,
        'width',
      );
      await assertMinimumDimension(
        client,
        '.channel__menu',
        assertions.roomMenuHeight,
        'height',
      );
      await client.tapCurrent('.channel__menu');
      await observedElements(
        client,
        assertions.roomMenuVisible,
        '[data-testid="room-low-priority"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
        10_000,
      );
    },
  },
];

assert.equal(cases.length, 1, 'Exactly one sidebar touch stage is required');
assert.equal(Object.keys(assertions).length, 21, 'Exactly 21 direct assertions are required');

void test(
  'Android sidebar touch journeys',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'sidebar-touch',
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
        matrixResources.cleanup('Redact sidebar touch diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Sidebar touch Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Sidebar touch Android WebView',
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
          console.info(`[sidebar-touch] ${entry.id} start`);
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
            if (failures.length)
              stage.error = failures.map(describeFailure).join('\n');
            await save();
            console.info(
              `[sidebar-touch] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length)
            throw new AggregateError(
              failures,
              `Sidebar touch journey ${entry.id} failed`,
            );
        }
        assert.equal(
          stages.filter((stage) => stage.status === 'passed').length,
          cases.length,
        );
      },
    );
  },
);
