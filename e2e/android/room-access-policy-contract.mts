import assert from 'node:assert/strict';

export const ROOM_ACCESS_POLICY_SOURCES = {
  adminPublicHistory:
    'e2e/browser/journeys/room-administration/room-access-settings.spec.mts:20-137',
  restrictedSpace:
    'e2e/browser/journeys/room-administration/room-access-settings.spec.mts:139-215',
  revokeSpace:
    'e2e/browser/journeys/room-administration/room-access-settings.spec.mts:217-314',
  memberReadOnly:
    'e2e/browser/journeys/room-administration/room-access-settings.spec.mts:316-390',
  openRoom: 'e2e/browser/support/room-settings-journey.mts:36-44',
  openSettingsTab: 'e2e/support/app.mts:228-248',
} as const;

export const roomAccessPolicyHelperAssertions = {
  adminRoomTimelineVisible: 'admin.room-timeline-visible',
  adminAccessPanelVisible: 'admin.access-panel-visible',
  restrictedAccessPanelVisible: 'restricted.access-panel-visible',
  revokeAccessPanelVisible: 'revoke.access-panel-visible',
  memberRoomTimelineVisible: 'member.room-timeline-visible',
  memberAccessPanelVisible: 'member.access-panel-visible',
} as const;

export const roomAccessPolicyDirectAssertions = {
  adminSettingsVisible: 'admin.settings-visible',
  adminAccessPanelInitiallyAbsent: 'admin.access-panel-initially-absent',
  adminGeneralPanelAbsent: 'admin.general-panel-absent',
  adminSectionHeadingFocused: 'admin.section-heading-focused',
  adminAliasesAbsent: 'admin.aliases-absent',
  adminSaveVisibleScaled: 'admin.save-visible-scaled',
  adminSaveFocused: 'admin.save-focused',
  adminJoinRulePublic: 'admin.join-rule-public',
  adminHistoryWorldReadable: 'admin.history-world-readable',
  adminAddressesVisible: 'admin.addresses-visible',
  restrictedTimelineVisible: 'restricted.timeline-visible',
  restrictedSettingsVisible: 'restricted.settings-visible',
  restrictedSpaceOptionVisible: 'restricted.space-option-visible',
  restrictedJoinRule: 'restricted.join-rule',
  restrictedAllow: 'restricted.allow',
  revokeTimelineVisible: 'revoke.timeline-visible',
  revokeDroppedOptionVisible: 'revoke.dropped-option-visible',
  revokeAllow: 'revoke.allow',
  memberJoinRuleText: 'member.join-rule-text',
  memberHistoryText: 'member.history-text',
  memberJoinRuleReadOnlyMessage: 'member.join-rule-read-only-message',
  memberHistoryReadOnlyMessage: 'member.history-read-only-message',
  memberActionsAbsent: 'member.actions-absent',
} as const;

export const roomAccessPolicyAssertions = {
  ...roomAccessPolicyHelperAssertions,
  ...roomAccessPolicyDirectAssertions,
} as const;

export type RoomAccessPolicyAssertion =
  (typeof roomAccessPolicyAssertions)[keyof typeof roomAccessPolicyAssertions];

assert.equal(
  Object.values(roomAccessPolicyDirectAssertions).length,
  23,
  'Exactly 23 direct Room access policy identities are required',
);
assert.equal(
  Object.values(roomAccessPolicyHelperAssertions).length,
  6,
  'Exactly six helper Room access policy identities are required',
);
assert.equal(
  Object.values(roomAccessPolicyAssertions).length,
  29,
  'Exactly 29 total Room access policy identities are required',
);
assert.equal(
  new Set(Object.values(roomAccessPolicyAssertions)).size,
  29,
  'Room access policy identities must be unique',
);
