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
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import {
  MEMBER_MODERATION_SOURCES,
  memberModerationAssertions as assertions,
  memberRemovalActions,
  type MemberModerationAssertion,
} from './member-moderation-contract.mts';

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

interface SeededMemberRoom {
  readonly admin: NodeWorkspaceAccount;
  readonly member: NodeWorkspaceAccount;
  readonly memberName: string;
  readonly room: WorkspaceRoom;
}

interface MemberSurfaceAssertions {
  readonly roomTimelineVisible: MemberModerationAssertion;
  readonly membersInitiallyHidden: MemberModerationAssertion;
  readonly membersPanelVisible: MemberModerationAssertion;
  readonly memberInfoVisible: MemberModerationAssertion;
}

interface RemovalAssertions extends MemberSurfaceAssertions {
  readonly memberInfoClosed: MemberModerationAssertion;
  readonly rosterVisible: MemberModerationAssertion;
  readonly memberRowAbsent: MemberModerationAssertion;
  readonly serverMembership: MemberModerationAssertion;
}

const blockSurfaceAssertions: MemberSurfaceAssertions = {
  roomTimelineVisible: assertions.blockRoomTimelineVisible,
  membersInitiallyHidden: assertions.blockMembersInitiallyHidden,
  membersPanelVisible: assertions.blockMembersPanelVisible,
  memberInfoVisible: assertions.blockMemberInfoVisible,
};

const removalAssertions: Readonly<
  Record<(typeof memberRemovalActions)[number]['id'], RemovalAssertions>
> = {
  kick: {
    roomTimelineVisible: assertions.kickRoomTimelineVisible,
    membersInitiallyHidden: assertions.kickMembersInitiallyHidden,
    membersPanelVisible: assertions.kickMembersPanelVisible,
    memberInfoVisible: assertions.kickMemberInfoVisible,
    memberInfoClosed: assertions.kickMemberInfoClosed,
    rosterVisible: assertions.kickRosterVisible,
    memberRowAbsent: assertions.kickMemberRowAbsent,
    serverMembership: assertions.kickServerMembership,
  },
  ban: {
    roomTimelineVisible: assertions.banRoomTimelineVisible,
    membersInitiallyHidden: assertions.banMembersInitiallyHidden,
    membersPanelVisible: assertions.banMembersPanelVisible,
    memberInfoVisible: assertions.banMemberInfoVisible,
    memberInfoClosed: assertions.banMemberInfoClosed,
    rosterVisible: assertions.banRosterVisible,
    memberRowAbsent: assertions.banMemberRowAbsent,
    serverMembership: assertions.banServerMembership,
  },
};

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

async function observedElements(
  client: AccountWorkspaceClient,
  assertionIdentity: MemberModerationAssertion,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: { readonly text?: string; readonly exactText?: string } = {},
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

async function seedMemberRoom(
  fixtures: AccountFixtures,
  role: string,
  roomName: string,
  memberName: string,
): Promise<SeededMemberRoom> {
  const admin = await fixtures.account(`${role}-admin`);
  const member = await fixtures.account(`${role}-member`);
  await fixtures.setDisplayName(member, memberName);
  const room = await fixtures.createRoom(admin, {
    name: roomName,
    preset: 'private_chat',
    invite: [member.userId],
  });
  await fixtures.join(member, room.id);
  return { admin, member, memberName, room };
}

async function openMemberInfo(
  client: AccountWorkspaceClient,
  fixture: SeededMemberRoom,
  stageAssertions: MemberSurfaceAssertions,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: fixture.room.name }, 30_000);
  await client.tapCurrent('.channel', { text: fixture.room.name });
  await observedElements(
    client,
    stageAssertions.roomTimelineVisible,
    '[data-testid="composer-input"]',
    (elements) => elements.length === 1 && elements[0]!.visible,
  );
  await observedElements(
    client,
    stageAssertions.membersInitiallyHidden,
    '.chat-members',
    (elements) =>
      elements.length === 0 || elements.every((element) => !element.visible),
  );
  await client.tapCurrent('[data-testid="room-actions-overflow"]');
  await client.visible('[data-testid="overflow-toggle-members"]');
  await client.tapCurrent('[data-testid="overflow-toggle-members"]');
  await observedElements(
    client,
    stageAssertions.membersPanelVisible,
    '[data-testid="member-list"]',
    (elements) => elements.length === 1 && elements[0]!.visible,
  );
  await client.visible(
    '[data-testid="member-row"]',
    { text: fixture.memberName },
    20_000,
  );
  await client.tapCurrent('[data-testid="member-row"]', {
    text: fixture.memberName,
  });
  await observedElements(
    client,
    stageAssertions.memberInfoVisible,
    '[data-testid="member-info"]',
    (elements) => elements.length === 1 && elements[0]!.visible,
  );
}

async function observedMembership(
  client: AccountWorkspaceClient,
  fixtures: AccountFixtures,
  assertionIdentity: MemberModerationAssertion,
  fixture: SeededMemberRoom,
  expectedMembership: 'leave' | 'ban',
): Promise<void> {
  let observation: string | undefined;
  try {
    observation = await waitForNativeShellState(
      () =>
        fixtures.roomMembership(
          fixture.admin,
          fixture.room.id,
          fixture.member,
        ),
      (membership) => membership === expectedMembership,
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
        observation: observation ?? null,
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

const blockCase: AccountWorkspaceCase = {
  id: 'block',
  source: MEMBER_MODERATION_SOURCES.block.definition,
  profile: PIXEL_5_ACCOUNT_PROFILE,
  async run({ client, fixtures, resources }) {
    const fixture = await seedMemberRoom(
      fixtures,
      'member-block',
      `Block ${resources.roomName('member-block-room')}`,
      `Blocked ${resources.roomName('member-block-name')}`,
    );
    await client.login(fixture.admin);
    await openMemberInfo(client, fixture, blockSurfaceAssertions);
    await observedElements(
      client,
      assertions.blockActionBlockVisible,
      '[data-testid="member-info-ignore"]',
      (elements) => elements.length === 1 && elements[0]!.visible,
      { exactText: 'Block' },
    );
    await client.tapCurrent('[data-testid="member-info-ignore"]');
    await observedElements(
      client,
      assertions.blockActionUnblockVisible,
      '[data-testid="member-info-ignore"]',
      (elements) => elements.length === 1 && elements[0]!.visible,
      { exactText: 'Unblock' },
      30_000,
    );
  },
};

const generatedRemovalCases: AccountWorkspaceCase[] = [];
for (const moderation of memberRemovalActions) {
  generatedRemovalCases.push({
    id: moderation.id,
    source: MEMBER_MODERATION_SOURCES.removal.definitions,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const stageAssertions = removalAssertions[moderation.id];
      const fixture = await seedMemberRoom(
        fixtures,
        `member-${moderation.id}`,
        `${moderation.id} ${resources.roomName(`member-${moderation.id}-room`)}`,
        `${moderation.id} target ${resources.roomName(`member-${moderation.id}-name`)}`,
      );
      const { admin, member, memberName, room } = fixture;
      await client.login(admin);
      await openMemberInfo(client, fixture, stageAssertions);

      const actionSelector = `[data-testid="${moderation.actionTestId}"]`;
      await client.scrollIntoViewIfNeeded(actionSelector, '.member-info');
      await client.tapCurrent(actionSelector);
      await client.visible('[data-testid="alert-confirm"]');
      await client.tapCurrent('[data-testid="alert-confirm"]');
      await observedElements(
        client,
        stageAssertions.memberInfoClosed,
        '[data-testid="member-info"]',
        (elements) => elements.length === 0,
      );
      await observedElements(
        client,
        stageAssertions.rosterVisible,
        '[data-testid="member-list"]',
        (elements) => elements.length === 1 && elements[0]!.visible,
      );
      await observedElements(
        client,
        stageAssertions.memberRowAbsent,
        '[data-testid="member-row"]',
        (elements) => elements.length === 0,
        { text: memberName },
      );
      await observedMembership(
        client,
        fixtures,
        stageAssertions.serverMembership,
        { admin, member, memberName, room },
        moderation.expectedMembership,
      );
      fixtures.allowEndedMembershipCleanup(member, room.id);
    },
  });
}

const cases: readonly AccountWorkspaceCase[] = [
  blockCase,
  ...generatedRemovalCases,
];

assert.equal(
  cases.length,
  3,
  'Exactly three member moderation stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  22,
  'Exactly 22 member moderation assertions are required',
);

void test(
  'Android member moderation journeys',
  { timeout: 1_500_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'member-moderation',
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
        matrixResources.cleanup('Redact member moderation diagnostics', () =>
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
        matrixResources.cleanup('Member moderation Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Member moderation Android WebView',
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
          console.info(`[member-moderation] ${entry.id} start`);
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
              `[member-moderation] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Member moderation journey ${entry.id} failed`,
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
