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
  preview:
    'e2e/browser/journeys/room-library/room-list.spec.mts:185-217',
  unread:
    'e2e/browser/journeys/room-library/room-list.spec.mts:219-269',
} as const;

const assertions = {
  previewLatestBody: 'preview.latest-body',
  previewRoomName: 'preview.room-name',
  previewAvatarCount: 'preview.avatar-count',
  previewLegacyHashAbsent: 'preview.legacy-hash-absent',
  unreadMutedBadgeVisible: 'unread.muted-badge-visible',
  unreadMutedBadgeCount: 'unread.muted-badge-count',
} as const;

const PREVIEW_BODY = 'latest preview message';
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

async function seedRoom(
  context: AccountWorkspaceCaseContext,
  id: string,
  namePrefix: string,
  messages: readonly string[],
): Promise<SeededRoom> {
  const { fixtures, resources } = context;
  const reader = await fixtures.account(`${id}-reader`);
  const sender = await fixtures.account(`${id}-sender`);
  const room = await fixtures.createRoom(reader, {
    name: `${namePrefix} ${resources.roomName(id)}`,
    preset: 'private_chat',
    invite: [sender.userId],
  });
  await fixtures.join(sender, room.id);
  for (const [index, body] of messages.entries()) {
    await fixtures.sendMessage(sender, room.id, body, `${id}-${index}`);
  }
  return { reader, room };
}

async function openRooms(
  client: AccountWorkspaceClient,
  reader: NodeWorkspaceAccount,
  roomName: string,
  readiness: string,
): Promise<void> {
  await client.login(reader);
  await assertExactRoomsRoute(client, reader.username);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await observedElements(
    client,
    readiness,
    '.channel__name',
    (elements) =>
      elements.length === 1 &&
      elements[0]!.visible &&
      elements[0]!.text === roomName,
    { exactText: roomName },
    30_000,
  );
}

async function assertOneVisible(
  client: AccountWorkspaceClient,
  assertion: string,
  selector: string,
  filter: { readonly text?: string; readonly exactText?: string } = {},
  timeoutMs = 30_000,
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
  timeoutMs = 30_000,
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

async function observeBestEffortBadgeClear(
  client: AccountWorkspaceClient,
): Promise<void> {
  const assertion = 'unread.badge-clear-observation';
  let cleared = false;
  let error: string | undefined;
  try {
    await client.waitElements(
      '.channel__badge',
      (elements) => elements.length === 0,
      assertion,
      {},
      15_000,
    );
    cleared = true;
  } catch (observationError) {
    error = describeFailure(observationError);
  }
  await client.record(assertion, { assertion, cleared, error });
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'preview-row',
    source: sources.preview,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client } = context;
      const { reader, room } = await seedRoom(
        context,
        'preview-row',
        'Preview E2E',
        [PREVIEW_BODY],
      );
      await openRooms(
        client,
        reader,
        room.name,
        'setup.preview.room-visible',
      );

      await assertOneVisible(
        client,
        assertions.previewLatestBody,
        '.channel__preview:not(.channel__preview--typing)',
        { exactText: PREVIEW_BODY },
      );
      const name = await assertOneVisible(
        client,
        assertions.previewRoomName,
        '.channel__name',
        { exactText: room.name },
      );
      assert.equal(name.text, room.name, assertions.previewRoomName);
      await assertCount(
        client,
        assertions.previewAvatarCount,
        '.channel trn-avatar',
        1,
      );
      await assertCount(
        client,
        assertions.previewLegacyHashAbsent,
        '.channel .channel__hash',
        0,
      );
    },
  },
  {
    id: 'unread-row',
    source: sources.unread,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client } = context;
      const messages = Array.from(
        { length: UNREAD_SEED },
        (_, index) => `unread row ${index} ${context.resources.roomName('message')}`,
      );
      const { reader, room } = await seedRoom(
        context,
        'unread-row',
        'Unread Row E2E',
        messages,
      );
      await openRooms(
        client,
        reader,
        room.name,
        'setup.unread.room-visible',
      );

      await assertOneVisible(
        client,
        assertions.unreadMutedBadgeVisible,
        '.channel__badge--muted',
      );
      const badge = await assertOneVisible(
        client,
        assertions.unreadMutedBadgeCount,
        '.channel__badge--muted',
        { exactText: String(UNREAD_SEED) },
      );
      assert.equal(
        badge.text,
        String(UNREAD_SEED),
        assertions.unreadMutedBadgeCount,
      );
      await client.tapCurrent('.channel', { text: room.name });
      await observeBestEffortBadgeClear(client);
    },
  },
];

assert.equal(cases.length, 2, 'Exactly two room-list stages are required');
assert.equal(
  Object.keys(assertions).length,
  6,
  'Exactly six direct assertions are required',
);

void test(
  'Android room-list journeys',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-list',
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
        matrixResources.cleanup('Redact room-list diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Room-list Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Room-list Android WebView',
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
          console.info(`[room-list] ${entry.id} start`);
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
              `[room-list] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Room-list journey ${entry.id} failed`,
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
