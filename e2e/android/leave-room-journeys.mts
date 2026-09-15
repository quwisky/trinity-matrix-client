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
  type AccountWorkspaceCaseContext,
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

const source =
  'e2e/browser/journeys/room-library/leave-room.spec.mts:79-110';

const assertions = {
  leaveRowVisible: 'setup.leave-row-visible',
  keepRowVisible: 'setup.keep-row-visible',
  leaveActionVisible: 'menu.leave-action-visible',
  confirmVisible: 'dialog.confirm-visible',
  leftAbsent: 'list.left-absent',
  keepVisible: 'list.keep-visible',
} as const;

const ROOM_COUNT = 2;

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
    id: 'leave-room',
    source,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context: AccountWorkspaceCaseContext) {
      const { client, fixtures, resources } = context;
      const reader = await fixtures.account('leave-room-reader');
      const leaveRoom = await fixtures.createRoom(reader, {
        name: `Leave Me ${resources.roomName('leave-room')}`,
        preset: 'private_chat',
      });
      const keepRoom = await fixtures.createRoom(reader, {
        name: `Keep Me ${resources.roomName('keep-room')}`,
        preset: 'private_chat',
      });

      await client.login(reader);
      await assertExactRoomsRoute(client, reader.username);
      await client.tapCurrent('[data-testid="rail-rooms"]');
      await observedElements(
        client,
        assertions.leaveRowVisible,
        '.channel__name',
        (elements) => elements.length === 1 && elements[0]!.visible,
        { exactText: leaveRoom.name },
      );
      await observedElements(
        client,
        assertions.keepRowVisible,
        '.channel__name',
        (elements) => elements.length === 1 && elements[0]!.visible,
        { exactText: keepRoom.name },
      );

      const menuSelector = `[aria-label=${JSON.stringify(
        `Options for ${leaveRoom.name}`,
      )}]`;
      await client.tapCurrent(menuSelector);
      await observedElements(
        client,
        assertions.leaveActionVisible,
        '[data-testid="room-leave"]',
        (elements) =>
          elements.length === 1 &&
          elements[0]!.visible &&
          elements[0]!.text === 'Leave room',
        { exactText: 'Leave room' },
        10_000,
      );
      await client.tapCurrent('[data-testid="room-leave"]');
      await observedElements(
        client,
        assertions.confirmVisible,
        '[data-testid="alert-confirm"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
        {},
        10_000,
      );
      await client.tapCurrent('[data-testid="alert-confirm"]');

      await observedElements(
        client,
        assertions.leftAbsent,
        '.channel__name',
        (elements) => elements.length === 0,
        { exactText: leaveRoom.name },
      );
      await observedElements(
        client,
        assertions.keepVisible,
        '.channel__name',
        (elements) => elements.length === 1 && elements[0]!.visible,
        { exactText: keepRoom.name },
      );
    },
  },
];

assert.equal(cases.length, 1, 'Exactly one leave-room stage is required');
assert.equal(
  Object.keys(assertions).length,
  6,
  'Exactly six direct assertions are required',
);
assert.equal(ROOM_COUNT, 2, 'The functional predecessor requires two rooms');

void test(
  'Android leave-room journey',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'leave-room',
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
        matrixResources.cleanup('Redact leave-room diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Leave-room Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Leave-room Android WebView',
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
          console.info(`[leave-room] ${entry.id} start`);
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
              `[leave-room] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Leave-room journey ${entry.id} failed`,
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
