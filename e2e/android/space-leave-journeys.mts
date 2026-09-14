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
import { waitForNativeShellState } from './native-shell-client.mts';
import {
  SPACE_LEAVE_SOURCE,
  spaceLeaveAssertions as assertions,
  type SpaceLeaveAssertion,
} from './space-leave-contract.mts';

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function observedValue<T>(
  client: AccountWorkspaceClient,
  assertionIdentity: SpaceLeaveAssertion,
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
  assertionIdentity: SpaceLeaveAssertion,
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

async function openSpaceMenu(
  client: AccountWorkspaceClient,
  spacePillSelector: string,
): Promise<void> {
  await client.visible(spacePillSelector, {}, 30_000);
  await client.tapCurrent(spacePillSelector);
  await client.visible('[data-testid="space-actions-overflow"]', {}, 30_000);
  await client.tapCurrent('[data-testid="space-actions-overflow"]');
  await client.visible('[data-testid="space-leave"]', {}, 10_000);
}

async function openLeaveDialog(
  client: AccountWorkspaceClient,
  spacePillSelector: string,
): Promise<void> {
  await openSpaceMenu(client, spacePillSelector);
  await client.tapCurrent('[data-testid="space-leave"]');
  await client.visible('[data-testid="alert-surface"]', {}, 10_000);
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'space-leave',
    source: SPACE_LEAVE_SOURCE.definition,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const account = await fixtures.account('space-leave');
      const spaceName = `Leave space ${resources.roomName('space-leave')}`;
      const childName = `Keep room ${resources.roomName('space-leave-child')}`;
      const space = await fixtures.createRoom(account, {
        name: spaceName,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      const child = await fixtures.createRoom(account, {
        name: childName,
        preset: 'private_chat',
      });
      await fixtures.setSpaceChild(account, space.id, child.id, {
        suggested: true,
      });

      await client.login(account);
      const spacePillSelector = `button[aria-label=${JSON.stringify(spaceName)}]`;
      await openLeaveDialog(client, spacePillSelector);

      await observedElements(
        client,
        assertions.dialogSpaceName,
        '[data-testid="alert-surface"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
        { text: spaceName },
      );
      await observedElements(
        client,
        assertions.dialogAccountName,
        '[data-testid="alert-surface"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
        { text: account.username },
      );
      await observedElements(
        client,
        assertions.dialogChildMembershipCopy,
        '[data-testid="alert-surface"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
        { text: 'You remain a member of its Rooms' },
      );
      await client.tapCurrent('[data-testid="alert-cancel"]');

      await observedValue(
        client,
        assertions.cancelMembershipsRetained,
        () => fixtures.joinedRoomIds(account),
        (roomIds) => roomIds.includes(space.id) && roomIds.includes(child.id),
      );
      await observedElements(
        client,
        assertions.cancelSpacePillVisible,
        spacePillSelector,
        (elements) => elements.length === 1 && elements[0]!.visible,
      );

      await openLeaveDialog(client, spacePillSelector);
      await client.tapCurrent('[data-testid="alert-confirm"]');

      await observedValue(
        client,
        assertions.confirmSpaceLeft,
        () => fixtures.joinedRoomIds(account),
        (roomIds) => !roomIds.includes(space.id),
      );
      await observedValue(
        client,
        assertions.confirmChildMembershipRetained,
        () => fixtures.joinedRoomIds(account),
        (roomIds) => roomIds.includes(child.id),
      );
    },
  },
];

assert.equal(cases.length, 1, 'Exactly one Space leave stage is required');
assert.equal(
  Object.keys(assertions).length,
  7,
  'Exactly seven Space leave assertions are required',
);

void test(
  'Android Space leave journey',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'space-leave',
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
        matrixResources.cleanup('Redact Space leave diagnostics', () =>
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
        matrixResources.cleanup('Space leave Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Space leave Android WebView',
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
          console.info(`[space-leave] ${entry.id} start`);
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
              `[space-leave] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Space leave journey ${entry.id} failed`,
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
