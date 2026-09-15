import assert from 'node:assert/strict';

export const MEMBER_DETAILS_PROMOTION_SOURCES = {
  memberInfo: {
    roomHelper:
      'e2e/browser/journeys/room-administration/member-info.spec.mts:49-57',
    membersHelper:
      'e2e/browser/journeys/room-administration/member-info.spec.mts:59-68',
    definition:
      'e2e/browser/journeys/room-administration/member-info.spec.mts:73-218',
  },
  promotion: {
    roomHelper:
      'e2e/browser/journeys/room-administration/promote-member.spec.mts:49-57',
    definition:
      'e2e/browser/journeys/room-administration/promote-member.spec.mts:62-134',
  },
} as const;

export const memberDetailsPromotionAssertions = {
  memberInfoRoomTimelineVisible: 'member-info.room-timeline-visible',
  memberInfoMembersPanelVisible: 'member-info.members-panel-visible',
  memberInfoMembersInitiallyHidden: 'member-info.members-initially-hidden',
  memberInfoRowHeight: 'member-info.row-height',
  memberInfoHeaderHeight: 'member-info.header-height',
  memberInfoPanelVisible: 'member-info.panel-visible',
  memberInfoName: 'member-info.name',
  memberInfoHandle: 'member-info.handle',
  memberInfoRole: 'member-info.role',
  memberInfoMessageActionVisible: 'member-info.message-action-visible',
  memberInfoSurfaceDisplay: 'member-info.surface-display',
  memberInfoSurfaceOpaque: 'member-info.surface-opaque',
  memberInfoSurfaceRowPositive: 'member-info.surface-row-positive',
  memberInfoSurfaceFullHeight: 'member-info.surface-full-height',
  memberInfoCopyToast: 'member-info.copy-toast',
  memberInfoClipboardMxid: 'member-info.clipboard-mxid',
  memberInfoPanelClosed: 'member-info.panel-closed',
  memberInfoRosterRestored: 'member-info.roster-restored',
  promotionRoomTimelineVisible: 'promotion.room-timeline-visible',
  promotionMembersInitiallyHidden: 'promotion.members-initially-hidden',
  promotionMembersPanelVisible: 'promotion.members-panel-visible',
  promotionModeratorAbsent: 'promotion.moderator-absent',
  promotionMemberInfoVisible: 'promotion.member-info-visible',
  promotionModeratorSectionVisible: 'promotion.moderator-section-visible',
  promotionMemberRowAndServerPower:
    'promotion.member-row-and-server-power',
} as const;

export type MemberDetailsPromotionAssertion =
  (typeof memberDetailsPromotionAssertions)[keyof typeof memberDetailsPromotionAssertions];

assert.equal(
  Object.values(memberDetailsPromotionAssertions).length,
  25,
  'Exactly 25 member details and promotion assertion identities are required',
);
assert.equal(
  new Set(Object.values(memberDetailsPromotionAssertions)).size,
  25,
  'Member details and promotion assertion identities must be unique',
);
