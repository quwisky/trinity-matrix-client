import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { readSession } from '../support/session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { installAccountBadgeRecorder } from './account-badge-recorder.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  AccountWorkspaceClient,
  PIXEL_5_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountWorkspaceCase,
  type AccountWorkspaceCaseContext,
} from './account-workspace-client.mts';
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

const sources = {
  rail: 'e2e/browser/journeys/room-library/unread-badges.spec.mts:133-160',
  platform:
    'e2e/browser/journeys/room-library/unread-badges.spec.mts:162-186',
} as const;

const assertions = {
  railBadgeVisible: 'rail.badge-visible',
  railBadgePositiveCount: 'rail.badge-positive-count',
  platformBadgeSetThree: 'platform.badge-set-three',
  platformBadgeClearZero: 'platform.badge-clear-zero',
} as const;

const UNREAD_SEED = 3;

interface SeededRoom {
  readonly reader: NodeWorkspaceAccount;
  readonly room: WorkspaceRoom;
}

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

async function seedUnreadRoom(
  context: AccountWorkspaceCaseContext,
  id: string,
): Promise<SeededRoom> {
  const { fixtures, resources } = context;
  const reader = await fixtures.account(`${id}-reader`);
  const sender = await fixtures.account(`${id}-sender`);
  const room = await fixtures.createRoom(reader, {
    name: `Unread E2E ${resources.roomName(id)}`,
    preset: 'private_chat',
    invite: [sender.userId],
  });
  await fixtures.join(sender, room.id);
  for (let index = 0; index < UNREAD_SEED; index += 1) {
    await fixtures.sendMessage(
      sender,
      room.id,
      `unread ${index} ${resources.roomName('message')}`,
      `${id}-${index}`,
    );
  }
  return { reader, room };
}

async function waitForRoom(
  client: AccountWorkspaceClient,
  roomName: string,
): Promise<void> {
  await observedElements(
    client,
    'setup.room-visible',
    '.channel__name',
    (elements) =>
      elements.length === 1 &&
      elements[0]!.visible &&
      elements[0]!.text === roomName,
    { exactText: roomName },
  );
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'aggregate-rail-badge',
    source: sources.rail,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client } = context;
      const { reader } = await seedUnreadRoom(context, 'aggregate-rail-badge');
      await client.login(reader);
      await assertExactRoomsRoute(client, reader.username);

      const badge = await observedElements(
        client,
        assertions.railBadgeVisible,
        'trn-server-rail .item:has([data-testid="rail-rooms"]) .badge',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      const text = badge[0]!.text;
      let failure: unknown;
      try {
        assert.match(text, /^\d+\+?$/, assertions.railBadgePositiveCount);
        assert(
          Number.parseInt(text, 10) > 0,
          assertions.railBadgePositiveCount,
        );
      } catch (error) {
        failure = error;
      }
      await client.record(assertions.railBadgePositiveCount, {
        assertion: assertions.railBadgePositiveCount,
        expectedPreferred: UNREAD_SEED,
        observation: text,
        fallbackAccepted: text !== String(UNREAD_SEED),
        error: failure === undefined ? undefined : describeFailure(failure),
      });
      if (failure !== undefined) throw failure;
    },
  },
  {
    id: 'platform-badge',
    source: sources.platform,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client } = context;
      const { reader, room } = await seedUnreadRoom(context, 'platform-badge');
      const recorder = await installAccountBadgeRecorder(client);
      let failure: unknown;
      try {
        await client.reload();
        await client.login(reader);
        await assertExactRoomsRoute(client, reader.username);
        const setCount = await waitForNativeShellState(
          () => recorder.count(),
          (count) => count === UNREAD_SEED,
          assertions.platformBadgeSetThree,
          client.signal,
          30_000,
        );
        await client.record(assertions.platformBadgeSetThree, {
          assertion: assertions.platformBadgeSetThree,
          count: setCount,
          calls: await recorder.calls(),
        });

        await client.tapCurrent('[data-testid="rail-rooms"]');
        await waitForRoom(client, room.name);
        await client.tapCurrent('.channel', { text: room.name });
        const clearedCount = await waitForNativeShellState(
          () => recorder.count(),
          (count) => count === 0,
          assertions.platformBadgeClearZero,
          client.signal,
          15_000,
        );
        await client.record(assertions.platformBadgeClearZero, {
          assertion: assertions.platformBadgeClearZero,
          count: clearedCount,
          calls: await recorder.calls(),
        });
      } catch (error) {
        failure = error;
      } finally {
        try {
          await recorder.close();
        } catch (error) {
          if (failure !== undefined) {
            throw new AggregateError(
              [failure, error],
              'Badge assertion and recorder cleanup failed',
            );
          }
          throw error;
        }
      }
      if (failure !== undefined) throw failure;
    },
  },
];

assert.equal(
  cases.length,
  2,
  'Exactly two unread-badge stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  4,
  'Exactly four direct assertions are required',
);

void test(
  'Android unread-badge journeys',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'unread-badges',
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
        matrixResources.cleanup('Redact unread-badge diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Unread-badge Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Unread-badge Android WebView',
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
          console.info(`[unread-badges] ${entry.id} start`);
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
              `[unread-badges] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Unread-badge journey ${entry.id} failed`,
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
