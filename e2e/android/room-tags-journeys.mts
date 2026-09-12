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

const sources = {
  favourite:
    'e2e/browser/journeys/room-library/favourite-rooms.spec.mts:130-196',
  lowPriority:
    'e2e/browser/journeys/room-library/favourite-rooms.spec.mts:198-275',
} as const;

const assertions = {
  favouriteInitialAbsent: 'favourite.initial-section-absent',
  favouriteMenuLabel: 'favourite.menu-label',
  favouriteFirstRoom: 'favourite.first-room',
  unfavouriteMenuLabel: 'unfavourite.menu-label',
  unfavouriteSectionAbsent: 'unfavourite.section-absent',
  lowPriorityInitialAbsent: 'low-priority.initial-section-absent',
  lowPriorityInitialFirst: 'low-priority.initial-first-room',
  lowPriorityMenuLabel: 'low-priority.menu-label',
  lowPriorityLastRoom: 'low-priority.last-room',
  lowPriorityFirstRoom: 'low-priority.first-room',
  doubleTagLowPriorityAbsent: 'double-tag.low-priority-section-absent',
  doubleTagFavouritesVisible: 'double-tag.favourites-section-visible',
  doubleTagFirstRoom: 'double-tag.first-room',
  doubleTagRestoreLabel: 'double-tag.restore-label',
} as const;

interface SeededRooms {
  readonly reader: Awaited<
    ReturnType<AccountWorkspaceCaseContext['fixtures']['account']>
  >;
  readonly alphaName: string;
  readonly bravoName: string;
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

async function seedTwoRooms(
  context: AccountWorkspaceCaseContext,
  id: string,
): Promise<SeededRooms> {
  const { client, fixtures, resources } = context;
  const reader = await fixtures.account(`${id}-reader`);
  const suffix = resources.roomName(id);
  const names = ['Alpha Room', 'Bravo Room'] as const;
  const [alphaName, bravoName] = names.map((name) => `${name} ${suffix}`);

  for (const name of [alphaName, bravoName]) {
    await fixtures.createRoom(reader, { name, preset: 'private_chat' });
  }

  await client.login(reader);
  await assertExactRoomsRoute(client, reader.username);
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await observedElements(
    client,
    `setup.${id}.alpha-visible`,
    '.channel__name',
    (elements) =>
      elements.length === 1 && elements[0]!.visible && elements[0]!.text === alphaName,
    { exactText: alphaName },
    30_000,
  );
  await observedElements(
    client,
    `setup.${id}.bravo-visible`,
    '.channel__name',
    (elements) =>
      elements.length === 1 && elements[0]!.visible && elements[0]!.text === bravoName,
    { exactText: bravoName },
    30_000,
  );

  return { reader, alphaName, bravoName };
}

async function assertSectionCount(
  client: AccountWorkspaceClient,
  assertion: string,
  title: string,
  expected: number,
  timeoutMs = 15_000,
): Promise<void> {
  await observedElements(
    client,
    assertion,
    '.category',
    (elements) =>
      elements.length === expected && elements.every((element) => element.visible),
    { text: title },
    timeoutMs,
  );
}

async function assertExactText(
  client: AccountWorkspaceClient,
  assertion: string,
  selector: string,
  expected: string,
  timeoutMs = 15_000,
): Promise<void> {
  await observedElements(
    client,
    assertion,
    selector,
    (elements) =>
      elements.length === 1 &&
      elements[0]!.visible &&
      elements[0]!.text === expected,
    {},
    timeoutMs,
  );
}

async function assertRoomAt(
  client: AccountWorkspaceClient,
  assertion: string,
  index: 0 | 1,
  expected: string,
  timeoutMs = 30_000,
): Promise<void> {
  await observedElements(
    client,
    assertion,
    '.channel__name',
    (elements) =>
      elements.length === 2 &&
      elements.every((element) => element.visible) &&
      elements[index]!.text === expected,
    {},
    timeoutMs,
  );
}

async function openRoomMenu(
  client: AccountWorkspaceClient,
  roomName: string,
  itemTestId: 'room-favourite' | 'room-low-priority',
  readiness: string,
): Promise<void> {
  await client.tapCurrent(`[aria-label="Options for ${roomName}"]`);
  await observedElements(
    client,
    readiness,
    `[data-testid="${itemTestId}"]`,
    (elements) => elements.length === 1 && elements[0]!.visible,
    {},
    10_000,
  );
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'favourite-toggle',
    source: sources.favourite,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client } = context;
      const { bravoName } = await seedTwoRooms(context, 'favourite-toggle');

      await assertSectionCount(
        client,
        assertions.favouriteInitialAbsent,
        'Favourites',
        0,
      );
      await openRoomMenu(
        client,
        bravoName,
        'room-favourite',
        'setup.favourite-menu-visible',
      );
      await assertExactText(
        client,
        assertions.favouriteMenuLabel,
        '[data-testid="room-favourite"]',
        'Favourite',
        10_000,
      );
      await client.tapCurrent('[data-testid="room-favourite"]', {
        exactText: 'Favourite',
      });
      await assertSectionCount(
        client,
        'setup.favourites-section-visible',
        'Favourites',
        1,
        30_000,
      );
      await assertRoomAt(
        client,
        assertions.favouriteFirstRoom,
        0,
        bravoName,
      );

      await openRoomMenu(
        client,
        bravoName,
        'room-favourite',
        'setup.unfavourite-menu-visible',
      );
      await assertExactText(
        client,
        assertions.unfavouriteMenuLabel,
        '[data-testid="room-favourite"]',
        'Unfavourite',
        10_000,
      );
      await client.tapCurrent('[data-testid="room-favourite"]', {
        exactText: 'Unfavourite',
      });
      await assertSectionCount(
        client,
        assertions.unfavouriteSectionAbsent,
        'Favourites',
        0,
        30_000,
      );
    },
  },
  {
    id: 'low-priority-double-tag',
    source: sources.lowPriority,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client } = context;
      const { alphaName, bravoName } = await seedTwoRooms(
        context,
        'low-priority-double-tag',
      );

      await assertSectionCount(
        client,
        assertions.lowPriorityInitialAbsent,
        'Low priority',
        0,
      );
      await assertRoomAt(
        client,
        assertions.lowPriorityInitialFirst,
        0,
        bravoName,
      );
      await openRoomMenu(
        client,
        bravoName,
        'room-low-priority',
        'setup.low-priority-menu-visible',
      );
      await assertExactText(
        client,
        assertions.lowPriorityMenuLabel,
        '[data-testid="room-low-priority"]',
        'Low priority',
        10_000,
      );
      await client.tapCurrent('[data-testid="room-low-priority"]', {
        exactText: 'Low priority',
      });
      await assertSectionCount(
        client,
        'setup.low-priority-section-visible',
        'Low priority',
        1,
        30_000,
      );
      await assertRoomAt(
        client,
        assertions.lowPriorityLastRoom,
        1,
        bravoName,
      );
      await assertRoomAt(
        client,
        assertions.lowPriorityFirstRoom,
        0,
        alphaName,
      );

      await openRoomMenu(
        client,
        bravoName,
        'room-favourite',
        'setup.double-tag-favourite-menu-visible',
      );
      await client.tapCurrent('[data-testid="room-favourite"]', {
        exactText: 'Favourite',
      });
      await assertSectionCount(
        client,
        assertions.doubleTagLowPriorityAbsent,
        'Low priority',
        0,
        30_000,
      );
      await assertSectionCount(
        client,
        assertions.doubleTagFavouritesVisible,
        'Favourites',
        1,
        30_000,
      );
      await assertRoomAt(
        client,
        assertions.doubleTagFirstRoom,
        0,
        bravoName,
      );
      await openRoomMenu(
        client,
        bravoName,
        'room-low-priority',
        'setup.double-tag-low-priority-menu-visible',
      );
      await assertExactText(
        client,
        assertions.doubleTagRestoreLabel,
        '[data-testid="room-low-priority"]',
        'Restore to list',
        10_000,
      );
    },
  },
];

assert.equal(cases.length, 2, 'Exactly two room tag stages are required');
assert.equal(
  Object.keys(assertions).length,
  14,
  'Exactly 14 direct assertions are required',
);

void test(
  'Android room tag journeys',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-tags',
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
        matrixResources.cleanup('Redact room tag diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Room tags Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Room tags Android WebView',
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
          console.info(`[room-tags] ${entry.id} start`);
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
              `[room-tags] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Room tag journey ${entry.id} failed`,
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
