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
import {
  ROOM_ROSTER_LIVE_AUTHORITY_SOURCES,
  roomRosterLiveAuthorityAssertions as assertions,
  type RoomRosterLiveAuthorityAssertion,
} from './room-roster-live-authority-contract.mts';

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

function visibleOne(elements: readonly AccountElement[]): boolean {
  return elements.length === 1 && elements[0]!.visible;
}

async function observedElements(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomRosterLiveAuthorityAssertion,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: AccountElementFilter = {},
  timeoutMs = 30_000,
): Promise<readonly AccountElement[]> {
  let observation: readonly AccountElement[] | null = null;
  let value: readonly AccountElement[];
  try {
    value = await waitForNativeShellState(
      async () => {
        const latest = await client.elements(selector, filter);
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

async function observedElementsWithMembership(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomRosterLiveAuthorityAssertion,
  selector: string,
  observeMembership: () => Promise<string | undefined>,
  expectedMembership: 'join' | 'leave' | 'ban',
  filter: AccountElementFilter = {},
): Promise<void> {
  let observation: {
    readonly elements: readonly AccountElement[];
    readonly membership: string | undefined;
  } | null = null;
  try {
    observation = await waitForNativeShellState(
      async () => ({
        elements: await client.elements(selector, filter),
        membership: await observeMembership(),
      }),
      ({ elements, membership }) =>
        elements.length === 0 && membership === expectedMembership,
      assertionIdentity,
      client.signal,
      30_000,
    );
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await client.record(assertionIdentity, {
        assertion: assertionIdentity,
        expectedMembership,
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
    expectedMembership,
    observation,
  });
}

async function focusByNativeTab(
  client: AccountWorkspaceClient,
  selector: string,
  filter: AccountElementFilter = {},
): Promise<AccountElement> {
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const elements = await client.elements(selector, filter);
    if (visibleOne(elements) && elements[0]!.focused) return elements[0]!;
    await client.key('tab');
  }
  const elements = await client.elements(selector, filter);
  assert(
    visibleOne(elements) && elements[0]!.focused,
    `Native Tab did not focus ${selector}`,
  );
  return elements[0]!;
}

async function assertConfirmation(
  client: AccountWorkspaceClient,
  identities: {
    readonly target: RoomRosterLiveAuthorityAssertion;
    readonly room: RoomRosterLiveAuthorityAssertion;
    readonly account: RoomRosterLiveAuthorityAssertion;
  },
  memberName: string,
  roomName: string,
  accountId: string,
): Promise<void> {
  await observedElements(
    client,
    identities.target,
    '[data-testid="alert-surface"]',
    visibleOne,
    { text: memberName },
  );
  await observedElements(
    client,
    identities.room,
    '[data-testid="alert-surface"]',
    visibleOne,
    { text: roomName },
  );
  await observedElements(
    client,
    identities.account,
    '[data-testid="alert-surface"]',
    visibleOne,
    { text: `Account ${accountId}` },
  );
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'roster-live-authority',
    source: ROOM_ROSTER_LIVE_AUTHORITY_SOURCES.definition,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const controller = await fixtures.account('room-roster-controller');
      const admin = await fixtures.account('room-roster-admin');
      const member = await fixtures.account('room-roster-member');
      const memberName = `Ada ${resources.roomName('room-roster-member')}`;
      const roomName = `Roster ${resources.roomName('room-roster-room')}`;
      await fixtures.setDisplayName(member, memberName);
      const room = await fixtures.createRoom(controller, {
        name: roomName,
        preset: 'private_chat',
        invite: [admin.userId, member.userId],
        power_level_content_override: {
          users: { [controller.userId]: 101, [admin.userId]: 100 },
        },
      });
      await fixtures.join(member, room.id);
      await fixtures.join(admin, room.id);
      const initialPower = await fixtures.roomState(
        controller,
        room.id,
        'm.room.power_levels',
      );
      assert(initialPower, 'Roster Room has initial power levels');
      const initialUsers = initialPower['users'];
      assert(
        initialUsers && typeof initialUsers === 'object',
        'Roster Room has exact per-user powers',
      );
      assert.equal(
        (initialUsers as Record<string, unknown>)[controller.userId],
        101,
      );
      assert.equal(
        (initialUsers as Record<string, unknown>)[admin.userId],
        100,
      );
      assert.equal(
        (initialUsers as Record<string, unknown>)[member.userId] ?? 0,
        0,
      );

      await client.login(admin);
      await client.tapCurrent('[data-testid="rail-rooms"]');
      await client.visible('.channel', { text: room.name }, 30_000);
      await client.tapCurrent('.channel', { text: room.name });
      await observedElements(
        client,
        assertions.roomTimelineVisible,
        '[data-testid="composer-input"]',
        visibleOne,
      );
      await client.tapCurrent('[data-testid="room-actions-overflow"]');
      await client.tapCurrent(
        '[data-testid="overflow-open-room-settings"]',
      );
      await client.visible('[data-testid="room-settings"]');
      await client.tapCurrent('[data-testid="room-settings-tab-members"]');
      await observedElements(
        client,
        assertions.membersPanelVisible,
        '[data-testid="room-settings-panel-members"]',
        visibleOne,
      );

      await observedElements(
        client,
        assertions.rosterVisible,
        '[data-testid="member-list"]',
        visibleOne,
      );
      await observedElements(
        client,
        assertions.targetRowVisible,
        '[data-testid="member-row"]',
        visibleOne,
        { text: memberName },
      );
      await client.tapCurrent('[data-testid="member-row"]', {
        text: memberName,
      });
      await observedElements(
        client,
        assertions.detailTarget,
        '[data-testid="members-settings-detail"]',
        visibleOne,
        { text: memberName },
      );
      await client.scrollIntoViewIfNeeded(
        '[data-testid="member-info-role-50"]',
        '.member-info',
      );
      await client.tapCurrent('[data-testid="member-info-role-50"]');
      await observedElements(
        client,
        assertions.roleConfirmRoom,
        '[data-testid="alert-surface"]',
        visibleOne,
        { text: room.name },
      );
      await observedElements(
        client,
        assertions.roleConfirmAccount,
        '[data-testid="alert-surface"]',
        visibleOne,
        { text: `Account ${admin.userId}` },
      );
      await client.tapCurrent('[data-testid="alert-confirm"]');

      await observedElements(
        client,
        assertions.afterRoleVisible,
        '[data-testid="member-list"]',
        visibleOne,
      );
      await observedElements(
        client,
        assertions.moderatorGroupTarget,
        '.members__section[aria-label^="Moderator"]',
        visibleOne,
        { text: memberName },
      );
      await client.hideKeyboard();
      const moderatorRow =
        '.members__section[aria-label^="Moderator"] [data-testid="member-row"]';
      await client.scrollIntoViewIfNeeded(
        moderatorRow,
        '[data-testid="room-settings-detail"]',
      );
      await client.tapCurrent(moderatorRow, { text: memberName });
      await observedElements(
        client,
        assertions.detailModerator,
        '[data-testid="members-settings-detail"]',
        visibleOne,
        { text: 'Moderator' },
      );

      await fixtures.setRoomPower(controller, room.id, admin.userId, 0);
      await client.record('roster-admin-demotion-transition', {
        actor: controller.userId,
        member: admin.userId,
        from: 100,
        to: 0,
      });
      await observedElements(
        client,
        assertions.kickAbsentAfterDemotion,
        '[data-testid="member-info-kick"]',
        (elements) => elements.length === 0,
      );
      await observedElements(
        client,
        assertions.banAbsentAfterDemotion,
        '[data-testid="member-info-ban"]',
        (elements) => elements.length === 0,
      );
      await observedElements(
        client,
        assertions.detailTargetAfterDemotion,
        '[data-testid="members-settings-detail"]',
        visibleOne,
        { text: memberName },
      );
      await observedElements(
        client,
        assertions.detailModeratorAfterDemotion,
        '[data-testid="member-info-role"]',
        visibleOne,
        { exactText: 'Moderator' },
      );

      await fixtures.setRoomPower(controller, room.id, admin.userId, 100);
      await client.record('roster-admin-restoration-transition', {
        actor: controller.userId,
        member: admin.userId,
        from: 0,
        to: 100,
      });
      await observedElements(
        client,
        assertions.kickVisibleAfterRestore,
        '[data-testid="member-info-kick"]',
        visibleOne,
      );
      await focusByNativeTab(client, '[data-testid="member-info-kick"]');
      await client.key('enter');
      await assertConfirmation(
        client,
        {
          target: assertions.kickConfirmTarget,
          room: assertions.kickConfirmRoom,
          account: assertions.kickConfirmAccount,
        },
        memberName,
        room.name,
        admin.userId,
      );
      await client.fill('[placeholder="Reason (optional)"]', 'cleanup');
      await focusByNativeTab(client, '[data-testid="alert-confirm"]');
      await client.key('enter');
      fixtures.allowEndedMembershipCleanup(member, room.id);
      await observedElementsWithMembership(
        client,
        assertions.rowAbsentAfterKick,
        '[data-testid="member-row"]',
        () => fixtures.roomMembership(admin, room.id, member),
        'leave',
        { text: memberName },
      );

      await fixtures.invite(admin, room.id, member);
      await fixtures.join(member, room.id);
      await observedElements(
        client,
        assertions.rowVisibleAfterRejoin,
        '[data-testid="member-row"]',
        visibleOne,
        { text: memberName },
      );
      await focusByNativeTab(client, '[data-testid="member-row"]', {
        text: memberName,
      });
      await client.key('enter');
      await observedElements(
        client,
        assertions.banVisible,
        '[data-testid="member-info-ban"]',
        visibleOne,
      );
      await focusByNativeTab(client, '[data-testid="member-info-ban"]');
      await client.key('enter');
      await assertConfirmation(
        client,
        {
          target: assertions.banConfirmTarget,
          room: assertions.banConfirmRoom,
          account: assertions.banConfirmAccount,
        },
        memberName,
        room.name,
        admin.userId,
      );
      await focusByNativeTab(client, '[data-testid="alert-confirm"]');
      await client.key('enter');
      fixtures.allowEndedMembershipCleanup(member, room.id);
      await observedElementsWithMembership(
        client,
        assertions.rowAbsentAfterBan,
        '[data-testid="member-row"]',
        () => fixtures.roomMembership(admin, room.id, member),
        'ban',
        { text: memberName },
      );

      await focusByNativeTab(client, '[data-testid="members-settings-banned"]');
      await client.key('enter');
      await observedElements(
        client,
        assertions.bannedRowVisible,
        '[data-testid="banned-member"]',
        visibleOne,
        { text: memberName },
      );
      await focusByNativeTab(client, '[data-testid="banned-member-unban"]');
      await client.key('enter');
      await assertConfirmation(
        client,
        {
          target: assertions.unbanConfirmTarget,
          room: assertions.unbanConfirmRoom,
          account: assertions.unbanConfirmAccount,
        },
        memberName,
        room.name,
        admin.userId,
      );
      await focusByNativeTab(client, '[data-testid="alert-confirm"]');
      await client.key('enter');
      await observedElementsWithMembership(
        client,
        assertions.bannedRowAbsent,
        '[data-testid="banned-member"]',
        () => fixtures.roomMembership(admin, room.id, member),
        'leave',
        { text: memberName },
      );

      await fixtures.invite(admin, room.id, member);
      await fixtures.join(member, room.id);
      await client.key('escape');
      await client.key('escape');
      await observedElements(
        client,
        assertions.settingsClosedAfterEscape,
        '[data-testid="room-settings"]',
        (elements) => elements.length === 0,
      );
      await client.tapCurrent('[data-testid="room-actions-overflow"]');
      await client.tapCurrent('[data-testid="overflow-toggle-members"]');
      await observedElements(
        client,
        assertions.conversationRowVisible,
        '[data-testid="member-list"] [data-testid="member-row"]',
        visibleOne,
        { text: memberName },
      );
      await focusByNativeTab(
        client,
        '[data-testid="member-list"] [data-testid="member-row"]',
        { text: memberName },
      );
      await client.key('enter');
      await observedElements(
        client,
        assertions.conversationDetailTarget,
        '[data-testid="member-info"]',
        visibleOne,
        { text: memberName },
      );
      await focusByNativeTab(client, '[data-testid="member-info-close"]');
      await client.key('enter');
      await observedElements(
        client,
        assertions.conversationRowAfterCloseVisible,
        '[data-testid="member-list"] [data-testid="member-row"]',
        visibleOne,
        { text: memberName },
      );
      await observedElements(
        client,
        assertions.memberFilterFocused,
        '[data-testid="member-filter"]',
        (elements) => visibleOne(elements) && elements[0]!.focused,
      );
    },
  },
];

assert.equal(
  cases.length,
  1,
  'Exactly one Room roster live-authority stage is required',
);
assert.equal(
  Object.keys(assertions).length,
  35,
  'Exactly 35 Room roster live-authority assertions are required',
);

void test(
  'Android Room roster and live-authority journey',
  { timeout: 1_800_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-roster-live-authority',
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
        matrixResources.cleanup(
          'Redact Room roster live-authority diagnostics',
          () => redactMaestroArtifacts(output, secrets),
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
        matrixResources.cleanup(
          'Room roster live-authority Android device',
          () => device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Room roster live-authority Android WebView',
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
          console.info(`[room-roster-live-authority] ${entry.id} start`);
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
              `[room-roster-live-authority] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Room roster live-authority journey ${entry.id} failed`,
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
