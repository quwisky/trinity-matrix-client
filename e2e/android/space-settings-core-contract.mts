import assert from 'node:assert/strict';

// Issue #701; common Matrix/readiness/navigation helpers: space-settings.spec.mts:29-181.
export const adminSource =
  'e2e/browser/journeys/room-administration/space-settings.spec.mts:186-360';
export const seedSource =
  'e2e/browser/journeys/room-administration/space-settings.spec.mts:362-411';
export const contentsSource =
  'e2e/browser/journeys/room-administration/space-settings.spec.mts:413-670';
export const readonlySource =
  'e2e/browser/journeys/room-administration/space-settings.spec.mts:672-775';
export const permissionSource =
  'e2e/browser/journeys/room-administration/space-settings.spec.mts:777-851';
export const addressSource =
  'e2e/browser/journeys/room-administration/space-settings.spec.mts:853-904';
export const membersSource =
  'e2e/browser/journeys/room-administration/space-settings.spec.mts:906-1000';

export const spaceSettingsCoreAssertions = {
  adminConversationVisible: 'admin.conversation-visible',
  adminConversationHeading: 'admin.conversation-heading',
  adminNameFieldVisible: 'admin.name-field-visible',
  adminDirectoryVisible: 'admin.directory-visible',
  adminAccountOwner: 'admin.account-owner',
  adminHeadingFocused: 'admin.heading-focused',
  adminDesktopWidth: 'admin.desktop-width',
  adminCompactDirectoryHidden: 'admin.compact-directory-hidden',
  adminCompactBackVisible: 'admin.compact-back-visible',
  adminDesktopDirectoryRestored: 'admin.desktop-directory-restored',
  adminScaledCancelVisible: 'admin.scaled-cancel-visible',
  adminScaledActionsHidden: 'admin.scaled-actions-hidden',
  adminPhotoFeedback: 'admin.photo-feedback',
  adminPhotoPersisted: 'admin.photo-persisted',
  adminGeneralFeedback: 'admin.general-feedback',
  adminNamePersisted: 'admin.name-persisted',
  adminTopicPersisted: 'admin.topic-persisted',
  adminJoinRulePersisted: 'admin.join-rule-persisted',
  adminDialogClosed: 'admin.dialog-closed',
  adminConversationRetained: 'admin.conversation-retained',
  adminHeadingRetained: 'admin.heading-retained',
  seedName: 'seed.name',
  seedTopic: 'seed.topic',
  seedJoinRule: 'seed.join-rule',
  contentsPanelVisible: 'contents.panel-visible',
  contentsLinkedName: 'contents.linked-name',
  contentsLinkedTypeRoom: 'contents.linked-type-room',
  contentsScaledCreateSpaceVisible: 'contents.scaled-create-space-visible',
  contentsScaledNoOverflow: 'contents.scaled-no-overflow',
  contentsCandidateRoomLinked: 'contents.candidate-room-linked',
  contentsCandidateSpaceLinked: 'contents.candidate-space-linked',
  contentsCreatedSpaceLinked: 'contents.created-space-linked',
  contentsCreatedSpaceType: 'contents.created-space-type',
  contentsRecoveryVisible: 'contents.recovery-visible',
  contentsRecoveryName: 'contents.recovery-name',
  contentsRecoveredId: 'contents.recovered-id',
  contentsCreateFirstCount: 'contents.create-first-count',
  contentsRecoveryDismissed: 'contents.recovery-dismissed',
  contentsRecoveredLinked: 'contents.recovered-linked',
  contentsCreateRetryCount: 'contents.create-retry-count',
  contentsNoChildParentGovernance: 'contents.no-child-parent-governance',
  contentsRemoveRoomName: 'contents.remove-room-name',
  contentsRemoveRoomParentName: 'contents.remove-room-parent-name',
  contentsRemoveRoomNotDeleted: 'contents.remove-room-not-deleted',
  contentsCancelKeepsRoomLinked: 'contents.cancel-keeps-room-linked',
  contentsRoomUnlinked: 'contents.room-unlinked',
  contentsRoomMembershipRetained: 'contents.room-membership-retained',
  contentsRemoveSpaceName: 'contents.remove-space-name',
  contentsRemoveSpaceParentName: 'contents.remove-space-parent-name',
  contentsSpaceUnlinked: 'contents.space-unlinked',
  contentsSpaceMembershipRetained: 'contents.space-membership-retained',
  contentsDemoteWrite: 'contents.demote-write',
  contentsActionsHidden: 'contents.actions-hidden',
  contentsCandidateSpaceVisible: 'contents.candidate-space-visible',
  contentsUnlinkHidden: 'contents.unlink-hidden',
  contentsSuggestHidden: 'contents.suggest-hidden',
  contentsMoveUpHidden: 'contents.move-up-hidden',
  readonlyName: 'readonly.name',
  readonlyNoTopic: 'readonly.no-topic',
  readonlyNameParagraph: 'readonly.name-paragraph',
  readonlyTopicParagraph: 'readonly.topic-paragraph',
  readonlyGeneralActionsHidden: 'readonly.general-actions-hidden',
  readonlyJoinRuleDisabled: 'readonly.join-rule-disabled',
  readonlyPermissionExplanation: 'readonly.permission-explanation',
  readonlyAccessPolicy: 'readonly.access-policy',
  readonlyAccessActionsHidden: 'readonly.access-actions-hidden',
  readonlyChildVisible: 'readonly.child-visible',
  readonlyContentsActionsHidden: 'readonly.contents-actions-hidden',
  readonlyUnlinkHidden: 'readonly.unlink-hidden',
  readonlyContentsExplanation: 'readonly.contents-explanation',
  permissionTopicEditable: 'permission.topic-editable',
  permissionActionsVisible: 'permission.actions-visible',
  permissionTopicReadonly: 'permission.topic-readonly',
  permissionDraftRetained: 'permission.draft-retained',
  permissionDraftExplanation: 'permission.draft-explanation',
  permissionDiscardVisible: 'permission.discard-visible',
  permissionSaveDisabled: 'permission.save-disabled',
  addressPanelVisible: 'address.panel-visible',
  addressDialogRetained: 'address.dialog-retained',
  addressVisible: 'address.visible',
  addressResolves: 'address.resolves',
  membersDialogVisible: 'members.dialog-visible',
  membersHeading: 'members.heading',
  membersOwnerRow: 'members.owner-row',
  membersAdminRow: 'members.admin-row',
} as const;

export type SpaceSettingsCoreAssertion =
  (typeof spaceSettingsCoreAssertions)[keyof typeof spaceSettingsCoreAssertions];

assert.equal(
  Object.values(spaceSettingsCoreAssertions).length,
  85,
  'Exactly 85 core Space Settings assertion identities are required',
);
assert.equal(
  new Set(Object.values(spaceSettingsCoreAssertions)).size,
  85,
  'Core Space Settings assertion identities must be unique',
);
