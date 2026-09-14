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
import { evaluateNative, waitForNativeShellState } from './native-shell-client.mts';
import {
  ROOM_TOMBSTONE_SOURCE,
  roomTombstoneAssertions as assertions,
  type RoomTombstoneAssertion,
} from './room-tombstone-contract.mts';

interface TombstoneLayout {
  readonly insideChatBody: boolean | null;
  readonly timelineShare: number;
}

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function observedValue<T>(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomTombstoneAssertion,
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
  assertionIdentity: RoomTombstoneAssertion,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: { readonly text?: string; readonly exactText?: string } = {},
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

async function readTombstoneLayout(
  client: AccountWorkspaceClient,
): Promise<TombstoneLayout> {
  const value = await evaluateNative(client.webview, `(() => {
    const banner = document.querySelector('[data-testid="tombstone-banner"]');
    const row = document.querySelector('.chat-body')?.getBoundingClientRect();
    const list = document.querySelector('.chat-body trn-simple-message-list, .chat-body trn-virtual-message-list')?.getBoundingClientRect();
    return {
      insideChatBody: banner ? !!banner.closest('.chat-body') : null,
      timelineShare: row && list && row.width > 0 ? list.width / row.width : 0,
    };
  })()`);
  assert(value !== null && typeof value === 'object' && !Array.isArray(value));
  assert('insideChatBody' in value);
  assert(
    value.insideChatBody === null || typeof value.insideChatBody === 'boolean',
    'Tombstone banner placement observation is boolean or null',
  );
  assert('timelineShare' in value && typeof value.timelineShare === 'number');
  return value as TombstoneLayout;
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'room-tombstone',
    source: ROOM_TOMBSTONE_SOURCE.definition,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const account = await fixtures.account('room-tombstone');
      const oldRoom = await fixtures.createRoom(account, {
        name: `Old room ${resources.roomName('room-tombstone-old')}`,
        preset: 'private_chat',
      });
      const successor = await fixtures.createRoom(account, {
        name: `New room ${resources.roomName('room-tombstone-successor')}`,
        preset: 'private_chat',
      });
      await fixtures.setRoomState(account, oldRoom.id, 'm.room.tombstone', {
        body: 'This room has been upgraded.',
        replacement_room: successor.id,
      });

      await client.login(account);
      await client.tapCurrent('[data-testid="rail-rooms"]');
      await client.visible('.channel', { text: oldRoom.name }, 30_000);
      await client.tapCurrent('.channel', { text: oldRoom.name });

      await observedElements(
        client,
        assertions.oldComposerVisible,
        '[data-testid="composer-input"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await observedElements(
        client,
        assertions.oldBannerVisible,
        '[data-testid="tombstone-banner"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await observedValue(
        client,
        assertions.layoutBannerAboveChatRow,
        () => readTombstoneLayout(client),
        (layout) => layout.insideChatBody === false,
      );
      await observedValue(
        client,
        assertions.layoutTimelineShare,
        () => readTombstoneLayout(client),
        (layout) => layout.timelineShare > 0.5,
      );

      await client.tapCurrent('[data-testid="tombstone-go"]');
      await observedElements(
        client,
        assertions.successorBannerHidden,
        '[data-testid="tombstone-banner"]',
        (elements) => elements.length === 0,
      );
      await observedElements(
        client,
        assertions.successorComposerVisible,
        '[data-testid="composer-input"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
    },
  },
];

assert.equal(cases.length, 1, 'Exactly one Room tombstone stage is required');
assert.equal(
  Object.keys(assertions).length,
  6,
  'Exactly six Room tombstone assertions are required',
);

void test(
  'Android Room tombstone journey',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-tombstone',
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
        matrixResources.cleanup('Redact Room tombstone diagnostics', () =>
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
        matrixResources.cleanup('Room tombstone Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Room tombstone Android WebView',
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
          console.info(`[room-tombstone] ${entry.id} start`);
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
              `[room-tombstone] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Room tombstone journey ${entry.id} failed`,
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
