import assert from 'node:assert/strict';

const source =
  'e2e/browser/journeys/room-administration/member-roles.spec.mts';

export const MEMBER_ROLE_CLASSIFICATION_SOURCES = {
  sharedHelper: `${source}:173-193`,
  grouping: `${source}:205-281`,
  directMessage: `${source}:283-361`,
  ownerPanel: `${source}:363-393`,
  ownerAdmin: `${source}:395-433`,
} as const;

export const memberRoleClassificationAssertions = {
  openMembersRoomTimelineVisible: 'open-members.room-timeline-visible',
  openMembersRosterInitiallyHidden: 'open-members.roster-initially-hidden',
  openMembersRosterVisible: 'open-members.roster-visible',
  groupingMemberCount: 'grouping.member-count',
  groupingSectionLabels: 'grouping.section-labels',
  groupingHeaderHeights: 'grouping.header-heights',
  groupingRowHeights: 'grouping.row-heights',
  groupingGroupLabels: 'grouping.group-labels',
  groupingOwnerMember: 'grouping.owner-member',
  groupingModeratorMember: 'grouping.moderator-member',
  groupingPlainMember: 'grouping.plain-member',
  groupingModeratorName: 'grouping.moderator-name',
  directMessageRoomTimelineVisible: 'direct-message.room-timeline-visible',
  directMessageRosterInitiallyHidden:
    'direct-message.roster-initially-hidden',
  directMessageRosterVisible: 'direct-message.roster-visible',
  directMessageMemberCount: 'direct-message.member-count',
  directMessageAdminSection: 'direct-message.admin-section',
  directMessageOwnerAbsent: 'direct-message.owner-absent',
  directMessagePanelVisible: 'direct-message.panel-visible',
  directMessageRoleAdmin: 'direct-message.role-admin',
  ownerPanelMemberCount: 'owner-panel.member-count',
  ownerPanelPanelVisible: 'owner-panel.panel-visible',
  ownerPanelRoleOwner: 'owner-panel.role-owner',
  ownerAdminMemberCount: 'owner-admin.member-count',
  ownerAdminSectionLabels: 'owner-admin.section-labels',
  ownerAdminOwnerMember: 'owner-admin.owner-member',
  ownerAdminAdminMember: 'owner-admin.admin-member',
} as const;

export type MemberRoleClassificationAssertion =
  (typeof memberRoleClassificationAssertions)[keyof typeof memberRoleClassificationAssertions];

assert.equal(
  Object.values(memberRoleClassificationAssertions).length,
  27,
  'Exactly 27 member role classification assertion identities are required',
);
assert.equal(
  new Set(Object.values(memberRoleClassificationAssertions)).size,
  27,
  'Member role classification assertion identities must be unique',
);
