import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  DESKTOP_ACCOUNT_PROFILE,
  type AccountWorkspaceCase,
} from './account-workspace-client.mts';
import { pickAndroidDocument } from './maestro-document-picker.mts';
import {
  adminSource,
  seedSource,
  spaceSettingsCoreAssertions as assertions,
} from './space-settings-core-contract.mts';
import {
  absent,
  observedElements,
  observedExpression,
  observedServerValue,
  openSettingsSection,
  openSpaceSettings,
  selectSpace,
  visibleOne,
} from './space-settings-core-observations.mts';
import { withSpaceSettingsVisualFixture } from './space-settings-visual-fixture.mts';

export const spaceSettingsCoreAdminCases: readonly AccountWorkspaceCase[] = [
  {
    id: 'admin-general-and-access',
    source: adminSource,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('space-settings-admin');
      const runId = resources.roomName('sp');
      const space = await fixtures.createRoom(owner, {
        name: `Team ${runId}`,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      const room = await fixtures.createRoom(owner, {
        name: `Conversation ${runId}`,
        preset: 'private_chat',
      });
      const newName = `Renamed ${runId}`;
      const newTopic = `Where team ${runId} works`;
      await fixtures.setSpaceChild(owner, space.id, room.id, {
        suggested: true,
      });

      await client.login(owner);
      await selectSpace(client, space.name);
      await client.tapCurrent('.channel', { text: room.name });
      await observedElements(
        client,
        assertions.adminConversationVisible,
        '[data-testid="composer-input"]',
        visibleOne,
      );
      await observedElements(
        client,
        assertions.adminConversationHeading,
        'h1',
        (elements) =>
          visibleOne(elements) && elements[0]!.text.includes(room.name),
      );
      // Reopen the Space sidebar while its Conversation remains mounted.
      await openSpaceSettings(client, space.name);
      await observedElements(
        client,
        assertions.adminNameFieldVisible,
        '[data-testid="space-settings-name"]',
        visibleOne,
      );
      await observedElements(
        client,
        assertions.adminDirectoryVisible,
        '[data-testid="space-settings-directory"]',
        visibleOne,
      );
      await observedElements(
        client,
        assertions.adminAccountOwner,
        '[data-testid="space-settings-account"]',
        (elements) =>
          visibleOne(elements) && elements[0]!.text.includes(owner.username),
      );
      await observedElements(
        client,
        assertions.adminHeadingFocused,
        '[data-testid="space-settings"] h1',
        (elements) =>
          visibleOne(elements) &&
          elements[0]!.text === 'Space settings' &&
          elements[0]!.focused,
      );
      await observedElements(
        client,
        assertions.adminDesktopWidth,
        '[data-testid="space-settings"]',
        (elements) => visibleOne(elements) && elements[0]!.rect.width > 700,
      );

      try {
        await client.resize(700, 800);
        await observedElements(
          client,
          assertions.adminCompactDirectoryHidden,
          '[data-testid="space-settings-directory"]',
          (elements) => elements.every((element) => !element.visible),
        );
        await observedElements(
          client,
          assertions.adminCompactBackVisible,
          '[data-testid="space-settings-mobile-back"]',
          visibleOne,
        );
      } finally {
        await client.resize(
          DESKTOP_ACCOUNT_PROFILE.width,
          DESKTOP_ACCOUNT_PROFILE.height,
        );
      }
      await observedElements(
        client,
        assertions.adminDesktopDirectoryRestored,
        '[data-testid="space-settings-directory"]',
        visibleOne,
      );

      await withSpaceSettingsVisualFixture(
        client,
        { fontSize: '125%' },
        async () => {
          await observedElements(
            client,
            assertions.adminScaledCancelVisible,
            '[data-testid="space-settings-cancel"]',
            visibleOne,
          );
          await observedElements(
            client,
            assertions.adminScaledActionsHidden,
            '[data-testid="space-settings-general-actions"]',
            absent,
          );
        },
      );
      await withSpaceSettingsVisualFixture(
        client,
        { dark: false, theme: null },
        () => client.capture('space-settings-desktop-general-light'),
      );
      await withSpaceSettingsVisualFixture(
        client,
        { dark: true, theme: 'amethyst' },
        () => client.capture('space-settings-desktop-general-dark-amethyst'),
      );

      const photoPath = join(client.output, 'photo.png');
      await writeFile(
        photoPath,
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64',
        ),
      );
      await client.tapDocumentTrigger(
        '[data-testid="space-settings-avatar"]',
        'trn-avatar-field:has([data-testid="space-settings-avatar"]) input[type="file"]',
      );
      await pickAndroidDocument(
        client.device,
        client.workspaceRoot,
        photoPath,
        'space-photo.png',
      );
      await observedElements(
        client,
        assertions.adminPhotoFeedback,
        '[aria-label="Notifications alt+T"] [data-sonner-toast]',
        (elements) =>
          elements.some(
            (element) =>
              element.visible && element.text.includes('Space photo updated.'),
          ),
      );
      await observedServerValue(
        client,
        assertions.adminPhotoPersisted,
        () => fixtures.roomState(owner, space.id, 'm.room.avatar'),
        (value) =>
          typeof value?.['url'] === 'string' && /^mxc:\/\//.test(value['url']),
      );

      await client.replace('[data-testid="space-settings-name"]', newName);
      await client.fill('[data-testid="space-settings-topic"]', newTopic);
      await client.tapCurrent('[data-testid="space-settings-save"]');
      await observedElements(
        client,
        assertions.adminGeneralFeedback,
        '[data-testid="space-settings-general-feedback"]',
        (elements) =>
          visibleOne(elements) &&
          /Name.*topic.*saved|Topic.*name.*saved/i.test(elements[0]!.text),
      );

      await openSettingsSection(client, 'access');
      await client.tapCurrent('[data-testid="space-settings-join-rule"]');
      await client.tapCurrent('[data-testid="join-rule-public"]');
      await client.capture('space-access-admin');
      await client.tapCurrent('[data-testid="space-settings-save"]');
      await observedServerValue(
        client,
        assertions.adminNamePersisted,
        () => fixtures.roomState(owner, space.id, 'm.room.name'),
        (value) => value?.['name'] === newName,
      );
      await observedServerValue(
        client,
        assertions.adminTopicPersisted,
        () => fixtures.roomState(owner, space.id, 'm.room.topic'),
        (value) => value?.['topic'] === newTopic,
      );
      await observedServerValue(
        client,
        assertions.adminJoinRulePersisted,
        () => fixtures.roomState(owner, space.id, 'm.room.join_rules'),
        (value) => value?.['join_rule'] === 'public',
      );
      await client.tapCurrent('[data-testid="space-settings-cancel"]');
      await observedElements(
        client,
        assertions.adminDialogClosed,
        '[data-testid="space-settings"]',
        absent,
      );
      await observedElements(
        client,
        assertions.adminConversationRetained,
        '[data-testid="composer-input"]',
        visibleOne,
      );
      await observedElements(
        client,
        assertions.adminHeadingRetained,
        'h1',
        (elements) =>
          visibleOne(elements) && elements[0]!.text.includes(room.name),
      );
    },
  },
  {
    id: 'seeded-values',
    source: seedSource,
    profile: DESKTOP_ACCOUNT_PROFILE,
    async run({ client, fixtures, resources }) {
      const owner = await fixtures.account('space-settings-seed');
      const runId = resources.roomName('sd');
      const space = await fixtures.createRoom(owner, {
        name: `Seeded ${runId}`,
        preset: 'private_chat',
        creation_content: { type: 'm.space' },
      });
      const topic = `Topic ${runId}`;
      await fixtures.setRoomState(owner, space.id, 'm.room.topic', { topic });
      await fixtures.setRoomState(owner, space.id, 'm.room.join_rules', {
        join_rule: 'public',
      });
      await client.login(owner);
      await openSpaceSettings(client, space.name);
      await observedElements(
        client,
        assertions.seedName,
        '[data-testid="space-settings-name"]',
        (elements) => visibleOne(elements) && elements[0]!.value === space.name,
      );
      // AccountElement.value intentionally observes input elements only; Topic is a textarea.
      await observedExpression(
        client,
        assertions.seedTopic,
        `document.querySelector('[data-testid="space-settings-topic"]')?.value`,
        (value) => value === topic,
      );
      await openSettingsSection(client, 'access');
      await observedElements(
        client,
        assertions.seedJoinRule,
        '[data-testid="space-settings-join-rule"]',
        (elements) =>
          visibleOne(elements) &&
          /Anyone can find and join/.test(elements[0]!.text),
      );
    },
  },
];
