import assert from 'node:assert/strict';

const source =
  'e2e/browser/journeys/room-administration/room-profile-settings.spec.mts';
const openRoomSource = 'e2e/browser/support/room-settings-journey.mts';

export const ROOM_PROFILE_SETTINGS_SOURCES = {
  rename: `${source}:16-151`,
  photo: `${source}:153-197`,
  partialFailure: `${source}:199-256`,
  accountContinuity: `${source}:258-358`,
  openRoom: `${openRoomSource}:36-44`,
  blockedAccountTransition: `${source}:324-335`,
} as const;

export const roomProfileSettingsHelperAssertions = {
  renamePriorRoomTimelineVisible: 'rename.prior-room-timeline-visible',
  renameOriginalRoomTimelineVisible: 'rename.original-room-timeline-visible',
  photoRoomTimelineVisible: 'photo.room-timeline-visible',
  partialRoomTimelineVisible: 'partial.room-timeline-visible',
  continuityRoomTimelineVisible: 'continuity.room-timeline-visible',
} as const;

export const roomProfileSettingsDirectAssertions = {
  renameSettingsVisible: 'rename.settings-visible',
  renameDirectoryVisible: 'rename.directory-visible',
  renameOpeningAccount: 'rename.opening-account',
  renameHeadingFocused: 'rename.heading-focused',
  renameDesktopWidthMinimum: 'rename.desktop-width-minimum',
  renameDesktopWidthMaximum: 'rename.desktop-width-maximum',
  renameCompactDirectoryHidden: 'rename.compact-directory-hidden',
  renameCompactBackVisible: 'rename.compact-back-visible',
  renameCompactGeneralVisible: 'rename.compact-general-visible',
  renameDesktopDirectoryRestored: 'rename.desktop-directory-restored',
  renameDesktopBackHidden: 'rename.desktop-back-hidden',
  renameScaledCancelVisible: 'rename.scaled-cancel-visible',
  renameScaledActionsAbsent: 'rename.scaled-actions-absent',
  renameBackDiscardVisible: 'rename.back-discard-visible',
  renameBackDraftRetained: 'rename.back-draft-retained',
  renameTabDiscardVisible: 'rename.tab-discard-visible',
  renameTabDraftRetained: 'rename.tab-draft-retained',
  renameGeneralPanelRetained: 'rename.general-panel-retained',
  renameNewChannelVisible: 'rename.new-channel-visible',
  renameOldChannelAbsent: 'rename.old-channel-absent',
  photoSettingsVisible: 'photo.settings-visible',
  photoUpdated: 'photo.updated',
  partialFailureFeedback: 'partial.failure-feedback',
  partialNameFirstAttempts: 'partial.name-first-attempts',
  partialTopicFirstAttempts: 'partial.topic-first-attempts',
  partialRetryFeedback: 'partial.retry-feedback',
  partialNameTotalAttempts: 'partial.name-total-attempts',
  partialTopicTotalAttempts: 'partial.topic-total-attempts',
  continuityOpeningAccount: 'continuity.opening-account',
  continuityNameSaving: 'continuity.name-saving',
  continuityMemberRowVisible: 'continuity.member-row-visible',
  continuityActiveMember: 'continuity.active-member',
  continuityAccountRetained: 'continuity.account-retained',
  continuityNameSaved: 'continuity.name-saved',
  continuityTopicSaved: 'continuity.topic-saved',
  continuityTopicPersisted: 'continuity.topic-persisted',
} as const;

export const roomProfileSettingsAssertions = {
  ...roomProfileSettingsHelperAssertions,
  ...roomProfileSettingsDirectAssertions,
} as const;

assert.equal(
  Object.keys(roomProfileSettingsDirectAssertions).length,
  36,
  'Room profile settings owns exactly 36 direct assertion identities',
);
assert.equal(
  Object.keys(roomProfileSettingsHelperAssertions).length,
  5,
  'Room profile settings owns exactly five inherited assertion identities',
);
assert.equal(
  Object.keys(roomProfileSettingsAssertions).length,
  41,
  'Room profile settings owns exactly 41 stage-local assertion identities',
);
assert.equal(
  new Set(Object.values(roomProfileSettingsAssertions)).size,
  41,
  'Room profile settings assertion identities must be unique',
);

export type RoomProfileSettingsAssertion =
  (typeof roomProfileSettingsAssertions)[keyof typeof roomProfileSettingsAssertions];
