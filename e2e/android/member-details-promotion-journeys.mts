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
  MEMBER_DETAILS_PROMOTION_SOURCES,
  memberDetailsPromotionAssertions as assertions,
  type MemberDetailsPromotionAssertion,
} from './member-details-promotion-contract.mts';
import {
  evaluateNative,
  waitForNativeShellState,
} from './native-shell-client.mts';

type AccountFixtures = ReturnType<typeof createAccountFixtures>;

interface SeededMemberRoom {
  readonly admin: NodeWorkspaceAccount;
  readonly member: NodeWorkspaceAccount;
  readonly memberName: string;
  readonly room: WorkspaceRoom;
}

interface OpenMembersAssertions {
  readonly roomTimelineVisible: MemberDetailsPromotionAssertion;
  readonly membersInitiallyHidden: MemberDetailsPromotionAssertion;
  readonly membersPanelVisible: MemberDetailsPromotionAssertion;
}

interface MemberInfoSurface {
  readonly display: string;
  readonly background: string;
  readonly height: number;
  readonly row: number;
  readonly viewport: number;
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

async function observedElements(
  client: AccountWorkspaceClient,
  assertionIdentity: MemberDetailsPromotionAssertion,
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
  assertionIdentity: MemberDetailsPromotionAssertion,
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

async function exactFeedbackDuringNativeAction(
  client: AccountWorkspaceClient,
  assertionIdentity: MemberDetailsPromotionAssertion,
  message: string,
  action: () => Promise<void>,
): Promise<void> {
  const capture = '__trinityMemberDetailsPromotionFeedback';
  await evaluateNative(client.webview, `(() => {
    const capture = ${JSON.stringify(capture)};
    window[capture]?.observer?.disconnect();
    const messages = [];
    const sample = () => {
      for (const element of document.querySelectorAll('[data-sonner-toast]')) {
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        if (rect.width <= 0 || rect.height <= 0 || style.visibility !== 'visible') continue;
        const text = element.textContent?.trim() ?? '';
        if (text && !messages.includes(text)) messages.push(text);
      }
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['class', 'style'],
    });
    window[capture] = { messages, observer };
    sample();
    return true;
  })()`);
  const failures: unknown[] = [];
  let messages: readonly string[] = [];
  try {
    await action();
    messages = await waitForNativeShellState(
      async () => {
        const value = await evaluateNative(
          client.webview,
          `window[${JSON.stringify(capture)}]?.messages ?? []`,
        );
        assert(
          Array.isArray(value) &&
            value.every((entry) => typeof entry === 'string'),
          `${assertionIdentity}: captured feedback must be text`,
        );
        return value as string[];
      },
      (observed) => observed.includes(message),
      assertionIdentity,
      client.signal,
      15_000,
    );
    await client.record(assertionIdentity, {
      assertion: assertionIdentity,
      message,
      observation: messages,
    });
  } catch (error) {
    failures.push(error);
    try {
      await client.record(assertionIdentity, {
        assertion: assertionIdentity,
        message,
        observation: messages,
        error: describeFailure(error),
      });
    } catch (diagnosticError) {
      failures.push(diagnosticError);
    }
  } finally {
    try {
      await evaluateNative(client.webview, `(() => {
        const capture = ${JSON.stringify(capture)};
        window[capture]?.observer?.disconnect();
        delete window[capture];
        return true;
      })()`);
    } catch (cleanupError) {
      failures.push(cleanupError);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(
      failures,
      `${assertionIdentity}: feedback capture failed`,
    );
  }
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

async function openMembers(
  client: AccountWorkspaceClient,
  fixture: SeededMemberRoom,
  stageAssertions: OpenMembersAssertions,
): Promise<void> {
  await client.tapCurrent('[data-testid="rail-rooms"]');
  await client.visible('.channel', { text: fixture.room.name }, 30_000);
  await client.tapCurrent('.channel', { text: fixture.room.name });
  await observedElements(
    client,
    stageAssertions.roomTimelineVisible,
    '[data-testid="composer-input"]',
    visibleOne,
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
    visibleOne,
  );
}

const memberInfoOpenAssertions: OpenMembersAssertions = {
  roomTimelineVisible: assertions.memberInfoRoomTimelineVisible,
  membersInitiallyHidden: assertions.memberInfoMembersInitiallyHidden,
  membersPanelVisible: assertions.memberInfoMembersPanelVisible,
};

const promotionOpenAssertions: OpenMembersAssertions = {
  roomTimelineVisible: assertions.promotionRoomTimelineVisible,
  membersInitiallyHidden: assertions.promotionMembersInitiallyHidden,
  membersPanelVisible: assertions.promotionMembersPanelVisible,
};

const memberInfoSurfaceExpression = `(() => {
  const host = document.querySelector('trn-member-info');
  if (!(host instanceof HTMLElement)) return null;
  const style = getComputedStyle(host);
  return {
    display: style.display,
    background: style.backgroundColor,
    height: host.getBoundingClientRect().height,
    row: host.closest('.chat-body')?.getBoundingClientRect().height ?? 0,
    viewport: visualViewport?.height ?? innerHeight,
  };
})()`;

function isMemberInfoSurface(value: unknown): value is MemberInfoSurface {
  if (value === null || typeof value !== 'object') return false;
  const surface = value as Partial<MemberInfoSurface>;
  return (
    typeof surface.display === 'string' &&
    typeof surface.background === 'string' &&
    typeof surface.height === 'number' &&
    typeof surface.row === 'number' &&
    typeof surface.viewport === 'number'
  );
}

async function observeMemberInfoSurface(
  client: AccountWorkspaceClient,
  identity: MemberDetailsPromotionAssertion,
  accepts: (surface: MemberInfoSurface) => boolean,
): Promise<void> {
  await observedExpression(
    client,
    identity,
    memberInfoSurfaceExpression,
    (value) => isMemberInfoSurface(value) && accepts(value),
  );
}

function memberPower(
  state: Readonly<Record<string, unknown>> | undefined,
  userId: string,
): unknown {
  if (!state) return undefined;
  const users = state['users'];
  if (users === null || typeof users !== 'object' || Array.isArray(users)) {
    return undefined;
  }
  return (
    Object.entries(users).find(([id]) => id === userId)?.[1] ??
    state['users_default'] ??
    0
  );
}

const memberInfoCase: AccountWorkspaceCase = {
  id: 'member-info',
  source: MEMBER_DETAILS_PROMOTION_SOURCES.memberInfo.definition,
  profile: PIXEL_5_ACCOUNT_PROFILE,
  async run({ client, fixtures, resources }) {
    const fixture = await seedMemberRoom(
      fixtures,
      'member-details',
      `Members ${resources.roomName('member-details-room')}`,
      `Member ${resources.roomName('member-details-name')}`,
    );
    await client.login(fixture.admin);
    await openMembers(client, fixture, memberInfoOpenAssertions);
    await observedElements(
      client,
      assertions.memberInfoRowHeight,
      '[data-testid="member-row"]',
      (elements) =>
        elements.length === 1 && elements[0]!.rect.height === 44,
      { text: fixture.memberName },
    );
    await observedElements(
      client,
      assertions.memberInfoHeaderHeight,
      '.members__section-label',
      (elements) =>
        elements.length >= 1 && elements[0]!.rect.height === 34,
    );
    await client.tapCurrent('[data-testid="member-row"]', {
      text: fixture.memberName,
    });
    await observedElements(
      client,
      assertions.memberInfoPanelVisible,
      '[data-testid="member-info"]',
      visibleOne,
    );
    await observedElements(
      client,
      assertions.memberInfoName,
      '[data-testid="member-info-name"]',
      visibleOne,
      { exactText: fixture.memberName },
    );
    await observedElements(
      client,
      assertions.memberInfoHandle,
      '[data-testid="member-info-handle"]',
      visibleOne,
      { exactText: fixture.member.userId },
    );
    await observedElements(
      client,
      assertions.memberInfoRole,
      '[data-testid="member-info"]',
      visibleOne,
      { text: 'Member' },
    );
    await observedElements(
      client,
      assertions.memberInfoMessageActionVisible,
      '[data-testid="member-info-message"]',
      visibleOne,
    );
    await observeMemberInfoSurface(
      client,
      assertions.memberInfoSurfaceDisplay,
      ({ display }) => display === 'flex',
    );
    await observeMemberInfoSurface(
      client,
      assertions.memberInfoSurfaceOpaque,
      ({ background }) =>
        !/rgba\(0, 0, 0, 0\)|transparent/.test(background),
    );
    await observeMemberInfoSurface(
      client,
      assertions.memberInfoSurfaceRowPositive,
      ({ row }) => row > 0,
    );
    await observeMemberInfoSurface(
      client,
      assertions.memberInfoSurfaceFullHeight,
      ({ height, viewport }) => Math.abs(height - viewport) <= 1,
    );
    await client.scrollIntoViewIfNeeded(
      '[data-testid="member-info-copy"]',
      '.member-info',
    );
    await exactFeedbackDuringNativeAction(
      client,
      assertions.memberInfoCopyToast,
      'User ID copied.',
      () => client.tapCurrent('[data-testid="member-info-copy"]'),
    );
    await client.tapCurrent('[data-testid="member-info-close"]');
    await observedElements(
      client,
      assertions.memberInfoPanelClosed,
      '[data-testid="member-info"]',
      (elements) => elements.length === 0,
    );
    await observedElements(
      client,
      assertions.memberInfoRosterRestored,
      '[data-testid="member-row"]',
      visibleOne,
      { text: fixture.memberName },
    );
    await client.tapCurrentExposed('[data-testid="members-backdrop"]');
    await client.tapCurrent('[data-testid="composer-input"]');
    await client.focused('[data-testid="composer-input"]');
    await client.pasteSystemClipboardFocused(
      '[data-testid="composer-input"]',
    );
    await observedElements(
      client,
      assertions.memberInfoClipboardMxid,
      '[data-testid="composer-input"]',
      (elements) =>
        elements.length === 1 &&
        elements.some((element) => element.value === fixture.member.userId),
    );
  },
};

const promotionCase: AccountWorkspaceCase = {
  id: 'promotion',
  source: MEMBER_DETAILS_PROMOTION_SOURCES.promotion.definition,
  profile: PIXEL_5_ACCOUNT_PROFILE,
  async run({ client, fixtures, resources }) {
    const fixture = await seedMemberRoom(
      fixtures,
      'member-promotion',
      `Promote ${resources.roomName('member-promotion-room')}`,
      `Promoted ${resources.roomName('member-promotion-name')}`,
    );
    await client.login(fixture.admin);
    await openMembers(client, fixture, promotionOpenAssertions);
    await observedElements(
      client,
      assertions.promotionModeratorAbsent,
      '.members__section-label',
      (elements) => elements.length === 0,
      { text: 'Moderator' },
    );
    await client.tapCurrent('[data-testid="member-row"]', {
      text: fixture.memberName,
    });
    await observedElements(
      client,
      assertions.promotionMemberInfoVisible,
      '[data-testid="member-info"]',
      visibleOne,
    );
    await client.scrollIntoViewIfNeeded(
      '[data-testid="member-info-role-50"]',
      '.member-info',
    );
    await client.tapCurrent('[data-testid="member-info-role-50"]');
    await client.visible('[data-testid="alert-confirm"]');
    await client.tapCurrent('[data-testid="alert-confirm"]');
    await observedElements(
      client,
      assertions.promotionModeratorSectionVisible,
      '.members__section-label',
      visibleOne,
      { text: 'Moderator' },
    );

    let observation: unknown = null;
    try {
      observation = await waitForNativeShellState(
        async () => {
          const sections = await client.elements('.members__section', {
            text: fixture.memberName,
          });
          const state = await fixtures.roomState(
            fixture.admin,
            fixture.room.id,
            'm.room.power_levels',
          );
          return {
            sections,
            power: memberPower(state, fixture.member.userId),
          };
        },
        ({ sections, power }) =>
          sections.length === 1 &&
          sections[0]!.visible &&
          sections[0]!.text.includes('Moderator') &&
          power === 50,
        assertions.promotionMemberRowAndServerPower,
        client.signal,
        30_000,
      );
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await client.record(assertions.promotionMemberRowAndServerPower, {
          assertion: assertions.promotionMemberRowAndServerPower,
          observation,
          error: describeFailure(error),
        });
      } catch (diagnosticError) {
        failures.push(diagnosticError);
      }
      throw new AggregateError(
        failures,
        `${assertions.promotionMemberRowAndServerPower}: ${describeFailure(error)}`,
      );
    }
    await client.record(assertions.promotionMemberRowAndServerPower, {
      assertion: assertions.promotionMemberRowAndServerPower,
      observation,
    });
  },
};

const cases: readonly AccountWorkspaceCase[] = [memberInfoCase, promotionCase];

assert.equal(
  cases.length,
  2,
  'Exactly two member details and promotion stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  25,
  'Exactly 25 member details and promotion assertions are required',
);

void test(
  'Android member details and promotion journeys',
  { timeout: 1_200_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'member-details-promotion',
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
          'Redact member details and promotion diagnostics',
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
          'Member details and promotion Android device',
          () => device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Member details and promotion Android WebView',
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
          console.info(`[member-details-promotion] ${entry.id} start`);
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
              `[member-details-promotion] ${entry.id} end ${stage.status} ${stage.durationMs.toFixed(0)}ms`,
            );
          }
          if (failures.length) {
            throw new AggregateError(
              failures,
              `Member details and promotion journey ${entry.id} failed`,
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
