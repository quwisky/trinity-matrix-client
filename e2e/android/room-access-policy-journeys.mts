import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { readSession } from '../support/session.mts';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  AccountWorkspaceClient,
  DESKTOP_ACCOUNT_PROFILE,
  type AccountElement,
  type AccountElementFilter,
  type AccountWorkspaceCase,
} from './account-workspace-client.mts';
import { createAccountFixtures } from './account-workspace-fixtures.mts';
import {
  ROOM_ACCESS_POLICY_SOURCES,
  roomAccessPolicyAssertions as assertions,
  type RoomAccessPolicyAssertion,
} from './room-access-policy-contract.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { withSpaceSettingsVisualFixture } from './space-settings-visual-fixture.mts';

function describeFailure(error: unknown): string {
  const message =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return error instanceof AggregateError
    ? `${message}\n${error.errors.map(describeFailure).join('\n')}`
    : message;
}

const visibleOne = (elements: readonly AccountElement[]): boolean =>
  elements.length === 1 && elements[0]!.visible;

async function observedElements(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomAccessPolicyAssertion,
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

async function observedServerValue<T>(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomAccessPolicyAssertion,
  observe: () => Promise<T>,
  accepts: (value: T) => boolean,
): Promise<T> {
  let observation: T | undefined;
  let value: T;
  try {
    value = await waitForNativeShellState(
      async () => {
        const latest = await observe();
        observation = latest;
        return latest;
      },
      accepts,
      assertionIdentity,
      client.signal,
      30_000,
    );
  } catch (error) {
    const failures: unknown[] = [error];
    try {
      await client.record(assertionIdentity, {
        assertion: assertionIdentity,
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
    observation: value ?? null,
  });
  return value;
}

async function focusByNativeTab(
  client: AccountWorkspaceClient,
  selector: string,
): Promise<AccountElement> {
  for (let attempt = 0; attempt < 48; attempt += 1) {
    const elements = await client.elements(selector);
    if (visibleOne(elements) && elements[0]!.focused) return elements[0]!;
    await client.key('tab');
  }
  const elements = await client.elements(selector);
  assert(
    visibleOne(elements) && elements[0]!.focused,
    `Native Tab did not focus ${selector}`,
  );
  return elements[0]!;
}

async function openRoom(
  client: AccountWorkspaceClient,
  roomName: string,
  assertionIdentity: RoomAccessPolicyAssertion,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: roomName }, 30_000);
  await client.tapCurrent('.channel', { text: roomName });
  await observedElements(
    client,
    assertionIdentity,
    '[data-testid="composer-input"]',
    visibleOne,
  );
}

async function selectSpaceRoom(
  client: AccountWorkspaceClient,
  spaceName: string,
  roomName: string,
  assertionIdentity: RoomAccessPolicyAssertion,
): Promise<void> {
  const pill = `button[aria-label=${JSON.stringify(spaceName)}]`;
  await client.visible(pill, {}, 30_000);
  await client.tapCurrent(pill);
  await client.visible('.channel', { text: roomName }, 30_000);
  await client.tapCurrent('.channel', { text: roomName });
  await observedElements(
    client,
    assertionIdentity,
    '[data-testid="composer-input"]',
    visibleOne,
  );
}

async function openAccessPanel(
  client: AccountWorkspaceClient,
  assertionIdentity: RoomAccessPolicyAssertion,
): Promise<void> {
  await client.tapCurrent('[data-testid="room-settings-tab-access"]');
  await observedElements(
    client,
    assertionIdentity,
    '[data-testid="room-settings-panel-access"]',
    visibleOne,
  );
}

function sameJson(value: unknown, expected: unknown): boolean {
  return isDeepStrictEqual(value, expected);
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'admin-public-history',
    source: ROOM_ACCESS_POLICY_SOURCES.adminPublicHistory,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('room-access-admin');
      const room = await fixtures.createRoom(owner, {
        name: `Access ${resources.roomName('admin-public-history')}`,
        preset: 'private_chat',
      });

      await client.login(owner);
      await openRoom(client, room.name, assertions.adminRoomTimelineVisible);
      await client.tapCurrent('[data-testid="open-room-settings"]');
      await observedElements(
        client,
        assertions.adminSettingsVisible,
        '[data-testid="room-settings"]',
        visibleOne,
      );
      await observedElements(
        client,
        assertions.adminAccessPanelInitiallyAbsent,
        '[data-testid="room-settings-panel-access"]',
        (elements) => elements.length === 0,
      );
      await openAccessPanel(client, assertions.adminAccessPanelVisible);
      await observedElements(
        client,
        assertions.adminGeneralPanelAbsent,
        '[data-testid="room-settings-panel-general"]',
        (elements) => elements.length === 0,
      );
      await observedElements(
        client,
        assertions.adminSectionHeadingFocused,
        '[data-testid="room-settings-section-heading"]',
        (elements) => visibleOne(elements) && elements[0]!.focused,
      );
      await observedElements(
        client,
        assertions.adminAliasesAbsent,
        '[data-testid="room-aliases"]',
        (elements) => elements.length === 0,
      );

      await client.tapCurrent('[data-testid="room-settings-join-rule"]');
      await client.tapCurrent('[data-testid="join-rule-public"]');
      await client.tapCurrent('[data-testid="room-settings-history"]');
      await client.tapCurrent('[data-testid="history-world_readable"]');

      await withSpaceSettingsVisualFixture(
        client,
        { dark: false, theme: null, fontSize: '125%' },
        async () => {
          await observedElements(
            client,
            assertions.adminSaveVisibleScaled,
            '[data-testid="room-settings-save"]',
            visibleOne,
          );
          await client.capture('room-access-admin-light-text-scale');
        },
      );
      await withSpaceSettingsVisualFixture(
        client,
        { dark: true, theme: 'amethyst' },
        () => client.capture('room-access-admin-dark-amethyst'),
      );
      await focusByNativeTab(client, '[data-testid="room-settings-save"]');
      await observedElements(
        client,
        assertions.adminSaveFocused,
        '[data-testid="room-settings-save"]',
        (elements) => visibleOne(elements) && elements[0]!.focused,
      );
      await client.key('enter');

      await observedServerValue(
        client,
        assertions.adminJoinRulePublic,
        () => fixtures.roomState(owner, room.id, 'm.room.join_rules'),
        (value) => value?.['join_rule'] === 'public',
      );
      await observedServerValue(
        client,
        assertions.adminHistoryWorldReadable,
        () => fixtures.roomState(owner, room.id, 'm.room.history_visibility'),
        (value) => value?.['history_visibility'] === 'world_readable',
      );
      await client.tapCurrent('[data-testid="room-settings-tab-addresses"]');
      await observedElements(
        client,
        assertions.adminAddressesVisible,
        '[data-testid="room-aliases"]',
        visibleOne,
      );
    },
  },
  {
    id: 'restricted-space-allow',
    source: ROOM_ACCESS_POLICY_SOURCES.restrictedSpace,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('room-access-restricted');
      const room = await fixtures.createRoom(owner, {
        name: `Restricted ${resources.roomName('restricted-room')}`,
        preset: 'private_chat',
        roomVersion: '9',
      });
      const space = await fixtures.createRoom(owner, {
        name: `Owner ${resources.roomName('restricted-space')}`,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      await fixtures.setSpaceChild(owner, space.id, room.id, {
        suggested: true,
      });

      await client.login(owner);
      await selectSpaceRoom(
        client,
        space.name,
        room.name,
        assertions.restrictedTimelineVisible,
      );
      await client.tapCurrent('[data-testid="open-room-settings"]');
      await observedElements(
        client,
        assertions.restrictedSettingsVisible,
        '[data-testid="room-settings"]',
        visibleOne,
      );
      await openAccessPanel(client, assertions.restrictedAccessPanelVisible);
      await client.tapCurrent('[data-testid="room-settings-join-rule"]');
      await client.tapCurrent('[data-testid="join-rule-restricted"]');
      const spaceOption = `[data-testid=${JSON.stringify(`room-settings-space-${space.id}`)}]`;
      await observedElements(
        client,
        assertions.restrictedSpaceOptionVisible,
        spaceOption,
        visibleOne,
      );
      await client.tapCurrent('[data-testid="room-settings-save"]');

      await observedServerValue(
        client,
        assertions.restrictedJoinRule,
        () => fixtures.roomState(owner, room.id, 'm.room.join_rules'),
        (value) => value?.['join_rule'] === 'restricted',
      );
      const expectedAllow = [
        { type: 'm.room_membership', room_id: space.id },
      ];
      await observedServerValue(
        client,
        assertions.restrictedAllow,
        () => fixtures.roomState(owner, room.id, 'm.room.join_rules'),
        (value) => sameJson(value?.['allow'], expectedAllow),
      );
    },
  },
  {
    id: 'revoke-space-access',
    source: ROOM_ACCESS_POLICY_SOURCES.revokeSpace,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('room-access-revoke');
      const room = await fixtures.createRoom(owner, {
        name: `Revoke ${resources.roomName('revoke-room')}`,
        preset: 'private_chat',
        roomVersion: '9',
      });
      const kept = await fixtures.createRoom(owner, {
        name: `Kept ${resources.roomName('kept-space')}`,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      const dropped = await fixtures.createRoom(owner, {
        name: `Dropped ${resources.roomName('dropped-space')}`,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      await fixtures.setSpaceChild(owner, kept.id, room.id, {
        suggested: true,
      });
      await fixtures.setSpaceChild(owner, dropped.id, room.id, {
        suggested: true,
      });
      const unknownAllowEntry = {
        type: 'org.example.membership_claim',
        room_id: kept.id,
        issuer: 'example.org',
      };
      await fixtures.setRoomState(owner, room.id, 'm.room.join_rules', {
        join_rule: 'restricted',
        allow: [
          { type: 'm.room_membership', room_id: kept.id },
          { type: 'm.room_membership', room_id: dropped.id },
          unknownAllowEntry,
        ],
      });

      await client.login(owner);
      await selectSpaceRoom(
        client,
        kept.name,
        room.name,
        assertions.revokeTimelineVisible,
      );
      await client.tapCurrent('[data-testid="open-room-settings"]');
      await client.visible('[data-testid="room-settings"]');
      await openAccessPanel(client, assertions.revokeAccessPanelVisible);
      const droppedOption = `[data-testid=${JSON.stringify(`room-settings-space-${dropped.id}`)}]`;
      await observedElements(
        client,
        assertions.revokeDroppedOptionVisible,
        droppedOption,
        visibleOne,
      );
      await client.tapCurrent(droppedOption);
      await client.tapCurrent('[data-testid="room-settings-save"]');

      const expectedAllow = [
        { type: 'm.room_membership', room_id: kept.id },
        unknownAllowEntry,
      ];
      await observedServerValue(
        client,
        assertions.revokeAllow,
        () => fixtures.roomState(owner, room.id, 'm.room.join_rules'),
        (value) => sameJson(value?.['allow'], expectedAllow),
      );
    },
  },
  {
    id: 'member-read-only',
    source: ROOM_ACCESS_POLICY_SOURCES.memberReadOnly,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('room-access-member-owner');
      const member = await fixtures.account('room-access-member-reader');
      const room = await fixtures.createRoom(owner, {
        name: `Member access ${resources.roomName('member-read-only')}`,
        preset: 'private_chat',
        invite: [member.userId],
      });
      await fixtures.setRoomState(
        owner,
        room.id,
        'm.room.history_visibility',
        { history_visibility: 'joined' },
      );
      await fixtures.join(member, room.id);

      await client.login(member);
      await openRoom(client, room.name, assertions.memberRoomTimelineVisible);
      await client.tapCurrent('[data-testid="open-room-settings"]');
      await client.visible('[data-testid="room-settings"]');
      await openAccessPanel(client, assertions.memberAccessPanelVisible);
      await observedElements(
        client,
        assertions.memberJoinRuleText,
        '[data-testid="room-settings-join-rule"]',
        visibleOne,
        { exactText: 'Invite only' },
      );
      await observedElements(
        client,
        assertions.memberHistoryText,
        '[data-testid="room-settings-history"]',
        visibleOne,
        { exactText: 'Members — since they joined' },
      );
      await observedElements(
        client,
        assertions.memberJoinRuleReadOnlyMessage,
        '.room-settings__restriction',
        visibleOne,
        { exactText: "Your role cannot change this room's join rule." },
      );
      await observedElements(
        client,
        assertions.memberHistoryReadOnlyMessage,
        '.room-settings__restriction',
        visibleOne,
        {
          exactText:
            "Your role cannot change this room's history visibility.",
        },
      );
      await observedElements(
        client,
        assertions.memberActionsAbsent,
        '[data-testid="room-settings-access-actions"]',
        (elements) => elements.length === 0,
      );
      await client.capture('room-access-member-read-only');
    },
  },
];

assert.equal(
  cases.length,
  4,
  'Exactly four Room access policy stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  29,
  'Exactly 29 Room access policy assertions are required',
);

void test(
  'Android Room access policy journeys',
  { timeout: 2_100_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'room-access-policy',
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
        matrixResources.cleanup('Redact Room access policy diagnostics', () =>
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
        matrixResources.cleanup('Room access policy Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Room access policy Android WebView',
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
          console.info(`[room-access-policy] ${entry.id} start`);
          try {
            await client.reset(entry.profile ?? DESKTOP_ACCOUNT_PROFILE);
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
              `[room-access-policy] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Room access policy journey ${entry.id} failed`,
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
