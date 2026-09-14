import assert from 'node:assert/strict';

const source =
  'e2e/browser/journeys/room-administration/member-roles.spec.mts';

export const MEMBER_ROLE_LIVE_UPDATE_SOURCES = {
  sharedHelper: `${source}:173-193`,
  livePromotion: `${source}:435-480`,
  permissionLoss: `${source}:482-543`,
  settingsDemotion: `${source}:545-583`,
  touchFeedback: `${source}:590-626`,
} as const;

export const memberRoleLiveUpdateAssertions = {
  livePromotionMemberCount: 'live-promotion.member-count',
  livePromotionInitialSectionLabels:
    'live-promotion.initial-section-labels',
  livePromotionFinalSectionLabels: 'live-promotion.final-section-labels',
  livePromotionModeratorMember: 'live-promotion.moderator-member',
  permissionLossKickInitiallyEnabled:
    'permission-loss.kick-initially-enabled',
  permissionLossKickDisabled: 'permission-loss.kick-disabled',
  permissionLossKickDescription: 'permission-loss.kick-description',
  permissionLossTooltip: 'permission-loss.tooltip',
  permissionLossRemoveDialogAbsent: 'permission-loss.remove-dialog-absent',
  permissionLossInviteDisabled: 'permission-loss.invite-disabled',
  permissionLossInviteDialogAbsent: 'permission-loss.invite-dialog-absent',
  settingsDemotionSurfaceVisible: 'settings-demotion.surface-visible',
  settingsDemotionNameInitiallyEnabled:
    'settings-demotion.name-initially-enabled',
  settingsDemotionNameText: 'settings-demotion.name-text',
  settingsDemotionNameParagraph: 'settings-demotion.name-paragraph',
  settingsDemotionGeneralActionsAbsent:
    'settings-demotion.general-actions-absent',
  settingsDemotionAliasesReadOnly: 'settings-demotion.aliases-read-only',
  settingsDemotionAliasInputAbsent: 'settings-demotion.alias-input-absent',
  settingsDemotionAliasAddAbsent: 'settings-demotion.alias-add-absent',
  settingsDemotionAliasSetMainAbsent:
    'settings-demotion.alias-set-main-absent',
  settingsDemotionAliasRemoveAbsent: 'settings-demotion.alias-remove-absent',
  touchFeedbackKickDisabled: 'touch-feedback.kick-disabled',
  touchFeedbackKickVisible: 'touch-feedback.kick-visible',
  touchFeedbackExactCopy: 'touch-feedback.exact-copy',
  touchFeedbackRemoveDialogAbsent:
    'touch-feedback.remove-dialog-absent',
} as const;

export type MemberRoleLiveUpdateAssertion =
  (typeof memberRoleLiveUpdateAssertions)[keyof typeof memberRoleLiveUpdateAssertions];

assert.equal(
  Object.values(memberRoleLiveUpdateAssertions).length,
  25,
  'Exactly 25 member role live-update assertion identities are required',
);
assert.equal(
  new Set(Object.values(memberRoleLiveUpdateAssertions)).size,
  25,
  'Member role live-update assertion identities must be unique',
);
