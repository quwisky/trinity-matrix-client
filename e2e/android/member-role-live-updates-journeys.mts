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
import {
  createAccountFixtures,
  type NodeWorkspaceAccount,
  type WorkspaceRoom,
} from './account-workspace-fixtures.mts';
import {
  memberRoleClassificationAssertions as inheritedAssertions,
  type MemberRoleClassificationAssertion,
} from './member-role-classification-contract.mts';
import {
  MEMBER_ROLE_LIVE_UPDATE_SOURCES,
  memberRoleLiveUpdateAssertions as assertions,
  type MemberRoleLiveUpdateAssertion,
} from './member-role-live-updates-contract.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

type AccountFixtures = ReturnType<typeof createAccountFixtures>;
type EvidenceAssertion =
  | MemberRoleLiveUpdateAssertion
  | MemberRoleClassificationAssertion;

interface SeededRoleRoom {
  readonly owner: NodeWorkspaceAccount;
  readonly ownerName: string;
  readonly member?: NodeWorkspaceAccount;
  readonly memberName?: string;
  readonly room: WorkspaceRoom;
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

async function observedElements(
  client: AccountWorkspaceClient,
  assertionIdentity: EvidenceAssertion,
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

async function observedExpression(
  client: AccountWorkspaceClient,
  assertionIdentity: EvidenceAssertion,
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
  includeMember = true,
): Promise<SeededRoleRoom> {
  const owner = await fixtures.account(`${role}-owner`);
  const ownerName = `Owner ${roomName}`;
  await fixtures.setDisplayName(owner, ownerName);
  const member = includeMember
    ? await fixtures.account(`${role}-member`)
    : undefined;
  const memberName = member ? `Member ${roomName}` : undefined;
  if (member && memberName) {
    await fixtures.setDisplayName(member, memberName);
  }
  const room = await fixtures.createRoom(owner, {
    name: roomName,
    preset: 'private_chat',
    ...(member ? { invite: [member.userId] } : {}),
  });
  if (member) {
    await fixtures.join(member, room.id);
  }
  const powerLevels = await fixtures.roomState(
    owner,
    room.id,
    'm.room.power_levels',
  );
  assert(powerLevels, 'Seeded role Room has power levels');
  await fixtures.setRoomState(owner, room.id, 'm.room.power_levels', {
    ...powerLevels,
    invite: 50,
  });
  return { owner, ownerName, member, memberName, room };
}

async function openMembers(
  client: AccountWorkspaceClient,
  roomLabel: string,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomLabel }, 30_000);
  await client.tapCurrent('.channel', { text: roomLabel });
  await observedElements(
    client,
    inheritedAssertions.openMembersRoomTimelineVisible,
    '.scroll',
    visibleOne,
  );
  await observedElements(
    client,
    inheritedAssertions.openMembersRosterInitiallyHidden,
    '.chat-members',
    (elements) =>
      elements.length === 0 || elements.every((element) => !element.visible),
  );
  await client.tapCurrent('[data-testid="room-actions-overflow"]');
  await client.visible('[data-testid="overflow-toggle-members"]');
  await client.tapCurrent('[data-testid="overflow-toggle-members"]');
  await observedElements(
    client,
    inheritedAssertions.openMembersRosterVisible,
    '[data-testid="member-list"]',
    visibleOne,
  );
}

async function focusByNativeTab(
  client: AccountWorkspaceClient,
  selector: string,
  filter: AccountElementFilter = {},
): Promise<AccountElement> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const elements = await client.elements(selector, filter);
    if (elements.length === 1 && elements[0]!.visible && elements[0]!.focused) {
      return elements[0]!;
    }
    await client.key('tab');
  }
  const elements = await client.elements(selector, filter);
  assert(
    elements.length === 1 && elements[0]!.visible && elements[0]!.focused,
    `Native Tab did not focus ${selector}`,
  );
  return elements[0]!;
}

async function dismissCompactRoster(
  client: AccountWorkspaceClient,
): Promise<void> {
  await client.device.adb('shell', 'input', 'keyevent', '4');
  await waitForNativeShellState(
    () =>
      evaluateNative(
        client.webview,
        `(window.visualViewport?.height ?? innerHeight) >= innerHeight - 20`,
      ),
    (value) => value === true,
    'native keyboard dismissed before compact roster Back',
    client.signal,
    10_000,
  );
  await client.device.adb('shell', 'input', 'keyevent', '4');
  await client.waitElements(
    '[data-testid="member-list"]',
    (elements) =>
      elements.length === 0 || elements.every((element) => !element.visible),
    'compact member roster dismissed',
  );
}

async function demoteViewer(
  client: AccountWorkspaceClient,
  fixtures: AccountFixtures,
  fixture: SeededRoleRoom,
  receiptName: string,
): Promise<void> {
  await fixtures.setRoomPower(
    fixture.owner,
    fixture.room.id,
    fixture.owner.userId,
    0,
  );
  await client.record(receiptName, {
    actor: fixture.owner.userId,
    member: fixture.owner.userId,
    from: 100,
    to: 0,
  });
}

const livePromotionCase: AccountWorkspaceCase = {
  id: 'live-promotion',
  source: MEMBER_ROLE_LIVE_UPDATE_SOURCES.livePromotion,
  profile: PIXEL_5_ACCOUNT_PROFILE,
  async run({ client, fixtures, resources }) {
    const fixture = await seedRoleRoom(
      fixtures,
      'role-live-promotion',
      `Live roles ${resources.roomName('role-live-promotion-room')}`,
    );
    assert(fixture.member && fixture.memberName);
    await client.login(fixture.owner);
    await openMembers(client, fixture.room.name);
    await observedElements(
      client,
      assertions.livePromotionMemberCount,
      '[data-testid="member-list"] [data-testid="member-row"]',
      (elements) => elements.length === 2 && elements.every(({ visible }) => visible),
    );
    await observedElements(
      client,
      assertions.livePromotionInitialSectionLabels,
      '.members__section-label',
      (elements) => exactVisibleTexts(elements, ['Owner — 1', 'Member — 1']),
    );

    await fixtures.setRoomPower(
      fixture.owner,
      fixture.room.id,
      fixture.member.userId,
      50,
    );
    await client.record('live-promotion-transition', {
      actor: fixture.owner.userId,
      member: fixture.member.userId,
      from: 0,
      to: 50,
    });
    await observedElements(
      client,
      assertions.livePromotionFinalSectionLabels,
      '.members__section-label',
      (elements) =>
        exactVisibleTexts(elements, ['Owner — 1', 'Moderator — 1']),
    );
    await observedElements(
      client,
      assertions.livePromotionModeratorMember,
      '.members__section[aria-label="Moderator, 1 member"] [data-testid="member-row"]',
      visibleOne,
      { text: fixture.memberName },
    );
  },
};

const permissionLossCase: AccountWorkspaceCase = {
  id: 'permission-loss',
  source: MEMBER_ROLE_LIVE_UPDATE_SOURCES.permissionLoss,
  profile: PIXEL_5_ACCOUNT_PROFILE,
  async run({ client, fixtures, resources }) {
    const fixture = await seedRoleRoom(
      fixtures,
      'role-permission-loss',
      `Permission roles ${resources.roomName('role-permission-loss-room')}`,
    );
    assert(fixture.member && fixture.memberName);
    await client.login(fixture.owner);
    await openMembers(client, fixture.room.name);
    await client.tapCurrent('[data-testid="member-row"]', {
      text: fixture.memberName,
    });
    await observedElements(
      client,
      assertions.permissionLossKickInitiallyEnabled,
      '[data-testid="member-info-kick"]',
      (elements) =>
        visibleOne(elements) &&
        elements[0]!.attributes['aria-disabled'] !== 'true',
    );

    await demoteViewer(
      client,
      fixtures,
      fixture,
      'permission-loss-transition',
    );
    await observedElements(
      client,
      assertions.permissionLossKickDisabled,
      '[data-testid="member-info-kick"]',
      (elements) =>
        visibleOne(elements) &&
        elements[0]!.attributes['aria-disabled'] === 'true',
    );
    await observedExpression(
      client,
      assertions.permissionLossKickDescription,
      `document.querySelector('[data-testid="member-info-kick"]')?.getAttribute('aria-description')`,
      (value) => value === 'You can only manage members with a lower role.',
    );
    await focusByNativeTab(client, '[data-testid="member-info-kick"]');
    await observedElements(
      client,
      assertions.permissionLossTooltip,
      '[role="tooltip"]',
      (elements) =>
        elements.some(
          (element) =>
            element.visible &&
            element.text.includes(
              'You can only manage members with a lower role.',
            ),
        ),
    );
    await client.key('enter');
    await client.key('space');
    await observedElements(
      client,
      assertions.permissionLossRemoveDialogAbsent,
      '[role="dialog"]',
      (elements) => elements.length === 0,
      { text: 'Remove from room' },
    );

    await client.tapCurrent('[data-testid="member-info-close"]');
    await client.waitElements(
      '[data-testid="member-info"]',
      (elements) => elements.length === 0,
      'member info closed before compact roster dismissal',
    );
    await dismissCompactRoster(client);
    await client.tapCurrent('[data-testid="room-actions-overflow"]');
    await observedElements(
      client,
      assertions.permissionLossInviteDisabled,
      '[data-testid="overflow-invite-people"]',
      (elements) =>
        visibleOne(elements) &&
        elements[0]!.attributes['aria-disabled'] === 'true',
    );
    await focusByNativeTab(client, '[data-testid="overflow-invite-people"]');
    await client.key('enter');
    await client.key('space');
    await observedElements(
      client,
      assertions.permissionLossInviteDialogAbsent,
      '[role="dialog"]',
      (elements) => elements.length === 0,
      { text: 'Invite to' },
    );
  },
};

const settingsDemotionCase: AccountWorkspaceCase = {
  id: 'settings-demotion',
  source: MEMBER_ROLE_LIVE_UPDATE_SOURCES.settingsDemotion,
  profile: PIXEL_5_ACCOUNT_PROFILE,
  async run({ client, fixtures, resources }) {
    const fixture = await seedRoleRoom(
      fixtures,
      'role-settings-demotion',
      `Settings roles ${resources.roomName('role-settings-demotion-room')}`,
      false,
    );
    await client.login(fixture.owner);
    await openMembers(client, fixture.room.name);
    await dismissCompactRoster(client);
    await client.tapCurrent('[data-testid="room-actions-overflow"]');
    await client.tapCurrent('[data-testid="overflow-open-room-settings"]');
    await observedElements(
      client,
      assertions.settingsDemotionSurfaceVisible,
      '[data-testid="room-settings"]',
      visibleOne,
    );
    await client.tapCurrent('[data-testid="room-settings-tab-general"]');
    await observedElements(
      client,
      assertions.settingsDemotionNameInitiallyEnabled,
      '[data-testid="room-settings-name"]',
      (elements) => visibleOne(elements) && elements[0]!.disabled === false,
    );

    await demoteViewer(
      client,
      fixtures,
      fixture,
      'settings-demotion-transition',
    );
    await observedElements(
      client,
      assertions.settingsDemotionNameText,
      '[data-testid="room-settings-name"]',
      visibleOne,
      { exactText: fixture.room.name },
    );
    await observedExpression(
      client,
      assertions.settingsDemotionNameParagraph,
      `document.querySelector('[data-testid="room-settings-name"]')?.tagName`,
      (tagName) => tagName === 'P',
    );
    await observedElements(
      client,
      assertions.settingsDemotionGeneralActionsAbsent,
      '[data-testid="room-settings-general-actions"]',
      (elements) => elements.length === 0,
    );
    await client.tapCurrent('[data-testid="room-settings-mobile-back"]');
    await client.tapCurrent('[data-testid="room-settings-tab-addresses"]');
    await observedElements(
      client,
      assertions.settingsDemotionAliasesReadOnly,
      '[data-testid="room-aliases-read-only"]',
      (elements) =>
        visibleOne(elements) &&
        elements[0]!.text.includes(
          "Your role cannot change this room's addresses.",
        ),
    );
    await observedElements(
      client,
      assertions.settingsDemotionAliasInputAbsent,
      '[data-testid="room-alias-input"]',
      (elements) => elements.length === 0,
    );
    await observedElements(
      client,
      assertions.settingsDemotionAliasAddAbsent,
      '[data-testid="room-alias-add"]',
      (elements) => elements.length === 0,
    );
    await observedElements(
      client,
      assertions.settingsDemotionAliasSetMainAbsent,
      '[data-testid="room-alias-set-main"]',
      (elements) => elements.length === 0,
    );
    await observedElements(
      client,
      assertions.settingsDemotionAliasRemoveAbsent,
      '[data-testid="room-alias-remove"]',
      (elements) => elements.length === 0,
    );
  },
};

const touchFeedbackCase: AccountWorkspaceCase = {
  id: 'touch-feedback',
  source: MEMBER_ROLE_LIVE_UPDATE_SOURCES.touchFeedback,
  profile: PIXEL_5_ACCOUNT_PROFILE,
  async run({ client, fixtures, resources }) {
    const fixture = await seedRoleRoom(
      fixtures,
      'role-touch-feedback',
      `Touch roles ${resources.roomName('role-touch-feedback-room')}`,
    );
    assert(fixture.member && fixture.memberName);
    await client.login(fixture.owner);
    await openMembers(client, fixture.room.name);
    await client.tapCurrent('[data-testid="member-row"]', {
      text: fixture.memberName,
    });
    await demoteViewer(
      client,
      fixtures,
      fixture,
      'touch-feedback-transition',
    );
    await observedElements(
      client,
      assertions.touchFeedbackKickDisabled,
      '[data-testid="member-info-kick"]',
      (elements) =>
        visibleOne(elements) &&
        elements[0]!.attributes['aria-disabled'] === 'true',
    );
    await observedElements(
      client,
      assertions.touchFeedbackKickVisible,
      '[data-testid="member-info-kick"]',
      visibleOne,
    );
    await client.tapCurrent('[data-testid="member-info-kick"]');
    await observedElements(
      client,
      assertions.touchFeedbackExactCopy,
      '[data-testid="action-unavailable-feedback"]',
      (elements) =>
        visibleOne(elements) &&
        elements[0]!.text ===
          'You can only manage members with a lower role.',
    );
    await observedElements(
      client,
      assertions.touchFeedbackRemoveDialogAbsent,
      '[role="dialog"]',
      (elements) => elements.length === 0,
      { text: 'Remove from room' },
    );
  },
};

const cases: readonly AccountWorkspaceCase[] = [
  livePromotionCase,
  permissionLossCase,
  settingsDemotionCase,
  touchFeedbackCase,
];

assert.equal(
  cases.length,
  4,
  'Exactly four member role live-update stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  25,
  'Exactly 25 member role live-update assertions are required',
);

void test(
  'Android member role live updates journeys',
  { timeout: 1_800_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'member-role-live-updates',
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
          'Redact member role live updates diagnostics',
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
          'Member role live updates Android device',
          () => device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Member role live updates Android WebView',
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
          console.info(`[member-role-live-updates] ${entry.id} start`);
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
              `[member-role-live-updates] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Member role live updates journey ${entry.id} failed`,
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
