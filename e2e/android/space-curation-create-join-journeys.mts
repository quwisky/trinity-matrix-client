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
  type AccountElementFilter,
  type AccountWorkspaceCase,
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { bindRoomControl, roomControl } from './room-control-identity.mts';

const addSource =
  'e2e/browser/journeys/room-library/space-curation.spec.mts:92-140';
const createSource =
  'e2e/browser/journeys/room-library/space-curation.spec.mts:142-221';
const joinSource =
  'e2e/browser/journeys/room-library/space-curation.spec.mts:392-457';

const assertions = {
  addDialogVisible: 'add.dialog-visible',
  addLinkPresent: 'add.link-present',
  addLinkViaArray: 'add.link-via-array',
  addLinkViaNonempty: 'add.link-via-nonempty',
  subspaceNameFieldVisible: 'subspace.name-field-visible',
  subspaceLinkPresent: 'subspace.link-present',
  subspaceChildTypeSpace: 'subspace.child-type-space',
  joinActionVisible: 'join.action-visible',
  joinActionHidden: 'join.action-hidden',
  joinChildRowVisible: 'join.child-row-visible',
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
  filter: AccountElementFilter = {},
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

async function selectSpace(
  client: AccountWorkspaceClient,
  name: string,
): Promise<string> {
  const spaceSelector = `button[aria-label="${name}"]`;
  await observedElements(
    client,
    'setup.space-visible',
    spaceSelector,
    (elements) => elements.length === 1 && elements[0]!.visible,
  );
  await client.tapCurrent(spaceSelector);
  return spaceSelector;
}

async function openSpaceAction(
  client: AccountWorkspaceClient,
  testId: string,
): Promise<void> {
  await client.tapCurrent('[data-testid="space-actions-overflow"]');
  await client.tapCurrent(`[data-testid="${testId}"]`);
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'add-existing-room',
    source: addSource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('curate-add');
      const spaceName = `Curated ${resources.roomName('space')}`;
      const roomName = `Existing ${resources.roomName('room')}`;
      const space = await fixtures.createRoom(reader, {
        name: spaceName,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      const room = await fixtures.createRoom(reader, {
        name: roomName,
        preset: 'private_chat',
      });

      await client.login(reader);
      await selectSpace(client, spaceName);
      await openSpaceAction(client, 'space-add-rooms');
      await observedElements(
        client,
        assertions.addDialogVisible,
        '[data-testid="add-to-space"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      // Selectors reach the job log, so the pick is found by the Room's name,
      // not the Room id in its test id; read-only observation binds it.
      const pick = roomControl('.add-to-space__row', 'add-to-space-pick-', roomName, room.id);
      await client.visible(pick.selector, pick.filter, 30_000);
      await bindRoomControl(client, pick, 'Add-to-Space pick is the exact existing Room');
      await client.tapCurrent(pick.selector, pick.filter);
      await client.tapCurrent('[data-testid="add-to-space-add"]');

      const link = await waitForNativeShellState(
        () => fixtures.spaceChild(reader, space.id, room.id),
        (value) => value !== undefined,
        assertions.addLinkPresent,
        client.signal,
        30_000,
      );
      assert(link !== undefined, 'Existing room has a space-child link');
      await client.record(assertions.addLinkPresent, {
        assertion: assertions.addLinkPresent,
        present: true,
      });
      assert(
        Array.isArray(link['via']),
        `${assertions.addLinkViaArray}: Space-child via is an array`,
      );
      await client.record(assertions.addLinkViaArray, {
        assertion: assertions.addLinkViaArray,
        viaIsArray: true,
      });
      assert(
        link['via'].length > 0,
        `${assertions.addLinkViaNonempty}: Space-child via is nonempty`,
      );
      await client.record(assertions.addLinkViaNonempty, {
        assertion: assertions.addLinkViaNonempty,
        viaCount: link['via'].length,
      });
    },
  },
  {
    id: 'create-nested-space',
    source: createSource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('curate-subspace');
      const parentName = `Parent ${resources.roomName('space')}`;
      const childName = `Child ${resources.roomName('space')}`;
      const parent = await fixtures.createRoom(reader, {
        name: parentName,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });

      await client.login(reader);
      const spaceSelector = await selectSpace(client, parentName);
      await openSpaceAction(client, 'space-create-subspace');
      await observedElements(
        client,
        assertions.subspaceNameFieldVisible,
        '[placeholder="Space name"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await client.fill('[placeholder="Space name"]', childName);
      await client.tapCurrent('button', { exactText: 'Create' });

      const childIds = await waitForNativeShellState(
        () => fixtures.spaceChildIds(reader, parent.id),
        (value) => value.length === 1,
        assertions.subspaceLinkPresent,
        client.signal,
        60_000,
      );
      const childId = childIds[0]!;
      fixtures.trackRoomMembership(reader, childId);
      await client.record(assertions.subspaceLinkPresent, {
        assertion: assertions.subspaceLinkPresent,
        childCount: childIds.length,
      });
      const childType = await waitForNativeShellState(
        () => fixtures.roomCreateType(reader, childId),
        (value) => value === 'm.space',
        assertions.subspaceChildTypeSpace,
        client.signal,
        30_000,
      );
      assert.equal(childType, 'm.space');
      await client.record(assertions.subspaceChildTypeSpace, {
        assertion: assertions.subspaceChildTypeSpace,
        type: childType,
        selectedSpace: spaceSelector,
      });
    },
  },
  {
    id: 'join-child-live',
    source: joinSource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('curate-join-reader');
      const other = await fixtures.account('curate-join-owner');
      const spaceName = `Joinable ${resources.roomName('space')}`;
      const childName = `Lobby ${resources.roomName('room')}`;
      const space = await fixtures.createRoom(reader, {
        name: spaceName,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      const child = await fixtures.createRoom(other, {
        name: childName,
        preset: 'public_chat',
      });
      await fixtures.setSpaceChild(reader, space.id, child.id);

      await client.login(reader);
      await selectSpace(client, spaceName);
      const join = roomControl('.joinable', 'join-child-', childName, child.id);
      await observedElements(
        client,
        assertions.joinActionVisible,
        join.selector,
        (elements) => elements.length === 1 && elements[0]!.visible,
        join.filter,
      );
      await bindRoomControl(client, join, 'Join action is the exact suggested child Room');
      await client.tapCurrent(join.selector, join.filter);
      await observedElements(
        client,
        assertions.joinActionHidden,
        join.selector,
        (elements) => elements.length === 0 || elements.every((item) => !item.visible),
        join.filter,
      );
      fixtures.trackRoomMembership(reader, child.id);
      await observedElements(
        client,
        assertions.joinChildRowVisible,
        '.channel',
        (elements) => elements.length === 1 && elements[0]!.visible,
        { text: childName },
      );
    },
  },
];

assert.equal(
  cases.length,
  3,
  'Exactly three space creation and join stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  10,
  'Exactly ten direct assertions are required',
);

void test(
  'Android space creation and join curation journeys',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'space-curation-create-join',
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
        matrixResources.cleanup('Redact space-curation diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Space-curation Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup('Space-curation Android WebView', async () =>
          client?.close(),
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
          console.info(`[space-curation-create-join] ${entry.id} start`);
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
              `[space-curation-create-join] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Space creation and join curation journey ${entry.id} failed`,
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
