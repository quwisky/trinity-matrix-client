import assert from 'node:assert/strict';

export const MEMBER_MODERATION_SOURCES = {
  block: {
    helper:
      'e2e/browser/journeys/room-administration/block-member.spec.mts:47-55',
    definition:
      'e2e/browser/journeys/room-administration/block-member.spec.mts:60-123',
  },
  removal: {
    helper:
      'e2e/browser/journeys/room-administration/kick-member.spec.mts:68-76',
    generator:
      'e2e/browser/journeys/room-administration/kick-member.spec.mts:81-94',
    definitions:
      'e2e/browser/journeys/room-administration/kick-member.spec.mts:95-165',
  },
  staleRoster: {
    definition:
      'e2e/browser/journeys/room-administration/kick-member.spec.mts:168-291',
    androidExclusion:
      'fault injection requires Angular development hooks; the installed APK is production',
  },
} as const;

export const memberRemovalActions = [
  {
    id: 'kick',
    actionTestId: 'member-info-kick',
    expectedMembership: 'leave',
  },
  {
    id: 'ban',
    actionTestId: 'member-info-ban',
    expectedMembership: 'ban',
  },
] as const;

export type MemberRemovalAction = (typeof memberRemovalActions)[number];

export const memberModerationAssertions = {
  blockRoomTimelineVisible: 'block.room-timeline-visible',
  blockMembersInitiallyHidden: 'block.members-initially-hidden',
  blockMembersPanelVisible: 'block.members-panel-visible',
  blockMemberInfoVisible: 'block.member-info-visible',
  blockActionBlockVisible: 'block.action-block-visible',
  blockActionUnblockVisible: 'block.action-unblock-visible',
  kickRoomTimelineVisible: 'kick.room-timeline-visible',
  kickMembersInitiallyHidden: 'kick.members-initially-hidden',
  kickMembersPanelVisible: 'kick.members-panel-visible',
  kickMemberInfoVisible: 'kick.member-info-visible',
  kickMemberInfoClosed: 'kick.member-info-closed',
  kickRosterVisible: 'kick.roster-visible',
  kickMemberRowAbsent: 'kick.member-row-absent',
  kickServerMembership: 'kick.server-membership',
  banRoomTimelineVisible: 'ban.room-timeline-visible',
  banMembersInitiallyHidden: 'ban.members-initially-hidden',
  banMembersPanelVisible: 'ban.members-panel-visible',
  banMemberInfoVisible: 'ban.member-info-visible',
  banMemberInfoClosed: 'ban.member-info-closed',
  banRosterVisible: 'ban.roster-visible',
  banMemberRowAbsent: 'ban.member-row-absent',
  banServerMembership: 'ban.server-membership',
} as const;

export type MemberModerationAssertion =
  (typeof memberModerationAssertions)[keyof typeof memberModerationAssertions];

assert.equal(
  memberRemovalActions.length,
  2,
  'Exactly Kick and Ban removal actions are required',
);
assert.deepEqual(
  memberRemovalActions.map((action) => action.id),
  ['kick', 'ban'],
  'Member removal actions preserve the generated predecessor domain',
);
assert.equal(
  Object.values(memberModerationAssertions).length,
  22,
  'Exactly 22 member moderation assertion identities are required',
);
assert.equal(
  new Set(Object.values(memberModerationAssertions)).size,
  22,
  'Member moderation assertion identities must be unique',
);
