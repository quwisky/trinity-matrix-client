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

const preferenceSource =
  'e2e/browser/journeys/room-library/space-room-order.spec.mts:237-347';
const liveSource =
  'e2e/browser/journeys/room-library/space-room-order.spec.mts:428-464';

const assertions = {
  preferenceDefaultRecencyOrder: 'preference.default-recency-order',
  preferenceFormVisible: 'preference.form-visible',
  preferenceSpaceOrderChecked: 'preference.space-order-checked',
  preferenceSavedFeedback: 'preference.saved-feedback',
  preferenceHierarchyUnchanged: 'preference.hierarchy-unchanged',
  preferenceCuratedOrder: 'preference.curated-order',
  preferenceReloadCuratedOrder: 'preference.reload-curated-order',
  preferenceAccountDefaultCuratedOrder:
    'preference.account-default-curated-order',
  preferenceDefaultSavedFeedback: 'preference.default-saved-feedback',
  preferenceAlphabeticalOrder: 'preference.alphabetical-order',
  preferenceShortcutRecencyOrder: 'preference.shortcut-recency-order',
  liveInitialRecencyOrder: 'live.initial-recency-order',
  liveReorderedRecencyOrder: 'live.reordered-recency-order',
} as const;

interface SeededOrderedSpace {
  readonly reader: NodeWorkspaceAccount;
  readonly space: WorkspaceRoom;
  readonly spaceName: string;
  readonly zulu: WorkspaceRoom;
  readonly alpha: WorkspaceRoom;
  readonly mike: WorkspaceRoom;
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

async function exactRoomOrder(
  client: AccountWorkspaceClient,
  assertion: string,
  expected: readonly string[],
): Promise<void> {
  const elements = await observedElements(
    client,
    assertion,
    '.channel__name',
    (matches) =>
      matches.length === expected.length &&
      matches.every(
        (element, index) =>
          element.visible && element.text === expected[index],
      ),
    {},
    30_000,
  );
  assert.deepEqual(
    elements.map((element) => element.text),
    expected,
    `${assertion}: exact visible room order`,
  );
}

async function selectSpace(
  client: AccountWorkspaceClient,
  name: string,
): Promise<void> {
  const selector = `button[aria-label="${name}"]`;
  await client.visible(selector, {}, 30_000);
  await client.tapCurrent(selector);
  await client.visible('[data-testid="space-actions-overflow"]', {}, 30_000);
}

async function openSpaceForYouSettings(
  client: AccountWorkspaceClient,
): Promise<void> {
  await client.tapCurrent('[data-testid="space-actions-overflow"]');
  await client.tapCurrent('[data-testid="open-space-settings"]');
  await client.visible('[data-testid="space-settings"]', {}, 30_000);
  await client.tapCurrent('[data-testid="space-settings-tab-for-you"]');
}

async function savedFeedback(
  client: AccountWorkspaceClient,
  assertion: string,
): Promise<void> {
  await observedElements(
    client,
    assertion,
    '[data-testid="space-settings-for-you-feedback"]',
    (elements) =>
      elements.length === 1 &&
      elements[0]!.visible &&
      elements[0]!.text ===
        'Room order saved for this Account on this device.',
    {},
    30_000,
  );
}

async function seedOrderedSpace(
  context: AccountWorkspaceCaseContext,
  id: string,
): Promise<SeededOrderedSpace> {
  const { fixtures, resources } = context;
  const reader = await fixtures.account(`${id}-reader`);
  const suffix = resources.roomName(id);
  const spaceName = `Ordered ${suffix}`;
  const space = await fixtures.createRoom(reader, {
    name: spaceName,
    preset: 'private_chat',
    creation_content: { type: 'm.space' },
  });
  const zulu = await fixtures.createRoom(reader, {
    name: `Zulu ${suffix}`,
    preset: 'private_chat',
  });
  const alpha = await fixtures.createRoom(reader, {
    name: `Alpha ${suffix}`,
    preset: 'private_chat',
  });
  const mike = await fixtures.createRoom(reader, {
    name: `Mike ${suffix}`,
    preset: 'private_chat',
  });
  for (const [room, order] of [
    [zulu, '10'],
    [alpha, '20'],
    [mike, '30'],
  ] as const) {
    await fixtures.setSpaceChild(reader, space.id, room.id, {
      order,
      suggested: true,
    });
  }
  for (const [index, room] of [alpha, zulu, mike].entries()) {
    await fixtures.sendMessage(
      reader,
      room.id,
      `seed ${room.name}`,
      `${id}-seed-${index}`,
    );
  }
  return { reader, space, spaceName, zulu, alpha, mike };
}

async function hierarchySnapshot(
  context: AccountWorkspaceCaseContext,
  seeded: SeededOrderedSpace,
): Promise<readonly unknown[]> {
  return Promise.all(
    [seeded.zulu, seeded.alpha, seeded.mike].map((room) =>
      context.fixtures.spaceChild(
        seeded.reader,
        seeded.space.id,
        room.id,
      ),
    ),
  );
}

async function setAccountDefaultAlphabetical(
  client: AccountWorkspaceClient,
  reader: NodeWorkspaceAccount,
): Promise<void> {
  await client.tapCurrent('[data-testid="open-settings"]');
  await client.visible('[data-testid="settings-workspace"]', {}, 30_000);
  await client.tapCurrent('[data-testid="settings-nav-appearance"]');
  await client.visible('[data-testid="space-order-select"]', {}, 30_000);
  await client.scrollIntoViewIfNeeded(
    '[data-testid="space-order-select"]',
    '[data-testid="settings-detail"]',
  );
  await client.tapCurrent('[data-testid="space-order-select"] button');
  await client.tapCurrent('[data-testid="space-order-alphabetical"]');
  await pressNativeBack(client);
  await client.visible('[data-testid="settings-nav-appearance"]', {}, 30_000);
  await pressNativeBack(client);
  await client.rooms(reader);
}

async function pressNativeBack(client: AccountWorkspaceClient): Promise<void> {
  await client.device.runFlow(
    join(client.workspaceRoot, 'e2e/android/flows/native-shell-back.yaml'),
    { APP_ID: 'eu.qwky.trinity' },
  );
}

async function chooseSidebarSort(
  client: AccountWorkspaceClient,
  option: string,
): Promise<void> {
  await client.tapCurrent('[data-testid="space-actions-overflow"]');
  await client.tapCurrent('[data-testid="space-sort"]');
  await client.tapCurrent(`[data-testid="${option}"]`);
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'preference-precedence',
    source: preferenceSource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client } = context;
      const seeded = await seedOrderedSpace(context, 'space-order-preference');
      const curated = [seeded.zulu.name, seeded.alpha.name, seeded.mike.name];
      const alphabetical = [
        seeded.alpha.name,
        seeded.mike.name,
        seeded.zulu.name,
      ];
      const recency = [seeded.mike.name, seeded.zulu.name, seeded.alpha.name];
      const before = await hierarchySnapshot(context, seeded);

      await client.login(seeded.reader);
      await selectSpace(client, seeded.spaceName);
      await exactRoomOrder(
        client,
        assertions.preferenceDefaultRecencyOrder,
        recency,
      );

      await openSpaceForYouSettings(client);
      await observedElements(
        client,
        assertions.preferenceFormVisible,
        '[data-testid="space-settings-for-you-form"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await client.tapCurrent('[data-testid="space-settings-order-space"]');
      await observedElements(
        client,
        assertions.preferenceSpaceOrderChecked,
        '[data-testid="space-settings-order-space"] input',
        (elements) =>
          elements.length === 1 &&
          elements[0]!.attributes['aria-checked'] === 'true',
      );
      await client.tapCurrent('[data-testid="space-settings-for-you-save"]');
      await savedFeedback(client, assertions.preferenceSavedFeedback);

      const after = await hierarchySnapshot(context, seeded);
      assert.deepEqual(
        after,
        before,
        `${assertions.preferenceHierarchyUnchanged}: device preference does not rewrite m.space.child`,
      );
      await client.record(assertions.preferenceHierarchyUnchanged, {
        assertion: assertions.preferenceHierarchyUnchanged,
        childCount: after.length,
        unchanged: true,
      });
      await client.tapCurrent('[data-testid="space-settings-cancel"]');
      await exactRoomOrder(
        client,
        assertions.preferenceCuratedOrder,
        curated,
      );

      await client.reload();
      await selectSpace(client, seeded.spaceName);
      await exactRoomOrder(
        client,
        assertions.preferenceReloadCuratedOrder,
        curated,
      );

      await setAccountDefaultAlphabetical(client, seeded.reader);
      await selectSpace(client, seeded.spaceName);
      await exactRoomOrder(
        client,
        assertions.preferenceAccountDefaultCuratedOrder,
        curated,
      );

      await openSpaceForYouSettings(client);
      await client.tapCurrent('[data-testid="space-settings-order-default"]');
      await client.tapCurrent('[data-testid="space-settings-for-you-save"]');
      await savedFeedback(client, assertions.preferenceDefaultSavedFeedback);
      await client.tapCurrent('[data-testid="space-settings-cancel"]');
      await exactRoomOrder(
        client,
        assertions.preferenceAlphabeticalOrder,
        alphabetical,
      );

      await chooseSidebarSort(client, 'space-sort-recent');
      await exactRoomOrder(
        client,
        assertions.preferenceShortcutRecencyOrder,
        recency,
      );
    },
  },
  {
    id: 'live-recency-reorder',
    source: liveSource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client, fixtures } = context;
      const seeded = await seedOrderedSpace(context, 'space-order-live');
      const initial = [seeded.mike.name, seeded.zulu.name, seeded.alpha.name];
      const reordered = [
        seeded.alpha.name,
        seeded.mike.name,
        seeded.zulu.name,
      ];

      await client.login(seeded.reader);
      await selectSpace(client, seeded.spaceName);
      await exactRoomOrder(client, assertions.liveInitialRecencyOrder, initial);
      await fixtures.sendMessage(
        seeded.reader,
        seeded.alpha.id,
        `bump ${seeded.alpha.name}`,
        'space-order-live-bump',
      );
      await exactRoomOrder(
        client,
        assertions.liveReorderedRecencyOrder,
        reordered,
      );
    },
  },
];

assert.equal(
  cases.length,
  2,
  'Exactly two space room-order stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  13,
  'Exactly thirteen direct assertions are required',
);

void test(
  'Android space room-order journeys',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'space-room-order',
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
        matrixResources.cleanup('Redact space-room-order diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Space-room-order Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup('Space-room-order Android WebView', async () =>
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
          console.info(`[space-room-order] ${entry.id} start`);
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
              `[space-room-order] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Space room-order journey ${entry.id} failed`,
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
