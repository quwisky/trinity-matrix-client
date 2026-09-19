import assert from 'node:assert/strict';
import {
  DESKTOP_ACCOUNT_PROFILE,
  type AccountWorkspaceCase,
  type AccountWorkspaceCaseContext,
} from './account-workspace-client.mts';
import type { NodeWorkspaceAccount } from './account-workspace-fixtures.mts';
import {
  installFirstMatrixHttpFailure,
  type MatrixHttpFault,
} from './matrix-http-fault.mts';
import { waitForNativeShellState } from './native-shell-client.mts';
import {
  contentsSource,
  spaceSettingsCoreAssertions as assertions,
} from './space-settings-core-contract.mts';
import {
  absent,
  observedElements,
  observedExpression,
  observedServerValue,
  openSettingsSection,
  openSpaceSettings,
  visibleOne,
} from './space-settings-core-observations.mts';
import { withSpaceSettingsVisualFixture } from './space-settings-visual-fixture.mts';

/** Register before native creation; discovery must not depend on successful UI assertions. */
export async function registerCreatedContentsCleanup(
  {
    fixtures,
    resources,
  }: Pick<AccountWorkspaceCaseContext, 'fixtures' | 'resources'>,
  owner: NodeWorkspaceAccount,
): Promise<void> {
  const existingIds = new Set(await fixtures.joinedRoomIds(owner));
  resources.cleanup(
    'discover UI-created Space contents memberships',
    async () => {
      // LIFO cleanup runs this before the fixture's leave/forget/logout, even on cancellation.
      const currentIds = await fixtures.joinedRoomIds(
        owner,
        AbortSignal.timeout(15_000),
      );
      for (const id of currentIds) {
        if (!existingIds.has(id)) fixtures.trackRoomMembership(owner, id);
      }
    },
  );
}

/** The new child ID is allocated by createRoom; only this parent's keyed links match. */
async function withChildLinkFailure(
  { client, resources }: AccountWorkspaceCaseContext,
  spaceId: string,
  operation: (fault: MatrixHttpFault) => Promise<void>,
): Promise<void> {
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
    if (failures.length)
      throw new AggregateError(
        failures,
        'Space contents transport cleanup failed',
      );
  };
  resources.cleanup('Space contents transport instrumentation', cleanup);
  const failures: unknown[] = [];
  try {
    fault = await installFirstMatrixHttpFailure(connection, {
      kind: 'room-state',
      roomId: spaceId,
      eventType: 'm.space.child',
      stateKey: '*',
      status: 403,
      responseError: 'link rejected',
    });
    await operation(fault);
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      await client.record('contents-transport', {
        target: { roomId: spaceId, eventType: 'm.space.child', stateKey: '*' },
        injectedStatus: 403,
        matchingAttempts: fault?.attempts ?? 0,
        createRoomAttempts: fault?.createRoomAttempts ?? 0,
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
  if (failures.length)
    throw new AggregateError(failures, 'Space contents recovery failed');
}

export const spaceSettingsCoreContentsCase: AccountWorkspaceCase = {
  id: 'exact-contents-lifecycle',
  source: contentsSource,
  profile: DESKTOP_ACCOUNT_PROFILE,
  async run(context) {
    const { client, fixtures, resources, signal } = context;
    const owner = await fixtures.account('space-settings-contents');
    const runId = resources.roomName('contents');
    const space = await fixtures.createRoom(owner, {
      name: `Contents ${runId}`,
      preset: 'private_chat',
      creation_content: { type: 'm.space' },
    });
    const linked = await fixtures.createRoom(owner, {
      name: `Linked ${runId}`,
      preset: 'private_chat',
    });
    const candidate = await fixtures.createRoom(owner, {
      name: `Candidate Room ${runId}`,
      preset: 'private_chat',
    });
    const candidateSpace = await fixtures.createRoom(owner, {
      name: `Candidate Space ${runId}`,
      preset: 'private_chat',
      creation_content: { type: 'm.space' },
    });
    const createdSpaceName = `Created Space ${runId}`;
    const recoveredName = `Recovered ${runId}`;
    await fixtures.setSpaceChild(owner, space.id, linked.id);
    await client.login(owner);
    await openSpaceSettings(client, space.name);
    await openSettingsSection(client, 'contents');
    const panel = '[data-testid="space-settings-panel-contents"]';
    const detail = '[data-testid="space-settings-detail"]';
    const linkedRow = `${panel} [data-testid="space-content-${linked.id}"]`;
    await observedElements(
      client,
      assertions.contentsPanelVisible,
      panel,
      visibleOne,
    );
    await observedElements(
      client,
      assertions.contentsLinkedName,
      `${linkedRow} strong`,
      visibleOne,
      { exactText: linked.name },
    );
    await observedElements(
      client,
      assertions.contentsLinkedTypeRoom,
      linkedRow,
      (elements) => visibleOne(elements) && elements[0]!.text.includes('Room'),
    );
    await withSpaceSettingsVisualFixture(
      client,
      { fontSize: '125%' },
      async () => {
        await observedElements(
          client,
          assertions.contentsScaledCreateSpaceVisible,
          `${panel} [data-testid="space-contents-create-space"]`,
          visibleOne,
        );
        await observedExpression(
          client,
          assertions.contentsScaledNoOverflow,
          `(() => {
        const panel = document.querySelector(${JSON.stringify(panel)});
        return panel instanceof HTMLElement && panel.scrollWidth <= panel.clientWidth + 1;
      })()`,
          (value) => value === true,
        );
      },
    );

    await client.tapCurrent('[data-testid="space-contents-add-existing"]');
    await client.fill('[data-testid="space-contents-search"]', 'Candidate');
    const candidateCheckbox = `[data-testid="space-contents-pick-${candidate.id}"] [role="checkbox"]`;
    await client.visible(candidateCheckbox);
    // Search precedes the alphabetically first candidate. Native Tab establishes focus.
    await client.focused('[data-testid="space-contents-search"]');
    await client.key('tab');
    await client.focused(candidateCheckbox);
    await client.key('space');
    await client.tapCurrent(
      `[data-testid="space-contents-pick-${candidateSpace.id}"]`,
    );
    await client.scrollIntoViewIfNeeded(
      '[data-testid="space-contents-add-confirm"]',
      detail,
    );
    await client.tapCurrent('[data-testid="space-contents-add-confirm"]');
    await observedServerValue(
      client,
      assertions.contentsCandidateRoomLinked,
      () => fixtures.spaceChild(owner, space.id, candidate.id),
      (value) => Array.isArray(value?.['via']),
    );
    await observedServerValue(
      client,
      assertions.contentsCandidateSpaceLinked,
      () => fixtures.spaceChild(owner, space.id, candidateSpace.id),
      (value) => Array.isArray(value?.['via']),
    );

    await registerCreatedContentsCleanup(context, owner);
    const childrenBeforeCreate = await fixtures.spaceChildIds(owner, space.id);
    await client.scrollIntoViewIfNeeded(
      '[data-testid="space-contents-create-space"]',
      detail,
    );
    await client.tapCurrent('[data-testid="space-contents-create-space"]');
    await client.fill('input[placeholder="Space name"]', createdSpaceName);
    await client.tapCurrent('[data-testid="alert-confirm"]');
    const createdIds = await waitForNativeShellState(
      async () =>
        (await fixtures.spaceChildIds(owner, space.id)).filter(
          (id) => !childrenBeforeCreate.includes(id),
        ),
      (ids) => ids.length === 1,
      'one newly linked Space id',
      signal,
      30_000,
    );
    const createdSpaceId = createdIds[0]!;
    fixtures.trackRoomMembership(owner, createdSpaceId);
    await observedServerValue(
      client,
      assertions.contentsCreatedSpaceLinked,
      () => fixtures.spaceChild(owner, space.id, createdSpaceId),
      (value) => Array.isArray(value?.['via']),
    );
    const createdSpaceRow = `${panel} [data-testid="space-content-${createdSpaceId}"]`;
    await observedElements(
      client,
      assertions.contentsCreatedSpaceType,
      `${createdSpaceRow} .contents-list__kind`,
      (elements) => visibleOne(elements) && elements[0]!.text === 'Space',
    );

    await withChildLinkFailure(context, space.id, async (fault) => {
      await client.scrollIntoViewIfNeeded(
        '[data-testid="space-contents-create-room"]',
        detail,
      );
      await client.tapCurrent('[data-testid="space-contents-create-room"]');
      await client.fill('input[placeholder="Room name"]', recoveredName);
      await client.tapCurrent('[data-testid="alert-confirm"]');
      const recovery = `${panel} [data-testid="space-contents-recovery"]`;
      await observedElements(
        client,
        assertions.contentsRecoveryVisible,
        recovery,
        visibleOne,
      );
      await observedElements(
        client,
        assertions.contentsRecoveryName,
        recovery,
        (elements) =>
          visibleOne(elements) && elements[0]!.text.includes(recoveredName),
      );
      const recovered = await observedElements(
        client,
        assertions.contentsRecoveredId,
        `${recovery} p`,
        (elements) => visibleOne(elements) && /^!/.test(elements[0]!.text),
      );
      const recoveredId = recovered[0]!.text;
      fixtures.trackRoomMembership(owner, recoveredId);
      await observedServerValue(
        client,
        assertions.contentsCreateFirstCount,
        async () => fault.createRoomAttempts,
        (value) => value === 1,
      );
      assert.equal(
        fault.attempts,
        1,
        'Only the first parent child-link write failed',
      );
      const childrenBeforeRetry = await fixtures.spaceChildIds(owner, space.id);
      assert(
        !childrenBeforeRetry.includes(recoveredId),
        'The failed link did not persist',
      );

      // The controller fails its first match only; keep it installed to count retry creations.
      await client.scrollIntoViewIfNeeded(
        '[data-testid="space-contents-retry-link"]',
        detail,
      );
      await client.tapCurrent('[data-testid="space-contents-retry-link"]');
      await observedElements(
        client,
        assertions.contentsRecoveryDismissed,
        recovery,
        absent,
      );
      await observedServerValue(
        client,
        assertions.contentsRecoveredLinked,
        async () => ({
          child: await fixtures.spaceChild(owner, space.id, recoveredId),
          addedIds: (await fixtures.spaceChildIds(owner, space.id)).filter(
            (id) => !childrenBeforeRetry.includes(id),
          ),
        }),
        (value) =>
          Array.isArray(value.child?.['via']) &&
          value.addedIds.length === 1 &&
          value.addedIds[0] === recoveredId,
      );
      await observedServerValue(
        client,
        assertions.contentsCreateRetryCount,
        async () => fault.createRoomAttempts,
        (value) => value === 1,
      );
      assert.equal(
        fault.attempts,
        2,
        'Recovery retries exactly the parent child-link write',
      );
      await observedServerValue(
        client,
        assertions.contentsNoChildParentGovernance,
        () =>
          fixtures.roomState(owner, recoveredId, 'm.space.parent', space.id),
        (value) => value === undefined,
      );
    });

    const linkedUnlink = `[data-testid="space-content-unlink-${linked.id}"]`;
    const removeDialog = '[data-testid="alert-surface"]';
    await client.scrollIntoViewIfNeeded(linkedUnlink, detail);
    await client.tapCurrent(linkedUnlink);
    await client.visible(`${removeDialog} h2`, {
      exactText: 'Remove Room from Space',
    });
    await observedElements(
      client,
      assertions.contentsRemoveRoomName,
      removeDialog,
      (elements) =>
        visibleOne(elements) && elements[0]!.text.includes(linked.name),
    );
    await observedElements(
      client,
      assertions.contentsRemoveRoomParentName,
      removeDialog,
      (elements) =>
        visibleOne(elements) && elements[0]!.text.includes(space.name),
    );
    await observedElements(
      client,
      assertions.contentsRemoveRoomNotDeleted,
      removeDialog,
      (elements) =>
        visibleOne(elements) && elements[0]!.text.includes('not deleted'),
    );
    await client.tapCurrent('[data-testid="alert-cancel"]');
    await observedServerValue(
      client,
      assertions.contentsCancelKeepsRoomLinked,
      () => fixtures.spaceChild(owner, space.id, linked.id),
      (value) => Array.isArray(value?.['via']),
    );
    await client.tapCurrent(linkedUnlink);
    await client.tapCurrent('[data-testid="alert-confirm"]');
    await observedServerValue(
      client,
      assertions.contentsRoomUnlinked,
      () => fixtures.spaceChild(owner, space.id, linked.id),
      (value) => value !== undefined && Object.keys(value).length === 0,
    );
    await observedServerValue(
      client,
      assertions.contentsRoomMembershipRetained,
      () => fixtures.roomMembership(owner, linked.id, owner),
      (value) => value === 'join',
    );
    await client.capture('space-contents-desktop');

    const createdSpaceUnlink = `[data-testid="space-content-unlink-${createdSpaceId}"]`;
    await client.scrollIntoViewIfNeeded(createdSpaceUnlink, detail);
    await client.tapCurrent(createdSpaceUnlink);
    await client.visible(`${removeDialog} h2`, {
      exactText: 'Remove Space from Space',
    });
    await observedElements(
      client,
      assertions.contentsRemoveSpaceName,
      removeDialog,
      (elements) =>
        visibleOne(elements) && elements[0]!.text.includes(createdSpaceName),
    );
    await observedElements(
      client,
      assertions.contentsRemoveSpaceParentName,
      removeDialog,
      (elements) =>
        visibleOne(elements) && elements[0]!.text.includes(space.name),
    );
    await client.tapCurrent('[data-testid="alert-confirm"]');
    await observedServerValue(
      client,
      assertions.contentsSpaceUnlinked,
      () => fixtures.spaceChild(owner, space.id, createdSpaceId),
      (value) => value !== undefined && Object.keys(value).length === 0,
    );
    await observedServerValue(
      client,
      assertions.contentsSpaceMembershipRetained,
      () => fixtures.roomMembership(owner, createdSpaceId, owner),
      (value) => value === 'join',
    );
    await withSpaceSettingsVisualFixture(
      client,
      { dark: true, theme: 'amethyst' },
      () => client.capture('space-contents-desktop-dark-amethyst'),
    );

    await fixtures.setRoomPower(owner, space.id, owner.userId, 0);
    await observedServerValue(
      client,
      assertions.contentsDemoteWrite,
      () => fixtures.roomState(owner, space.id, 'm.room.power_levels'),
      (value) => {
        const users = value?.['users'];
        return (
          users !== null &&
          typeof users === 'object' &&
          Object.entries(users).some(
            ([userId, power]) => userId === owner.userId && power === 0,
          )
        );
      },
    );
    await observedElements(
      client,
      assertions.contentsActionsHidden,
      `${panel} [data-testid="space-contents-actions"]`,
      absent,
    );
    await observedElements(
      client,
      assertions.contentsCandidateSpaceVisible,
      `${panel} [data-testid="space-content-${candidateSpace.id}"]`,
      visibleOne,
    );
    await observedElements(
      client,
      assertions.contentsUnlinkHidden,
      `${panel} [data-testid="space-content-unlink-${candidateSpace.id}"]`,
      absent,
    );
    await observedElements(
      client,
      assertions.contentsSuggestHidden,
      `${panel} [data-testid="space-content-suggest-${candidateSpace.id}"]`,
      absent,
    );
    await observedElements(
      client,
      assertions.contentsMoveUpHidden,
      `${panel} [data-testid="space-content-move-up-${candidateSpace.id}"]`,
      absent,
    );
  },
};
