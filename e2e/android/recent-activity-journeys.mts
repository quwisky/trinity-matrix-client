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

const sources = {
  scope:
    'e2e/browser/journeys/room-library/recent-activity.spec.mts:97-142',
  favourites:
    'e2e/browser/journeys/room-library/recent-activity.spec.mts:144-189',
  space:
    'e2e/browser/journeys/room-library/recent-activity.spec.mts:191-240',
  unread:
    'e2e/browser/journeys/room-library/recent-activity.spec.mts:242-301',
} as const;

const assertions = {
  scopeRecentCurrent: 'scope.recent-current',
  scopeRecentDmVisible: 'scope.recent-dm-visible',
  scopeRecentRoomVisible: 'scope.recent-room-visible',
  scopeHomeRecentNotCurrent: 'scope.home-recent-not-current',
  scopeHomeDmVisible: 'scope.home-dm-visible',
  scopeHomeRoomAbsent: 'scope.home-room-absent',
  scopeRoomsRoomVisible: 'scope.rooms-room-visible',
  scopeRoomsDmAbsent: 'scope.rooms-dm-absent',
  scopeReturnDmVisible: 'scope.return-dm-visible',
  scopeReturnRoomVisible: 'scope.return-room-visible',
  favouritesRecentCurrent: 'favourites.recent-current',
  favouritesSectionVisible: 'favourites.section-visible',
  favouritesRowVisible: 'favourites.row-visible',
  favouritesDmVisible: 'favourites.dm-visible',
  favouritesIndexPresent: 'favourites.index-present',
  favouritesBeforeDm: 'favourites.before-dm',
  spaceRecentCurrent: 'space.recent-current',
  spaceFreeVisible: 'space.free-visible',
  spaceChildVisible: 'space.child-visible',
  spaceRoomsFreeVisible: 'space.rooms-free-visible',
  spaceRoomsChildAbsent: 'space.rooms-child-absent',
  unreadBadgeVisible: 'unread.badge-visible',
  unreadBadgeNumeric: 'unread.badge-numeric',
  unreadBadgePositive: 'unread.badge-positive',
} as const;

const UNREAD_SEED = 3;

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

async function observedValue<T>(
  client: AccountWorkspaceClient,
  assertion: string,
  observation: T,
  accepts: (value: T) => boolean,
  details: Readonly<Record<string, unknown>> = {},
): Promise<void> {
  let failure: unknown;
  try {
    assert(accepts(observation), assertion);
  } catch (error) {
    failure = error;
  }
  await client.record(assertion, {
    assertion,
    observation,
    ...details,
    error: failure === undefined ? undefined : describeFailure(failure),
  });
  if (failure !== undefined) throw failure;
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

async function visibleNamedRow(
  client: AccountWorkspaceClient,
  assertion: string,
  name: string,
): Promise<void> {
  await observedElements(
    client,
    assertion,
    '.channel__name',
    (elements) => elements.length === 1 && elements[0]!.visible,
    { exactText: name },
  );
}

async function absentNamedRow(
  client: AccountWorkspaceClient,
  assertion: string,
  name: string,
): Promise<void> {
  await observedElements(
    client,
    assertion,
    '.channel__name',
    (elements) => elements.length === 0,
    { exactText: name },
  );
}

async function recentCurrent(
  client: AccountWorkspaceClient,
  assertion: string,
  current: boolean,
): Promise<void> {
  await observedElements(
    client,
    assertion,
    '[data-testid="rail-recent"]',
    (elements) =>
      elements.length === 1 &&
      elements[0]!.visible &&
      (elements[0]!.attributes['aria-current'] === 'true') === current,
  );
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'mixed-view-scoping',
    source: sources.scope,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('recent-scope-reader');
      const partner = await fixtures.account('recent-scope-partner');
      const dmName = `Direct ${resources.roomName('recent-scope-dm')}`;
      const roomName = `Channel ${resources.roomName('recent-scope-room')}`;
      await fixtures.setDisplayName(partner, dmName);
      await fixtures.createDirectRoom(reader, partner);
      await fixtures.createRoom(reader, {
        name: roomName,
        preset: 'private_chat',
      });

      await client.login(reader);
      await assertExactRoomsRoute(client, reader.username);
      await recentCurrent(client, assertions.scopeRecentCurrent, true);
      await visibleNamedRow(client, assertions.scopeRecentDmVisible, dmName);
      await visibleNamedRow(client, assertions.scopeRecentRoomVisible, roomName);

      await client.tapCurrent('[aria-label="Home"]');
      await recentCurrent(client, assertions.scopeHomeRecentNotCurrent, false);
      await visibleNamedRow(client, assertions.scopeHomeDmVisible, dmName);
      await absentNamedRow(client, assertions.scopeHomeRoomAbsent, roomName);

      await client.tapCurrent('[data-testid="rail-rooms"]');
      await visibleNamedRow(client, assertions.scopeRoomsRoomVisible, roomName);
      await absentNamedRow(client, assertions.scopeRoomsDmAbsent, dmName);

      await client.tapCurrent('[data-testid="rail-recent"]');
      await visibleNamedRow(client, assertions.scopeReturnDmVisible, dmName);
      await visibleNamedRow(client, assertions.scopeReturnRoomVisible, roomName);
    },
  },
  {
    id: 'favourite-ordering',
    source: sources.favourites,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('recent-favourites-reader');
      const partner = await fixtures.account('recent-favourites-partner');
      const dmName = `Direct ${resources.roomName('recent-favourites-dm')}`;
      const favouriteName = `Favourite ${resources.roomName('recent-favourite')}`;
      await fixtures.setDisplayName(partner, dmName);
      await fixtures.createDirectRoom(reader, partner);
      const favourite = await fixtures.createRoom(reader, {
        name: favouriteName,
        preset: 'private_chat',
      });
      await fixtures.setRoomTag(reader, favourite.id, 'm.favourite');

      await client.login(reader);
      await assertExactRoomsRoute(client, reader.username);
      await recentCurrent(client, assertions.favouritesRecentCurrent, true);
      await observedElements(
        client,
        assertions.favouritesSectionVisible,
        'trn-channel-sidebar .category',
        (elements) => elements.length === 1 && elements[0]!.visible,
        { exactText: 'Favourites' },
      );
      await visibleNamedRow(
        client,
        assertions.favouritesRowVisible,
        favouriteName,
      );
      await visibleNamedRow(client, assertions.favouritesDmVisible, dmName);
      await observedElements(
        client,
        assertions.favouritesIndexPresent,
        'trn-channel-sidebar .channel',
        (elements) =>
          elements.findIndex((element) => element.text.includes(favouriteName)) >=
            0 &&
          elements.findIndex((element) => element.text.includes(dmName)) >= 0,
      );
      await observedElements(
        client,
        assertions.favouritesBeforeDm,
        'trn-channel-sidebar .channel',
        (elements) => {
          const favouriteIndex = elements.findIndex((element) =>
            element.text.includes(favouriteName),
          );
          const dmIndex = elements.findIndex((element) =>
            element.text.includes(dmName),
          );
          return favouriteIndex >= 0 && dmIndex > favouriteIndex;
        },
      );
    },
  },
  {
    id: 'space-child-inclusion',
    source: sources.space,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('recent-space-reader');
      const freeName = `Freestanding ${resources.roomName('recent-free')}`;
      const childName = `Team Chat ${resources.roomName('recent-child')}`;
      await fixtures.createRoom(reader, {
        name: freeName,
        preset: 'private_chat',
      });
      const space = await fixtures.createRoom(reader, {
        name: `Team ${resources.roomName('recent-space')}`,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      const child = await fixtures.createRoom(reader, {
        name: childName,
        preset: 'private_chat',
      });
      await fixtures.setSpaceChild(reader, space.id, child.id);

      await client.login(reader);
      await assertExactRoomsRoute(client, reader.username);
      await recentCurrent(client, assertions.spaceRecentCurrent, true);
      await visibleNamedRow(client, assertions.spaceFreeVisible, freeName);
      await visibleNamedRow(client, assertions.spaceChildVisible, childName);

      await client.tapCurrent('[data-testid="rail-rooms"]');
      await visibleNamedRow(client, assertions.spaceRoomsFreeVisible, freeName);
      await absentNamedRow(client, assertions.spaceRoomsChildAbsent, childName);
    },
  },
  {
    id: 'recent-unread-badge',
    source: sources.unread,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const reader = await fixtures.account('recent-unread-reader');
      const sender = await fixtures.account('recent-unread-sender');
      const room = await fixtures.createRoom(reader, {
        name: `Unread ${resources.roomName('recent-unread')}`,
        preset: 'private_chat',
        invite: [sender.userId],
      });
      await fixtures.join(sender, room.id);
      for (let index = 0; index < UNREAD_SEED; index += 1) {
        await fixtures.sendMessage(
          sender,
          room.id,
          `unread ${index} ${resources.roomName('recent-message')}`,
          `recent-unread-${index}`,
        );
      }

      await client.login(reader);
      await assertExactRoomsRoute(client, reader.username);
      const badge = await observedElements(
        client,
        assertions.unreadBadgeVisible,
        'trn-server-rail .item:has([data-testid="rail-recent"]) .badge',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      const text = badge[0]!.text;
      await observedValue(
        client,
        assertions.unreadBadgeNumeric,
        text,
        (value) => /^\d+\+?$/.test(value),
        { expectedPreferred: UNREAD_SEED },
      );
      await observedValue(
        client,
        assertions.unreadBadgePositive,
        text,
        (value) => Number.parseInt(value, 10) > 0,
        {
          expectedPreferred: UNREAD_SEED,
          fallbackAccepted: text !== String(UNREAD_SEED),
        },
      );
    },
  },
];

assert.equal(
  cases.length,
  4,
  'Exactly four Recent Activity stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  24,
  'Exactly 24 direct assertions are required',
);

void test(
  'Android Recent Activity journeys',
  { timeout: 900_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'recent-activity',
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
        matrixResources.cleanup('Redact Recent Activity diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Recent Activity Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Recent Activity Android WebView',
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
          console.info(`[recent-activity] ${entry.id} start`);
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
              `[recent-activity] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Recent Activity journey ${entry.id} failed`,
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
