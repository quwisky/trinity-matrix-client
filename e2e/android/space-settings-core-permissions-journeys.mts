import assert from 'node:assert/strict';
import {
  DESKTOP_ACCOUNT_PROFILE,
  type AccountWorkspaceCase,
} from './account-workspace-client.mts';
import {
  addressSource,
  membersSource,
  permissionSource,
  readonlySource,
  spaceSettingsCoreAssertions as assertions,
} from './space-settings-core-contract.mts';
import {
  absent,
  observedElements,
  observedExpression,
  observedServerValue,
  openSettingsSection,
  openSpaceMenu,
  openSpaceSettings,
  visibleOne,
} from './space-settings-core-observations.mts';
import { bindRoomControl, roomControl, roomRow } from './room-control-identity.mts';

function memberPower(
  state: Readonly<Record<string, unknown>> | undefined,
  userId: string,
): unknown {
  assert(state, 'Matrix power levels exist');
  const users = state['users'];
  assert(
    users !== null && typeof users === 'object' && !Array.isArray(users),
    'Matrix power levels contain a users map',
  );
  return (
    Object.entries(users).find(([id]) => id === userId)?.[1] ??
    state['users_default'] ??
    0
  );
}

export const spaceSettingsCorePermissionCases: readonly AccountWorkspaceCase[] =
  [
    {
      id: 'readonly-member',
      source: readonlySource,
      profile: DESKTOP_ACCOUNT_PROFILE,
      async run({ client, fixtures, resources }) {
        const owner = await fixtures.account('space-settings-readonly-owner');
        const member = await fixtures.account('space-settings-readonly-member');
        const runId = resources.roomName('ro');
        const space = await fixtures.createRoom(owner, {
          name: `ReadOnly ${runId}`,
          preset: 'private_chat',
          creation_content: { type: 'm.space' },
        });
        const child = await fixtures.createRoom(owner, {
          name: `Visible child ${runId}`,
          preset: 'private_chat',
        });
        await fixtures.setSpaceChild(owner, space.id, child.id);
        await fixtures.invite(owner, space.id, member);
        await fixtures.join(member, space.id);
        await fixtures.invite(owner, child.id, member);
        await fixtures.join(member, child.id);
        const membership = {
          space: await fixtures.roomMembership(owner, space.id, member),
          child: await fixtures.roomMembership(owner, child.id, member),
          power: memberPower(
            await fixtures.roomState(owner, space.id, 'm.room.power_levels'),
            member.userId,
          ),
        };
        await client.record('readonly-member-fixture', membership);
        assert.deepEqual(membership, {
          space: 'join',
          child: 'join',
          power: 0,
        });

        await client.login(member);
        await openSpaceSettings(client, space.name);
        await observedElements(
          client,
          assertions.readonlyName,
          '[data-testid="space-settings-name"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text === space.name,
        );
        await observedElements(
          client,
          assertions.readonlyNoTopic,
          '[data-testid="space-settings-topic"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text === 'No topic set.',
        );
        await observedExpression(
          client,
          assertions.readonlyNameParagraph,
          `document.querySelector('[data-testid="space-settings-name"]')?.tagName`,
          (value) => value === 'P',
        );
        await observedExpression(
          client,
          assertions.readonlyTopicParagraph,
          `document.querySelector('[data-testid="space-settings-topic"]')?.tagName`,
          (value) => value === 'P',
        );
        await observedElements(
          client,
          assertions.readonlyGeneralActionsHidden,
          '[data-testid="space-settings-general-actions"]',
          absent,
        );

        await openSettingsSection(client, 'access');
        // trn-select keeps the test ID on its host; the inner combobox owns disabled.
        await observedElements(
          client,
          assertions.readonlyJoinRuleDisabled,
          '[data-testid="space-settings-join-rule"] [role="combobox"]',
          (elements) =>
            visibleOne(elements) &&
            (elements[0]!.disabled ||
              elements[0]!.attributes['aria-disabled'] === 'true'),
        );
        await observedElements(
          client,
          assertions.readonlyPermissionExplanation,
          '[data-testid="space-settings-panel-access"] .space-settings__restriction',
          visibleOne,
          { exactText: "Your role cannot change this room's join rule." },
        );
        await observedElements(
          client,
          assertions.readonlyAccessPolicy,
          '[data-testid="space-settings-panel-access"] .space-settings__hint',
          visibleOne,
          { text: 'Rooms inside it keep their own access' },
        );
        await observedElements(
          client,
          assertions.readonlyAccessActionsHidden,
          '[data-testid="space-settings-access-actions"]',
          absent,
        );

        await openSettingsSection(client, 'contents');
        const panel = '[data-testid="space-settings-panel-contents"]';
        // Selectors reach the job log: contents controls are found by the
        // Room's name and bound to the exact Room by read-only observation.
        const childRow = roomRow(`${panel} .contents-list__row`, 'space-content-', child.name, child.id);
        const childUnlink = roomControl(`${panel} .contents-list__row`, 'space-content-unlink-', child.name, child.id);
        await observedElements(
          client,
          assertions.readonlyChildVisible,
          `${childRow.selector} strong`,
          visibleOne,
          { exactText: child.name },
        );
        await bindRoomControl(client, childRow, 'Read-only contents row is the exact child Room');
        await observedElements(
          client,
          assertions.readonlyContentsActionsHidden,
          `${panel} [data-testid="space-contents-actions"]`,
          absent,
        );
        await observedElements(
          client,
          assertions.readonlyUnlinkHidden,
          childUnlink.selector,
          absent,
          childUnlink.filter,
        );
        await observedElements(
          client,
          assertions.readonlyContentsExplanation,
          `${panel} [data-testid="space-contents-read-only"]`,
          visibleOne,
        );
        await client.capture('space-access-member-read-only');
      },
    },
    {
      id: 'permission-loss-draft',
      source: permissionSource,
      profile: DESKTOP_ACCOUNT_PROFILE,
      async run({ client, fixtures, resources }) {
        const owner = await fixtures.account('space-settings-permission-owner');
        const member = await fixtures.account(
          'space-settings-permission-member',
        );
        const runId = resources.roomName('permissionloss');
        const space = await fixtures.createRoom(owner, {
          name: `Permission loss ${runId}`,
          preset: 'private_chat',
          creation_content: { type: 'm.space' },
        });
        const unsavedTopic = `Keep this draft ${runId}`;
        await fixtures.invite(owner, space.id, member);
        await fixtures.join(member, space.id);
        await fixtures.setRoomPower(owner, space.id, member.userId, 50);
        const promoted = {
          membership: await fixtures.roomMembership(owner, space.id, member),
          power: memberPower(
            await fixtures.roomState(owner, space.id, 'm.room.power_levels'),
            member.userId,
          ),
        };
        await client.record('permission-promoted-fixture', promoted);
        assert.deepEqual(promoted, { membership: 'join', power: 50 });

        await client.login(member);
        await openSpaceSettings(client, space.name);
        await observedExpression(
          client,
          assertions.permissionTopicEditable,
          `(() => {
          const topic = document.querySelector('[data-testid="space-settings-topic"]');
          if (!(topic instanceof HTMLTextAreaElement)) return false;
          const rect = topic.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 &&
            getComputedStyle(topic).visibility === 'visible' &&
            !topic.disabled && !topic.readOnly;
        })()`,
          (value) => value === true,
        );
        await client.fill('[data-testid="space-settings-topic"]', unsavedTopic);
        await observedElements(
          client,
          assertions.permissionActionsVisible,
          '[data-testid="space-settings-general-actions"]',
          visibleOne,
        );

        await fixtures.setRoomPower(owner, space.id, member.userId, 0);
        const demotedPower = memberPower(
          await fixtures.roomState(owner, space.id, 'm.room.power_levels'),
          member.userId,
        );
        await client.record('permission-demoted-fixture', {
          power: demotedPower,
        });
        assert.equal(demotedPower, 0);
        await observedExpression(
          client,
          assertions.permissionTopicReadonly,
          `document.querySelector('[data-testid="space-settings-topic"]')?.getAttribute('aria-readonly')`,
          (value) => value === 'true',
        );
        // AccountElement.value observes inputs only; retain the textarea's live value.
        await observedExpression(
          client,
          assertions.permissionDraftRetained,
          `document.querySelector('[data-testid="space-settings-topic"]')?.value`,
          (value) => value === unsavedTopic,
        );
        await observedElements(
          client,
          assertions.permissionDraftExplanation,
          '#space-settings-topic-blocked',
          visibleOne,
          { text: 'This unsaved Topic edit is now read-only.' },
        );
        await observedElements(
          client,
          assertions.permissionDiscardVisible,
          '[data-testid="space-settings-discard"]',
          visibleOne,
        );
        await observedElements(
          client,
          assertions.permissionSaveDisabled,
          '[data-testid="space-settings-save"]',
          (elements) => visibleOne(elements) && elements[0]!.disabled,
        );
      },
    },
    {
      id: 'address-via-enter',
      source: addressSource,
      profile: DESKTOP_ACCOUNT_PROFILE,
      async run({ client, fixtures, resources }) {
        const owner = await fixtures.account('space-settings-address');
        const runId = resources.aliasLocalpart('sa');
        const space = await fixtures.createRoom(owner, {
          name: `Addressed ${runId}`,
          preset: 'private_chat',
          creation_content: { type: 'm.space' },
        });
        const localpart = `space-addr-${runId}`;
        const alias = `#${localpart}:localhost`;

        await client.login(owner);
        await openSpaceSettings(client, space.name);
        await openSettingsSection(client, 'addresses');
        await observedElements(
          client,
          assertions.addressPanelVisible,
          '[data-testid="room-aliases"]',
          visibleOne,
        );
        await client.fill('[data-testid="room-alias-input"]', localpart);
        await client.focused('[data-testid="room-alias-input"]');
        await client.key('enter');
        await observedElements(
          client,
          assertions.addressDialogRetained,
          '[data-testid="space-settings"]',
          visibleOne,
        );
        await observedElements(
          client,
          assertions.addressVisible,
          '[data-testid="room-alias"] [data-testid="room-alias-value"]',
          visibleOne,
          { exactText: alias },
        );
        await observedServerValue(
          client,
          assertions.addressResolves,
          () => fixtures.resolveRoomAlias(owner, alias),
          (roomId) => roomId === space.id,
        );
      },
    },
    {
      id: 'owner-admin-roster',
      source: membersSource,
      profile: DESKTOP_ACCOUNT_PROFILE,
      async run({ client, fixtures, resources }) {
        const owner = await fixtures.account('space-settings-roster-owner');
        const peer = await fixtures.account('space-settings-roster-admin');
        const space = await fixtures.createRoom(owner, {
          name: `Owned ${resources.roomName('som')}`,
          preset: 'private_chat',
          creation_content: { type: 'm.space' },
        });
        await fixtures.invite(owner, space.id, peer);
        await fixtures.join(peer, space.id);
        // Each fixture call reads and merges the current event, preserving other powers.
        await fixtures.setRoomPower(owner, space.id, owner.userId, 100);
        await fixtures.setRoomPower(owner, space.id, peer.userId, 100);
        const powers = await fixtures.roomState(
          owner,
          space.id,
          'm.room.power_levels',
        );
        const roster = {
          ownerMembership: await fixtures.roomMembership(
            owner,
            space.id,
            owner,
          ),
          peerMembership: await fixtures.roomMembership(owner, space.id, peer),
          ownerPower: memberPower(powers, owner.userId),
          peerPower: memberPower(powers, peer.userId),
        };
        await client.record('members-equal-power-fixture', roster);
        assert.deepEqual(roster, {
          ownerMembership: 'join',
          peerMembership: 'join',
          ownerPower: 100,
          peerPower: 100,
        });

        await client.login(owner);
        await openSpaceMenu(client, space.name);
        await client.tapCurrent('[data-testid="open-space-members"]');
        await observedElements(
          client,
          assertions.membersDialogVisible,
          '[data-testid="space-settings"]',
          visibleOne,
        );
        await observedElements(
          client,
          assertions.membersHeading,
          '[data-testid="space-settings-section-heading"]',
          (elements) => visibleOne(elements) && elements[0]!.text === 'Members',
        );
        await observedElements(
          client,
          assertions.membersOwnerRow,
          '[data-testid="member-list"] [role="group"][aria-label*="Owner"] [data-testid="member-row"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes(owner.username),
        );
        await observedElements(
          client,
          assertions.membersAdminRow,
          '[data-testid="member-list"] [role="group"][aria-label*="Admin"] [data-testid="member-row"]',
          (elements) =>
            visibleOne(elements) && elements[0]!.text.includes(peer.username),
        );
      },
    },
  ];
