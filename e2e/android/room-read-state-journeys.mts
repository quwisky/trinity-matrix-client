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
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import { waitForNativeShellState } from './native-shell-client.mts';

const sources = {
  markAll:
    'e2e/browser/journeys/room-library/mark-read.spec.mts:48-102',
  local:
    'e2e/browser/journeys/room-library/mark-unread.spec.mts:29-103',
  remote:
    'e2e/browser/journeys/room-library/mark-unread.spec.mts:105-180',
} as const;

const assertions = {
  markAllRoomVisible: 'mark-all.room-visible',
  markAllActionVisible: 'mark-all.action-visible',
  markAllActionHidden: 'mark-all.action-hidden',
  localInitialFlagAbsent: 'local.initial-flag-absent',
  localInitialBadgeAbsent: 'local.initial-badge-absent',
  localFlagRoundTrip: 'local.flag-round-trip',
  localDotVisible: 'local.dot-visible',
  localDotEmpty: 'local.dot-empty',
  localConversationVisible: 'local.conversation-visible',
  localFlagCleared: 'local.flag-cleared',
  localDotCleared: 'local.dot-cleared',
  remoteInitialBadgeAbsent: 'remote.initial-badge-absent',
  remoteWriteAccepted: 'remote.write-accepted',
  remoteLiveDotVisible: 'remote.live-dot-visible',
  remoteReloadDotVisible: 'remote.reload-dot-visible',
  remoteFlagCleared: 'remote.flag-cleared',
  remoteDotCleared: 'remote.dot-cleared',
} as const;

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
  timeoutMs = 15_000,
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

async function assertVisible(
  client: AccountWorkspaceClient,
  assertion: string,
  selector: string,
  filter: { readonly text?: string; readonly exactText?: string } = {},
  timeoutMs = 15_000,
): Promise<AccountElement> {
  const elements = await observedElements(
    client,
    assertion,
    selector,
    (matches) => matches.length === 1 && matches[0]!.visible,
    filter,
    timeoutMs,
  );
  return elements[0]!;
}

async function assertCount(
  client: AccountWorkspaceClient,
  assertion: string,
  selector: string,
  expected: number,
  timeoutMs = 15_000,
): Promise<void> {
  await observedElements(
    client,
    assertion,
    selector,
    (elements) =>
      elements.length === expected &&
      elements.every((element) => element.visible),
    {},
    timeoutMs,
  );
}

async function assertEmptyText(
  client: AccountWorkspaceClient,
  assertion: string,
  selector: string,
  timeoutMs = 15_000,
): Promise<void> {
  await observedElements(
    client,
    assertion,
    selector,
    (elements) =>
      elements.length === 1 &&
      elements[0]!.visible &&
      elements[0]!.text === '',
    {},
    timeoutMs,
  );
}

async function assertInitialFlagAbsent(
  context: AccountWorkspaceCaseContext,
  assertion: string,
  reader: NodeWorkspaceAccount,
  roomId: string,
): Promise<void> {
  const value = await context.fixtures.markedUnread(reader, roomId);
  await context.client.record(assertion, { assertion, value });
  assert.equal(value, undefined, assertion);
}

async function assertFlag(
  context: AccountWorkspaceCaseContext,
  assertion: string,
  reader: NodeWorkspaceAccount,
  roomId: string,
  expected: boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const value = await waitForNativeShellState(
    () => context.fixtures.markedUnread(reader, roomId),
    (flag) => flag === expected,
    assertion,
    context.signal,
    timeoutMs,
  );
  await context.client.record(assertion, { assertion, value });
  assert.equal(value, expected, assertion);
}

async function seedEmptyRoom(
  context: AccountWorkspaceCaseContext,
  id: string,
  prefix: string,
  roomAssertion: string,
): Promise<SeededRoom> {
  const { client, fixtures, resources } = context;
  const reader = await fixtures.account(`${id}-reader`);
  const room = await fixtures.createRoom(reader, {
    name: `${prefix} ${resources.roomName(id)}`,
    preset: 'private_chat',
  });

  await client.login(reader);
  await assertExactRoomsRoute(client, reader.username);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await assertVisible(
    client,
    roomAssertion,
    '.channel__name',
    { exactText: room.name },
    30_000,
  );
  return { reader, room };
}

async function openRoomMenu(
  client: AccountWorkspaceClient,
  roomName: string,
  itemTestId: 'room-mark-read' | 'room-mark-unread',
  label: 'Mark as read' | 'Mark as unread',
  readiness: string,
): Promise<void> {
  await client.tapCurrent(`[aria-label="Options for ${roomName}"]`);
  await assertVisible(
    client,
    readiness,
    `[data-testid="${itemTestId}"]`,
    { exactText: label },
    10_000,
  );
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'mark-all-read',
    source: sources.markAll,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client, fixtures, resources } = context;
      const reader = await fixtures.account('mark-all-reader');
      const sender = await fixtures.account('mark-all-sender');
      const room = await fixtures.createRoom(reader, {
        name: `Unread ${resources.roomName('mark-all-read')}`,
        preset: 'private_chat',
        invite: [sender.userId],
      });
      await fixtures.join(sender, room.id);
      await fixtures.sendMessage(
        sender,
        room.id,
        'ping',
        resources.aliasLocalpart('mark-all-read-message'),
      );

      await client.login(reader);
      await assertExactRoomsRoute(client, reader.username);
      await client.tapCurrent('[data-testid="rail-rooms"]');
      await assertVisible(
        client,
        assertions.markAllRoomVisible,
        '.channel__name',
        { exactText: room.name },
        30_000,
      );
      await assertVisible(
        client,
        assertions.markAllActionVisible,
        '[data-testid="mark-all-read"]',
        {},
        30_000,
      );
      await client.tapCurrent('[data-testid="mark-all-read"]');
      await assertCount(
        client,
        assertions.markAllActionHidden,
        '[data-testid="mark-all-read"]',
        0,
        20_000,
      );
    },
  },
  {
    id: 'local-mark-unread',
    source: sources.local,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client } = context;
      const { reader, room } = await seedEmptyRoom(
        context,
        'local-mark-unread',
        'Mark Unread E2E',
        'setup.local.room-visible',
      );

      await assertInitialFlagAbsent(
        context,
        assertions.localInitialFlagAbsent,
        reader,
        room.id,
      );
      await assertCount(
        client,
        assertions.localInitialBadgeAbsent,
        '.channel__badge',
        0,
      );
      await openRoomMenu(
        client,
        room.name,
        'room-mark-unread',
        'Mark as unread',
        'setup.local.mark-unread-visible',
      );
      await client.tapCurrent('[data-testid="room-mark-unread"]', {
        exactText: 'Mark as unread',
      });
      await assertFlag(
        context,
        assertions.localFlagRoundTrip,
        reader,
        room.id,
        true,
      );
      await assertVisible(
        client,
        assertions.localDotVisible,
        '[data-testid="room-unread-dot"]',
        {},
        20_000,
      );
      await assertEmptyText(
        client,
        assertions.localDotEmpty,
        '[data-testid="room-unread-dot"]',
        20_000,
      );

      await client.tapCurrent('.channel-row', { text: room.name });
      await assertVisible(
        client,
        assertions.localConversationVisible,
        '.scroll',
        {},
        20_000,
      );
      await assertFlag(
        context,
        assertions.localFlagCleared,
        reader,
        room.id,
        false,
      );
      await assertCount(
        client,
        assertions.localDotCleared,
        '[data-testid="room-unread-dot"]',
        0,
        20_000,
      );
    },
  },
  {
    id: 'remote-mark-unread',
    source: sources.remote,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client, fixtures } = context;
      const { reader, room } = await seedEmptyRoom(
        context,
        'remote-mark-unread',
        'Mark Unread Sync',
        'setup.remote.room-visible',
      );

      await assertCount(
        client,
        assertions.remoteInitialBadgeAbsent,
        '.channel__badge',
        0,
      );
      const written = await fixtures.setMarkedUnread(reader, room.id, true);
      await client.record(assertions.remoteWriteAccepted, {
        assertion: assertions.remoteWriteAccepted,
        written,
      });
      assert.equal(written, true, assertions.remoteWriteAccepted);
      await assertVisible(
        client,
        assertions.remoteLiveDotVisible,
        '[data-testid="room-unread-dot"]',
        {},
        30_000,
      );

      await client.reload();
      await assertExactRoomsRoute(client, reader.username);
      await client.tapCurrent('[data-testid="rail-rooms"]');
      await assertVisible(
        client,
        assertions.remoteReloadDotVisible,
        '[data-testid="room-unread-dot"]',
        {},
        30_000,
      );
      await openRoomMenu(
        client,
        room.name,
        'room-mark-read',
        'Mark as read',
        'setup.remote.mark-read-visible',
      );
      await client.tapCurrent('[data-testid="room-mark-read"]', {
        exactText: 'Mark as read',
      });
      await assertFlag(
        context,
        assertions.remoteFlagCleared,
        reader,
        room.id,
        false,
      );
      await assertCount(
        client,
        assertions.remoteDotCleared,
        '[data-testid="room-unread-dot"]',
        0,
        20_000,
      );
    },
  },
];

assert.equal(cases.length, 3, 'Exactly three room read-state stages are required');
assert.equal(
  Object.keys(assertions).length,
  17,
  'Exactly 17 direct assertions are required',
);

void test(
  'Android room read-state journeys',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-read-state',
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
        matrixResources.cleanup('Redact room read-state diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Room read-state Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Room read-state Android WebView',
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
          console.info(`[room-read-state] ${entry.id} start`);
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
              `[room-read-state] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Room read-state journey ${entry.id} failed`,
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
