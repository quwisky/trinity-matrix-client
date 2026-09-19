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
import {
  MEMBER_ROLE_CLASSIFICATION_SOURCES,
  memberRoleClassificationAssertions as assertions,
  type MemberRoleClassificationAssertion,
} from './member-role-classification-contract.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

interface RoleParticipant {
  readonly account: NodeWorkspaceAccount;
  readonly name: string;
  readonly power: number;
}

interface SeededRoleRoom {
  readonly owner: RoleParticipant;
  readonly extras: readonly RoleParticipant[];
  readonly room: WorkspaceRoom;
}

interface OpenMembersAssertions {
  readonly roomTimelineVisible: MemberRoleClassificationAssertion;
  readonly rosterInitiallyHidden: MemberRoleClassificationAssertion;
  readonly rosterVisible: MemberRoleClassificationAssertion;
}

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

function exactVisibleTexts(
  elements: readonly AccountElement[],
  expected: readonly string[],
): boolean {
  return (
    elements.length === expected.length &&
    elements.every(
      (element, index) => element.visible && element.text === expected[index],
    )
  );
}

function exactArray(value: unknown, expected: readonly unknown[]): boolean {
  return Array.isArray(value) && JSON.stringify(value) === JSON.stringify(expected);
}

async function observedElements(
  client: AccountWorkspaceClient,
  assertionIdentity: MemberRoleClassificationAssertion,
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

async function observedExpression(
  client: AccountWorkspaceClient,
  assertionIdentity: MemberRoleClassificationAssertion,
  expression: string,
  accepts: (value: unknown) => boolean,
  timeoutMs = 30_000,
): Promise<unknown> {
  let observation: unknown = null;
  let value: unknown;
  try {
    value = await waitForNativeShellState(
      async () => {
        const latest = await evaluateNative(client.webview, expression);
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

async function seedRoleRoom(
  fixtures: AccountFixtures,
  role: string,
  roomName: string,
  powers: readonly number[],
): Promise<SeededRoleRoom> {
  const ownerAccount = await fixtures.account(`${role}-owner`);
  const ownerName = `Owner ${roomName}`;
  await fixtures.setDisplayName(ownerAccount, ownerName);
  const owner: RoleParticipant = {
    account: ownerAccount,
    name: ownerName,
    power: 100,
  };
  const extras: RoleParticipant[] = [];
  for (const [index, power] of powers.entries()) {
    const account = await fixtures.account(`${role}-p${index}`);
    const name = `Person ${index} ${roomName}`;
    await fixtures.setDisplayName(account, name);
    extras.push({ account, name, power });
  }
  const room = await fixtures.createRoom(owner.account, {
    name: roomName,
    preset: 'private_chat',
    invite: extras.map(({ account }) => account.userId),
  });
  for (const extra of extras) {
    await fixtures.join(extra.account, room.id);
    if (extra.power > 0) {
      await fixtures.setRoomPower(
        owner.account,
        room.id,
        extra.account.userId,
        extra.power,
      );
    }
  }
  return { owner, extras, room };
}

async function openMembers(
  client: AccountWorkspaceClient,
  roomLabel: string,
  stageAssertions: OpenMembersAssertions,
  selectRooms = true,
): Promise<void> {
  if (selectRooms) {
    await client.tapCurrent('[data-testid="rail-rooms"]');
  }
  await client.visible('.channel', { text: roomLabel }, 30_000);
  await client.tapCurrent('.channel', { text: roomLabel });
  await observedElements(
    client,
    stageAssertions.roomTimelineVisible,
    '.scroll',
    visibleOne,
  );
  await observedElements(
    client,
    stageAssertions.rosterInitiallyHidden,
    '.chat-members',
    (elements) =>
      elements.length === 0 || elements.every((element) => !element.visible),
  );
  await client.tapCurrent('[data-testid="room-actions-overflow"]');
  await client.visible('[data-testid="overflow-toggle-members"]');
  await client.tapCurrent('[data-testid="overflow-toggle-members"]');
  await observedElements(
    client,
    stageAssertions.rosterVisible,
    '[data-testid="member-list"]',
    visibleOne,
  );
}

const sharedOpenAssertions: OpenMembersAssertions = {
  roomTimelineVisible: assertions.openMembersRoomTimelineVisible,
  rosterInitiallyHidden: assertions.openMembersRosterInitiallyHidden,
  rosterVisible: assertions.openMembersRosterVisible,
};

const directMessageOpenAssertions: OpenMembersAssertions = {
  roomTimelineVisible: assertions.directMessageRoomTimelineVisible,
  rosterInitiallyHidden: assertions.directMessageRosterInitiallyHidden,
  rosterVisible: assertions.directMessageRosterVisible,
};

const groupingCase: AccountWorkspaceCase = {
  id: 'grouping',
  source: MEMBER_ROLE_CLASSIFICATION_SOURCES.grouping,
  profile: PIXEL_5_ACCOUNT_PROFILE,
  async run({ client, fixtures, resources }) {
    const fixture = await seedRoleRoom(
      fixtures,
      'role-grouping',
      `Roles ${resources.roomName('role-grouping-room')}`,
      [50, 0],
    );
    const [moderator, plain] = fixture.extras;
    assert(moderator && plain);
    await client.login(fixture.owner.account);
    await openMembers(client, fixture.room.name, sharedOpenAssertions);
    await observedElements(
      client,
      assertions.groupingMemberCount,
      '[data-testid="member-list"] [data-testid="member-row"]',
      (elements) => elements.length === 3 && elements.every(({ visible }) => visible),
    );
    await observedElements(
      client,
      assertions.groupingSectionLabels,
      '.members__section-label',
      (elements) =>
        exactVisibleTexts(elements, [
          'Owner — 1',
          'Moderator — 1',
          'Member — 1',
        ]),
    );
    await observedElements(
      client,
      assertions.groupingHeaderHeights,
      '.members__section-label',
      (elements) =>
        exactArray(
          elements.map(({ rect }) => rect.height),
          [34, 34, 34],
        ),
    );
    await observedElements(
      client,
      assertions.groupingRowHeights,
      '[data-testid="member-list"] [data-testid="member-row"]',
      (elements) =>
        exactArray(
          elements.map(({ rect }) => rect.height),
          [44, 44, 44],
        ),
    );
    await observedExpression(
      client,
      assertions.groupingGroupLabels,
      `[...document.querySelectorAll('.members__section')].map((element) => element.getAttribute('aria-label'))`,
      (value) =>
        exactArray(value, [
          'Owner, 1 member',
          'Moderator, 1 member',
          'Member, 1 member',
        ]),
    );
    await observedElements(
      client,
      assertions.groupingOwnerMember,
      '.members__section[aria-label="Owner, 1 member"] [data-testid="member-row"]',
      visibleOne,
      { text: fixture.owner.name },
    );
    await observedElements(
      client,
      assertions.groupingModeratorMember,
      '.members__section[aria-label="Moderator, 1 member"] [data-testid="member-row"]',
      visibleOne,
      { text: moderator.name },
    );
    await observedElements(
      client,
      assertions.groupingPlainMember,
      '.members__section[aria-label="Member, 1 member"] [data-testid="member-row"]',
      visibleOne,
      { text: plain.name },
    );
    await observedElements(
      client,
      assertions.groupingModeratorName,
      '.members__section[aria-label="Moderator, 1 member"] [data-testid="member-row"] .member__name',
      visibleOne,
      { exactText: moderator.name },
    );
  },
};

const directMessageCase: AccountWorkspaceCase = {
  id: 'direct-message',
  source: MEMBER_ROLE_CLASSIFICATION_SOURCES.directMessage,
  profile: PIXEL_5_ACCOUNT_PROFILE,
  async run({ client, fixtures, resources }) {
    const me = await fixtures.account('role-dm-me');
    const them = await fixtures.account('role-dm-them');
    const meName = `Me ${resources.roomName('role-dm-me')}`;
    const themName = `Them ${resources.roomName('role-dm-them')}`;
    await fixtures.setDisplayName(me, meName);
    await fixtures.setDisplayName(them, themName);
    await fixtures.createDirectRoom(me, them, {
      preset: 'trusted_private_chat',
    });
    await client.login(me);
    await openMembers(client, themName, directMessageOpenAssertions, false);
    await observedElements(
      client,
      assertions.directMessageMemberCount,
      '[data-testid="member-list"] [data-testid="member-row"]',
      (elements) => elements.length === 2 && elements.every(({ visible }) => visible),
    );
    await observedElements(
      client,
      assertions.directMessageAdminSection,
      '.members__section-label',
      (elements) => exactVisibleTexts(elements, ['Admin — 2']),
    );
    await observedElements(
      client,
      assertions.directMessageOwnerAbsent,
      '.members__section-label',
      (elements) => elements.length === 0,
      { text: 'Owner' },
    );
    await client.tapCurrent('[data-testid="member-row"]', { text: meName });
    await observedElements(
      client,
      assertions.directMessagePanelVisible,
      '[data-testid="member-info"]',
      visibleOne,
    );
    await observedElements(
      client,
      assertions.directMessageRoleAdmin,
      '[data-testid="member-info-role"]',
      visibleOne,
      { exactText: 'Admin' },
    );
  },
};

const ownerPanelCase: AccountWorkspaceCase = {
  id: 'owner-panel',
  source: MEMBER_ROLE_CLASSIFICATION_SOURCES.ownerPanel,
  profile: PIXEL_5_ACCOUNT_PROFILE,
  async run({ client, fixtures, resources }) {
    const fixture = await seedRoleRoom(
      fixtures,
      'role-owner-panel',
      `Owner ${resources.roomName('role-owner-panel-room')}`,
      [0],
    );
    await client.login(fixture.owner.account);
    await openMembers(client, fixture.room.name, sharedOpenAssertions);
    await observedElements(
      client,
      assertions.ownerPanelMemberCount,
      '[data-testid="member-list"] [data-testid="member-row"]',
      (elements) => elements.length === 2 && elements.every(({ visible }) => visible),
    );
    await client.tapCurrent('[data-testid="member-row"]', {
      text: fixture.owner.name,
    });
    await observedElements(
      client,
      assertions.ownerPanelPanelVisible,
      '[data-testid="member-info"]',
      visibleOne,
    );
    await observedElements(
      client,
      assertions.ownerPanelRoleOwner,
      '[data-testid="member-info-role"]',
      visibleOne,
      { exactText: 'Owner' },
    );
  },
};

const ownerAdminCase: AccountWorkspaceCase = {
  id: 'owner-admin',
  source: MEMBER_ROLE_CLASSIFICATION_SOURCES.ownerAdmin,
  profile: PIXEL_5_ACCOUNT_PROFILE,
  async run({ client, fixtures, resources }) {
    const fixture = await seedRoleRoom(
      fixtures,
      'role-owner-admin',
      `Owner admin ${resources.roomName('role-owner-admin-room')}`,
      [100],
    );
    const [admin] = fixture.extras;
    assert(admin);
    await client.login(fixture.owner.account);
    await openMembers(client, fixture.room.name, sharedOpenAssertions);
    await observedElements(
      client,
      assertions.ownerAdminMemberCount,
      '[data-testid="member-list"] [data-testid="member-row"]',
      (elements) => elements.length === 2 && elements.every(({ visible }) => visible),
    );
    await observedElements(
      client,
      assertions.ownerAdminSectionLabels,
      '.members__section-label',
      (elements) =>
        exactVisibleTexts(elements, ['Owner — 1', 'Admin — 1']),
    );
    await observedElements(
      client,
      assertions.ownerAdminOwnerMember,
      '.members__section[aria-label="Owner, 1 member"] [data-testid="member-row"]',
      visibleOne,
      { text: fixture.owner.name },
    );
    await observedElements(
      client,
      assertions.ownerAdminAdminMember,
      '.members__section[aria-label="Admin, 1 member"] [data-testid="member-row"]',
      visibleOne,
      { text: admin.name },
    );
  },
};

const cases: readonly AccountWorkspaceCase[] = [
  groupingCase,
  directMessageCase,
  ownerPanelCase,
  ownerAdminCase,
];

assert.equal(
  cases.length,
  4,
  'Exactly four member role classification stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  27,
  'Exactly 27 member role classification assertions are required',
);

void test(
  'Android member role classification journeys',
  { timeout: 1_800_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'member-role-classification',
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
          'Redact member role classification diagnostics',
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
          'Member role classification Android device',
          () => device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Member role classification Android WebView',
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
          console.info(`[member-role-classification] ${entry.id} start`);
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
            try {
              await save();
            } catch (error) {
              failures.push(error);
            }
            console.info(
              `[member-role-classification] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Member role classification journey ${entry.id} failed`,
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
