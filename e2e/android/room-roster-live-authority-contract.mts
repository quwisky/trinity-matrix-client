import assert from 'node:assert/strict';

export const ROOM_ROSTER_LIVE_AUTHORITY_SOURCES = {
  definition:
    'e2e/browser/journeys/room-administration/room-members-and-addresses.spec.mts:172-401',
  openRoom: 'e2e/browser/support/room-settings-journey.mts:36-44',
  openSettingsTab: 'e2e/support/app.mts:228-248',
} as const;

export const roomRosterLiveAuthorityHelperAssertions = {
  roomTimelineVisible: 'roster.room-timeline-visible',
  membersPanelVisible: 'roster.members-panel-visible',
} as const;

export const roomRosterLiveAuthorityDirectAssertions = {
  rosterVisible: 'roster.roster-visible',
  targetRowVisible: 'roster.target-row-visible',
  detailTarget: 'roster.detail-target',
  roleConfirmRoom: 'roster.role-confirm-room',
  roleConfirmAccount: 'roster.role-confirm-account',
  afterRoleVisible: 'roster.after-role-visible',
  moderatorGroupTarget: 'roster.moderator-group-target',
  detailModerator: 'roster.detail-moderator',
  kickAbsentAfterDemotion: 'roster.kick-absent-after-demotion',
  banAbsentAfterDemotion: 'roster.ban-absent-after-demotion',
  detailTargetAfterDemotion: 'roster.detail-target-after-demotion',
  detailModeratorAfterDemotion: 'roster.detail-moderator-after-demotion',
  kickVisibleAfterRestore: 'roster.kick-visible-after-restore',
  kickConfirmTarget: 'roster.kick-confirm-target',
  kickConfirmRoom: 'roster.kick-confirm-room',
  kickConfirmAccount: 'roster.kick-confirm-account',
  rowAbsentAfterKick: 'roster.row-absent-after-kick',
  rowVisibleAfterRejoin: 'roster.row-visible-after-rejoin',
  banVisible: 'roster.ban-visible',
  banConfirmTarget: 'roster.ban-confirm-target',
  banConfirmRoom: 'roster.ban-confirm-room',
  banConfirmAccount: 'roster.ban-confirm-account',
  rowAbsentAfterBan: 'roster.row-absent-after-ban',
  bannedRowVisible: 'roster.banned-row-visible',
  unbanConfirmTarget: 'roster.unban-confirm-target',
  unbanConfirmRoom: 'roster.unban-confirm-room',
  unbanConfirmAccount: 'roster.unban-confirm-account',
  bannedRowAbsent: 'roster.banned-row-absent',
  settingsClosedAfterEscape: 'roster.settings-closed-after-escape',
  conversationRowVisible: 'roster.conversation-row-visible',
  conversationDetailTarget: 'roster.conversation-detail-target',
  conversationRowAfterCloseVisible:
    'roster.conversation-row-after-close-visible',
  memberFilterFocused: 'roster.member-filter-focused',
} as const;

export const roomRosterLiveAuthorityAssertions = {
  ...roomRosterLiveAuthorityHelperAssertions,
  ...roomRosterLiveAuthorityDirectAssertions,
} as const;

export type RoomRosterLiveAuthorityAssertion =
  (typeof roomRosterLiveAuthorityAssertions)[keyof typeof roomRosterLiveAuthorityAssertions];

assert.equal(
  Object.values(roomRosterLiveAuthorityDirectAssertions).length,
  33,
  'Exactly 33 direct Room roster assertion identities are required',
);
assert.equal(
  Object.values(roomRosterLiveAuthorityHelperAssertions).length,
  2,
  'Exactly two helper Room roster assertion identities are required',
);
assert.equal(
  Object.values(roomRosterLiveAuthorityAssertions).length,
  35,
  'Exactly 35 total Room roster assertion identities are required',
);
assert.equal(
  new Set(Object.values(roomRosterLiveAuthorityAssertions)).size,
  35,
  'Room roster assertion identities must be unique',
);
