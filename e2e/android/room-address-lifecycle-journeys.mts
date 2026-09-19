import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSession } from '../support/session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  AccountWorkspaceClient,
  DESKTOP_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountElementFilter,
  type AccountWorkspaceCase,
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import { installFirstMatrixHttpFailure } from './matrix-http-fault.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';
import {
  ROOM_ADDRESS_LIFECYCLE_SOURCES,
  roomAddressLifecycleAssertions as assertions,
  type RoomAddressLifecycleAssertion,
} from './room-address-lifecycle-contract.mts';

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

const visibleOne = (elements: readonly AccountElement[]): boolean =>
  elements.length === 1 && elements[0]!.visible;

async function observedElements(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomAddressLifecycleAssertion,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: AccountElementFilter = {},
  timeoutMs = 30_000,
): Promise<readonly AccountElement[]> {
  let observation: readonly AccountElement[] | null = null;
  let value: readonly AccountElement[];
  try {
    value = await waitForNativeShellState(
      async () => {
        const latest = await client.elements(selector, filter);
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

async function observedServerValue<T>(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomAddressLifecycleAssertion,
  observe: () => Promise<T>,
  accepts: (value: T) => boolean,
): Promise<T> {
  let observation: T | undefined;
  let value: T;
  try {
    value = await waitForNativeShellState(
      async () => {
        const latest = await observe();
        observation = latest;
        return latest;
      },
      accepts,
      assertionIdentity,
      client.signal,
      30_000,
    );
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await client.record(assertionIdentity, {
        assertion: assertionIdentity,
        observation: observation ?? null,
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
    observation: value ?? null,
  });
  return value;
}

async function focusByNativeTab(
  client: AccountWorkspaceClient,
  selector: string,
  filter: AccountElementFilter = {},
): Promise<AccountElement> {
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const elements = await client.elements(selector, filter);
    if (visibleOne(elements) && elements[0]!.focused) return elements[0]!;
    await client.key('tab');
  }
  const elements = await client.elements(selector, filter);
  assert(
    visibleOne(elements) && elements[0]!.focused,
    `Native Tab did not focus ${selector}`,
  );
  return elements[0]!;
}

async function exactFeedbackDuringNativeAction(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomAddressLifecycleAssertion,
  message: string,
  action: () => Promise<void>,
): Promise<readonly string[]> {
  const capture = '__trinityRoomAddressFeedback';
  await evaluateNative(client.webview, `(() => {
    const capture = ${JSON.stringify(capture)};
    window[capture]?.observer?.disconnect();
    const messages = [];
    const sample = () => {
      for (const element of document.querySelectorAll('[data-sonner-toast]')) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width <= 0 || rect.height <= 0 || style.visibility !== 'visible') continue;
        const text = element.textContent?.trim() ?? '';
        if (text && !messages.includes(text)) messages.push(text);
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    window[capture] = { messages, observer };
    sample();
    return true;
  })()`);
  const failures: unknown[] = [];
  let messages: readonly string[] = [];
  try {
    await action();
    messages = await waitForNativeShellState(
      async () => {
        const value = await evaluateNative(
          client.webview,
          `window[${JSON.stringify(capture)}]?.messages ?? []`,
        );
        assert(
          Array.isArray(value) &&
            value.every((entry) => typeof entry === 'string'),
          `${assertionIdentity}: captured feedback must be text`,
        );
        return value as string[];
      },
      (observed) => observed.includes(message),
      assertionIdentity,
      client.signal,
      15_000,
    );
  } catch (error) {
    failures.push(error);
    try {
      await client.record(assertionIdentity, {
        assertion: assertionIdentity,
        message,
        observation: messages,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
  } finally {
    try {
      await evaluateNative(client.webview, `(() => {
        const capture = ${JSON.stringify(capture)};
        window[capture]?.observer?.disconnect();
        delete window[capture];
        return true;
      })()`);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(
      failures,
      `${assertionIdentity}: feedback capture failed`,
    );
  }
  return messages;
}

interface SettingsGeometry {
  readonly surface: { readonly right: number };
  readonly viewport: { readonly width: number };
}

async function observedSettingsGeometry(
  client: AccountWorkspaceClient,
): Promise<void> {
  let observation: unknown;
  try {
    const geometry = await waitForNativeShellState(
      async () => {
        const latest = await evaluateNative(client.webview, `(() => {
          const element = document.querySelector('[data-testid="room-settings"]');
          if (!(element instanceof HTMLElement)) return null;
          const rect = element.getBoundingClientRect();
          return {
            surface: { right: rect.right },
            viewport: { width: innerWidth },
          };
        })()`);
        observation = latest;
        return latest as SettingsGeometry | null;
      },
      (geometry) =>
        geometry !== null &&
        geometry.surface.right <= geometry.viewport.width,
      assertions.settingsWithinViewport,
      client.signal,
      15_000,
    );
    await client.record(assertions.settingsWithinViewport, {
      assertion: assertions.settingsWithinViewport,
      observation: geometry,
    });
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await client.record(assertions.settingsWithinViewport, {
        assertion: assertions.settingsWithinViewport,
        observation,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
    throw new AggregateError(
      failures,
      `${assertions.settingsWithinViewport}: ${describeFailure(error)}`,
    );
  }
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'address-lifecycle',
    source: ROOM_ADDRESS_LIFECYCLE_SOURCES.definition,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources, signal }) {
      const owner = await fixtures.account('room-address-owner');
      const runId = resources.aliasLocalpart('ral');
      const room = await fixtures.createRoom(owner, {
        name: `Address ${resources.roomName('room-address')}`,
        preset: 'private_chat',
      });
      const localpart = `addr-${runId}`;
      const alias = `#${localpart}:localhost`;
      const retryLocalpart = `retry-${runId}`;
      const retryAlias = `#${retryLocalpart}:localhost`;
      const row = '[data-testid="room-alias"]';
      const alert = '[data-testid="alert-surface"]';

      await client.login(owner);
      await client.tapCurrent('[data-testid="rail-rooms"]');
      await client.visible('.channel', { text: room.name }, 30_000);
      await client.tapCurrent('.channel', { text: room.name });
      await observedElements(
        client,
        assertions.roomTimelineVisible,
        '[data-testid="composer-input"]',
        visibleOne,
      );
      await client.tapCurrent('[data-testid="open-room-settings"]');
      await client.visible('[data-testid="room-settings"]');
      await client.tapCurrent('[data-testid="room-settings-tab-addresses"]');
      await observedElements(
        client,
        assertions.addressesPanelVisible,
        '[data-testid="room-settings-panel-addresses"]',
        visibleOne,
      );
      await observedElements(
        client,
        assertions.panelVisible,
        '[data-testid="room-aliases"]',
        visibleOne,
      );

      await client.fill('[data-testid="room-alias-input"]', localpart);
      await client.focused('[data-testid="room-alias-input"]');
      await client.key('enter');
      await observedElements(
        client,
        assertions.rowVisible,
        row,
        visibleOne,
        { text: alias },
      );
      await observedServerValue(
        client,
        assertions.directoryResolves,
        () => fixtures.resolveRoomAlias(owner, alias),
        (roomId) => roomId === room.id,
      );

      await focusByNativeTab(
        client,
        '[data-testid="room-alias-set-main"]',
      );
      await client.key('enter');
      await observedElements(
        client,
        assertions.primaryVisible,
        `${row} [data-testid="room-alias-main"]`,
        visibleOne,
        { exactText: 'Primary' },
      );
      await observedServerValue(
        client,
        assertions.canonicalState,
        () =>
          fixtures.roomState(
            owner,
            room.id,
            'm.room.canonical_alias',
          ),
        (value) => value?.['alias'] === alias,
      );
      await observedSettingsGeometry(client);
      await observedElements(
        client,
        assertions.primaryToastHidden,
        '[aria-label="Notifications alt+T"] [data-sonner-toast]',
        (elements) => elements.length === 0,
        { exactText: `${alias} is now the primary address.` },
        5_000,
      );

      await client.tapCurrent('[data-testid="room-alias-remove"]');
      await observedElements(
        client,
        assertions.removeJoiningEffect,
        alert,
        visibleOne,
        {
          text: `People will no longer be able to join or link to this room with ${alias}.`,
        },
      );
      await observedElements(
        client,
        assertions.removeRoomRetained,
        alert,
        visibleOne,
        { text: 'This does not delete the Room.' },
      );
      await client.tapCurrent('[data-testid="alert-cancel"]');
      await observedElements(
        client,
        assertions.cancelKeepsRow,
        row,
        visibleOne,
        { text: alias },
      );

      await client.tapCurrent('[data-testid="room-alias-remove"]');
      await focusByNativeTab(client, '[data-testid="alert-confirm"]');
      await client.key('enter');
      await observedElements(
        client,
        assertions.rowRemoved,
        row,
        (elements) => elements.length === 0,
        { text: alias },
      );
      await observedServerValue(
        client,
        assertions.directoryRemoved,
        () => fixtures.resolveRoomAlias(owner, alias),
        (roomId) => roomId === undefined,
      );
      await observedServerValue(
        client,
        assertions.canonicalCleared,
        () =>
          fixtures.roomState(
            owner,
            room.id,
            'm.room.canonical_alias',
          ),
        (value) => typeof value?.['alias'] !== 'string',
      );

      const connection = await client.webview.openSession();
      const fault = await installFirstMatrixHttpFailure(connection, {
        kind: 'room-alias',
        alias: retryAlias,
        status: 500,
        responseError: 'retry me',
      });
      const faultFailures: unknown[] = [];
      try {
        await client.fill(
          '[data-testid="room-alias-input"]',
          retryLocalpart,
        );
        await client.focused('[data-testid="room-alias-input"]');
        const messages = await exactFeedbackDuringNativeAction(
          client,
          assertions.rejectedToastVisible,
          `Could not add ${retryAlias}.`,
          () => client.key('enter'),
        );
        const attempts = await fault.waitForAttempts(1, signal);
        assert.equal(attempts, 1, 'exact rejected alias transport attempt');
        const firstOutcome = await waitForNativeShellState(
          async () => fault.firstOutcome,
          (outcome) =>
            outcome?.responseStatus === 500 &&
            outcome.bodyMatchesInjected === true,
          assertions.rejectedToastVisible,
          signal,
          15_000,
        );
        await client.record(assertions.rejectedToastVisible, {
          assertion: assertions.rejectedToastVisible,
          message: `Could not add ${retryAlias}.`,
          observation: messages,
          transport: { attempts, firstOutcome },
        });
      } catch (error) {
        faultFailures.push(error);
      } finally {
        try {
          await fault.close();
        } catch (error) {
          faultFailures.push(error);
        }
        try {
          connection.close();
        } catch (error) {
          faultFailures.push(error);
        }
      }
      if (faultFailures.length === 1) throw faultFailures[0];
      if (faultFailures.length) {
        throw new AggregateError(
          faultFailures,
          'Room address rejected-add transport failed',
        );
      }
      await observedElements(
        client,
        assertions.retryDraftRetained,
        '[data-testid="room-alias-input"]',
        (elements) =>
          visibleOne(elements) && elements[0]!.value === retryLocalpart,
      );
    },
  },
];

assert.equal(
  cases.length,
  1,
  'Exactly one Room address lifecycle stage is required',
);
assert.equal(
  Object.keys(assertions).length,
  17,
  'Exactly 17 Room address lifecycle assertions are required',
);

void test(
  'Android Room address lifecycle journey',
  { timeout: 600_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-address-lifecycle',
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
        matrixResources.cleanup('Redact Room address lifecycle diagnostics', () =>
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
        matrixResources.cleanup('Room address lifecycle Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Room address lifecycle Android WebView',
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
          console.info(`[room-address-lifecycle] ${entry.id} start`);
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
            await save();
            console.info(
              `[room-address-lifecycle] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Room address lifecycle journey ${entry.id} failed`,
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
