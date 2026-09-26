import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { withNodeTestResources } from '../support/node-fixtures.mts';
import { readSession } from '../support/session.mts';
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
} from './account-workspace-fixtures.mts';
import { openMaestroDevice, redactMaestroArtifacts } from './maestro-session.mts';
import {
  installFirstMatrixHttpFailure,
  installMatrixRoomStateDelay,
  type MatrixHttpDelay,
  type MatrixHttpFault,
} from './matrix-http-fault.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import { bindRoomControl, roomControl } from './room-control-identity.mts';
import { switchBlockedSpaceSettingsAccount } from './space-settings-account-transition.mts';

const partialSource =
  'e2e/browser/journeys/room-administration/space-settings-resilience.spec.mts:69-143';
const continuitySource =
  'e2e/browser/journeys/room-administration/space-settings-resilience.spec.mts:69-82,145-305';

const assertions = {
  partialFailureFeedback: 'partial.failure-feedback',
  partialNameFirstAttempts: 'partial.name-first-attempts',
  partialTopicFirstAttempts: 'partial.topic-first-attempts',
  partialRetryFeedback: 'partial.retry-feedback',
  partialNameTotalAttempts: 'partial.name-total-attempts',
  partialTopicTotalAttempts: 'partial.topic-total-attempts',
  continuityOpeningAccount: 'continuity.opening-account',
  continuityNameSaving: 'continuity.name-saving',
  continuityActiveMember: 'continuity.active-member',
  continuityAccountRetained: 'continuity.account-retained',
  continuityNameSaved: 'continuity.name-saved',
  continuityTopicSaved: 'continuity.topic-saved',
  continuityTopicPersisted: 'continuity.topic-persisted',
  continuityAliasVisible: 'continuity.alias-visible',
  continuityAliasResolves: 'continuity.alias-resolves',
  continuityInvitePersisted: 'continuity.invite-persisted',
  continuityChildLinkCreated: 'continuity.child-link-created',
  continuityChildLinkRemoved: 'continuity.child-link-removed',
} as const;

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
  assertionIdentity: string,
  selector: string,
  accepts: (elements: readonly AccountElement[]) => boolean,
  filter: { readonly text?: string; readonly exactText?: string } = {},
  timeoutMs = 30_000,
): Promise<readonly AccountElement[]> {
  try {
    const elements = await client.waitElements(
      selector,
      accepts,
      assertionIdentity,
      filter,
      timeoutMs,
    );
    await client.record(assertionIdentity, {
      assertion: assertionIdentity,
      observation: elements,
    });
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
}

async function observedServerValue(
  client: AccountWorkspaceClient,
  assertionIdentity: string,
  read: () => Promise<unknown>,
  accepts: (value: unknown) => boolean,
): Promise<unknown> {
  const value = await waitForNativeShellState(
    read,
    accepts,
    assertionIdentity,
    client.signal,
    30_000,
  );
  await client.record(assertionIdentity, {
    assertion: assertionIdentity,
    observation: value,
  });
  return value;
}

async function recordCount(
  client: AccountWorkspaceClient,
  assertionIdentity: string,
  actual: number,
  expected: number,
): Promise<void> {
  assert.equal(actual, expected, `${assertionIdentity}: exact request count`);
  await client.record(assertionIdentity, {
    assertion: assertionIdentity,
    actual,
    expected,
  });
}

async function selectSpace(
  client: AccountWorkspaceClient,
  name: string,
): Promise<void> {
  const selector = `button[aria-label=${JSON.stringify(name)}]`;
  await client.visible(selector, {}, 30_000);
  await client.tapCurrent(selector);
  await client.visible('[data-testid="space-actions-overflow"]', {}, 30_000);
}

async function openSpaceSettings(
  client: AccountWorkspaceClient,
  name: string,
): Promise<void> {
  await selectSpace(client, name);
  await client.tapCurrent('[data-testid="space-actions-overflow"]');
  await client.tapCurrent('[data-testid="open-space-settings"]');
  await client.visible('[data-testid="space-settings"]', {}, 30_000);
  await client.tapCurrent('[data-testid="space-settings-tab-general"]');
  await client.visible('[data-testid="space-settings-panel-general"]');
}

async function openSettingsSection(
  client: AccountWorkspaceClient,
  section: 'addresses' | 'members' | 'contents',
): Promise<void> {
  await client.tapCurrent('[data-testid="space-settings-mobile-back"]');
  await client.tapCurrent(`[data-testid="space-settings-tab-${section}"]`);
  await client.visible(`[data-testid="space-settings-panel-${section}"]`);
}

async function withTopicFailure<T>(
  context: AccountWorkspaceCaseContext,
  spaceId: string,
  operation: (fault: MatrixHttpFault) => Promise<T>,
): Promise<T> {
  const { client, resources } = context;
  const connection = await client.webview.openSession();
  let fault: MatrixHttpFault | undefined;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    const failures: unknown[] = [];
    try {
      await fault?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      connection.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        'Space topic transport instrumentation cleanup failed',
      );
    }
  };
  resources.cleanup('Space topic transport instrumentation', cleanup);
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    fault = await installFirstMatrixHttpFailure(connection, {
      kind: 'room-state',
      roomId: spaceId,
      eventType: 'm.room.topic',
      status: 500,
      responseError: 'retry me',
    });
    result = await operation(fault);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await client.record('partial-transport', {
        target: { roomId: spaceId, eventType: 'm.room.topic' },
        injectedStatus: 500,
        responseError: 'retry me',
        matchingAttempts: fault?.attempts ?? 0,
        nameAttempts: fault?.roomStateAttempts('m.room.name') ?? 0,
        topicAttempts: fault?.roomStateAttempts('m.room.topic') ?? 0,
        firstOutcome: fault?.firstOutcome,
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(failures, 'Space topic transport operation failed');
  }
  return result as T;
}

async function withNameDelay<T>(
  context: AccountWorkspaceCaseContext,
  spaceId: string,
  operation: (delay: MatrixHttpDelay) => Promise<T>,
): Promise<T> {
  const { client, resources } = context;
  const connection = await client.webview.openSession();
  let controller: MatrixHttpDelay | undefined;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    const failures: unknown[] = [];
    try {
      await controller?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      connection.close();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(failures, 'Space name delay cleanup failed');
    }
  };
  resources.cleanup('Space name transport delay', cleanup);
  const failures: unknown[] = [];
  let result: T | undefined;
  try {
    controller = await installMatrixRoomStateDelay(connection, {
      roomId: spaceId,
      eventType: 'm.room.name',
    });
    result = await operation(controller);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await client.record('continuity-name-delay', {
        target: { roomId: spaceId, eventType: 'm.room.name' },
        matchingAttempts: controller?.attempts ?? 0,
        released: controller?.released ?? false,
      });
    } catch (error) {
      failures.push(error);
    }
    try {
      await cleanup();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length) {
    throw new AggregateError(failures, 'Space name delay operation failed');
  }
  return result as T;
}

async function realMembership(
  context: AccountWorkspaceCaseContext,
  assertionIdentity: string,
  observer: NodeWorkspaceAccount,
  roomId: string,
  member: NodeWorkspaceAccount,
  expected: 'invite' | 'join',
): Promise<void> {
  await observedServerValue(
    context.client,
    assertionIdentity,
    () => context.fixtures.roomMembership(observer, roomId, member),
    (value) => value === expected,
  );
}

const cases: readonly AccountWorkspaceCase[] = [
  {
    id: 'partial-general-retry',
    source: partialSource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client, fixtures, resources, signal } = context;
      const owner = await fixtures.account('space-partial-owner');
      const space = await fixtures.createRoom(owner, {
        name: `Partial space ${resources.roomName('space-partial')}`,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      await client.login(owner);
      await openSpaceSettings(client, space.name);

      await withTopicFailure(context, space.id, async (fault) => {
        // Avoid a whitespace word commit: Android's IME can autocorrect the
        // generated lowercase `android-…` token while native input is active.
        await client.replace(
          '[data-testid="space-settings-name"]',
          'PartialSpaceRenamed',
        );
        await client.fill(
          '[data-testid="space-settings-topic"]',
          'Eventually saved',
        );
        await client.tapCurrent('[data-testid="space-settings-save"]');
        await fault.waitForAttempts(
          1,
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        );
        await observedElements(
          client,
          assertions.partialFailureFeedback,
          '[data-testid="space-settings-general-feedback"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('still unsaved'),
        );
        await recordCount(
          client,
          assertions.partialNameFirstAttempts,
          fault.roomStateAttempts('m.room.name'),
          1,
        );
        await recordCount(
          client,
          assertions.partialTopicFirstAttempts,
          fault.roomStateAttempts('m.room.topic'),
          1,
        );

        await client.tapCurrent('[data-testid="space-settings-save"]');
        await observedElements(
          client,
          assertions.partialRetryFeedback,
          '[data-testid="space-settings-general-feedback"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Topic saved'),
        );
        await fault.waitForAttempts(
          2,
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        );
        await recordCount(
          client,
          assertions.partialNameTotalAttempts,
          fault.roomStateAttempts('m.room.name'),
          1,
        );
        await recordCount(
          client,
          assertions.partialTopicTotalAttempts,
          fault.roomStateAttempts('m.room.topic'),
          2,
        );
      });
    },
  },
  {
    id: 'opening-account-continuity',
    source: continuitySource,
    profile: PIXEL_5_ACCOUNT_PROFILE,
    async run(context) {
      const { client, fixtures, resources, signal } = context;
      const owner = await fixtures.account('space-continuity-owner');
      const member = await fixtures.account('space-continuity-member');
      const invitee = await fixtures.account('space-continuity-invitee');
      const space = await fixtures.createRoom(owner, {
        name: `Shared space ${resources.roomName('space-continuity')}`,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
        invite: [member.userId],
      });
      const child = await fixtures.createRoom(owner, {
        name: `Opening owner child ${resources.roomName('space-child')}`,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      await fixtures.join(member, space.id);

      await client.login(owner);
      await client.addAccount(member);
      await client.openMenu();
      await client.tapCurrent('[data-testid="account-row"]', {
        text: owner.userId,
      });
      await client.rooms(owner);
      await openSpaceSettings(client, space.name);
      await observedElements(
        client,
        assertions.continuityOpeningAccount,
        '[data-testid="space-settings-account"]',
        (elements) =>
          visibleOne(elements) && elements[0]!.text.includes(owner.userId),
      );

      await withNameDelay(context, space.id, async (nameDelay) => {
        await client.replace(
          '[data-testid="space-settings-name"]',
          'OpeningAccountSpaceRenamed',
        );
        await client.tapCurrent('[data-testid="space-settings-save"]');
        await nameDelay.waitForAttempts(
          1,
          AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
        );
        await observedElements(
          client,
          assertions.continuityNameSaving,
          '[data-testid="space-settings-save"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Saving'),
        );

        await switchBlockedSpaceSettingsAccount(
          client,
          member.userId,
          assertions.continuityActiveMember,
        );
        await observedElements(
          client,
          assertions.continuityAccountRetained,
          '[data-testid="space-settings-account"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes(owner.userId),
        );
        await nameDelay.release();
        await observedElements(
          client,
          assertions.continuityNameSaved,
          '[data-testid="space-settings-general-feedback"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Name saved'),
        );

        await client.fill(
          '[data-testid="space-settings-topic"]',
          'Owned by opening Account',
        );
        await client.tapCurrent('[data-testid="space-settings-save"]');
        await observedElements(
          client,
          assertions.continuityTopicSaved,
          '[data-testid="space-settings-general-feedback"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes('Topic saved'),
        );
        await observedServerValue(
          client,
          assertions.continuityTopicPersisted,
          () => fixtures.roomState(member, space.id, 'm.room.topic'),
          (value) =>
            (value as { readonly topic?: unknown } | undefined)?.topic ===
            'Owned by opening Account',
        );

        await openSettingsSection(client, 'addresses');
        const localpart = resources.aliasLocalpart('opening-owner');
        const alias = `#${localpart}:localhost`;
        await client.fill('[data-testid="room-alias-input"]', localpart);
        await client.tapCurrent('[data-testid="room-alias-add"]');
        await observedElements(
          client,
          assertions.continuityAliasVisible,
          '[data-testid="room-alias"]',
          (elements) => visibleOne(elements),
          { text: alias },
        );
        await observedServerValue(
          client,
          assertions.continuityAliasResolves,
          () => fixtures.resolveRoomAlias(member, alias),
          (value) => value === space.id,
        );

        await openSettingsSection(client, 'members');
        await client.tapCurrent('[data-testid="members-settings-invite"]');
        await client.fill('[aria-label="@user:server or a name"]', invitee.userId);
        await client.tapCurrent('.picker button', { exactText: 'Invite' });
        await realMembership(
          context,
          assertions.continuityInvitePersisted,
          owner,
          space.id,
          invitee,
          'invite',
        );
        fixtures.trackRoomMembership(invitee, space.id);

        await openSettingsSection(client, 'contents');
        await client.tapCurrent('[data-testid="space-contents-add-existing"]');
        await client.fill('[data-testid="space-contents-search"]', child.name);
        // Selectors reach the job log, so Room controls are found by the
        // Room's name, not the Room id in their test ids; read-only
        // observation binds each to the exact child Room.
        const picker = roomControl('.space-contents__candidate', 'space-contents-pick-', child.name, child.id);
        await client.visible(picker.selector, picker.filter, 30_000);
        await bindRoomControl(client, picker, 'Candidate pick is the exact child Room');
        await client.tapCurrent(picker.selector, picker.filter);
        await client.scrollIntoViewIfNeeded(
          '[data-testid="space-contents-add-confirm"]',
          '[data-testid="space-settings-detail"]',
        );
        await client.tapCurrent('[data-testid="space-contents-add-confirm"]');
        await observedServerValue(
          client,
          assertions.continuityChildLinkCreated,
          () => fixtures.spaceChild(member, space.id, child.id),
          (value) =>
            Array.isArray(
              (value as { readonly via?: unknown } | undefined)?.via,
            ),
        );

        const unlink = roomControl('.contents-list__row', 'space-content-unlink-', child.name, child.id);
        await client.scrollIntoViewIfNeeded(
          unlink.selector,
          '[data-testid="space-settings-detail"]',
          unlink.filter,
        );
        await bindRoomControl(client, unlink, 'Remove control belongs to the exact child Room');
        await client.tapCurrent(unlink.selector, unlink.filter);
        await client.tapCurrent('[data-testid="alert-confirm"]');
        await observedServerValue(
          client,
          assertions.continuityChildLinkRemoved,
          () => fixtures.spaceChild(member, space.id, child.id),
          (value) =>
            value !== undefined && Object.keys(value as object).length === 0,
        );
      });
    },
  },
];

assert.equal(
  cases.length,
  2,
  'Exactly two Space Settings resilience stages are required',
);
assert.equal(
  Object.keys(assertions).length,
  18,
  'Exactly eighteen direct assertions are required',
);

void test(
  'Android Space Settings resilience journeys',
  { timeout: 1_080_000 },
  async (context) => {
    await withNodeTestResources(
      { testId: context.name, signal: context.signal },
      async ({ matrixResources, signal }) => {
        const session = readSession();
        const output = join(
          process.env['TRINITY_E2E_REPORT_DIR'] ??
            join(session.workspaceRoot, 'dist/.playwright'),
          'space-settings-resilience',
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
        matrixResources.cleanup('Redact Space Settings resilience diagnostics', () =>
          redactMaestroArtifacts(output, secrets),
        );
        const device = await openMaestroDevice({
          workspaceRoot: session.workspaceRoot,
          signal,
          artifactDirectory: output,
          serial: process.env['TRINITY_ANDROID_SERIAL'],
        });
        matrixResources.cleanup('Space Settings resilience Android device', () =>
          device.close(),
        );
        let client: AccountWorkspaceClient | undefined;
        matrixResources.cleanup(
          'Space Settings resilience Android WebView',
          async () => client?.close(),
        );
        await device.install(
          join(
            session.workspaceRoot,
            'android/app/build/outputs/apk/debug/app-debug.apk',
          ),
        );
        const stages: Array<{
          id: string;
          source: string;
          status: 'running' | 'passed' | 'failed';
          durationMs: number;
          artifact: string;
          failureCount?: number;
          error?: string;
        }> = [];
        const save = (): Promise<void> =>
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
          console.info(`[space-settings-resilience] ${entry.id} start`);
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
            } catch (captureError) {
              failures.push(captureError);
            }
          } finally {
            try {
              await client.close();
            } catch (error) {
              failures.push(error);
            }
            client = undefined;
          }
          stage.durationMs = performance.now() - started;
          stage.failureCount = failures.length;
          if (failures.length) {
            stage.status = 'failed';
            stage.error = failures.map(describeFailure).join('\n');
          } else {
            stage.status = 'passed';
          }
          await save();
          console.info(
            `[space-settings-resilience] ${entry.id} end ${stage.status} ${Math.round(stage.durationMs)}ms`,
          );
          if (failures.length) {
            throw new AggregateError(failures, `${entry.id} failed`);
          }
        }
      },
    );
  },
);
