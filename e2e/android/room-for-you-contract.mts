import assert from 'node:assert/strict';

const source =
  'e2e/browser/journeys/room-administration/room-settings-for-you.spec.mts';
const openRoomSource = 'e2e/browser/support/room-settings-journey.mts';

export const ROOM_FOR_YOU_SOURCES = {
  failedRead: `${source}:150-225`,
  accountIsolation: `${source}:227-391`,
  openForYou: `${source}:80-90`,
  expectMode: `${source}:92-103`,
  openRoom: `${openRoomSource}:36-44`,
  multiAccount: 'e2e/browser/support/multi-account-journey.mts',
  app: 'e2e/support/app.mts',
} as const;

export const roomForYouInheritedAssertions = {
  loadRoomTimelineVisible: 'load.room-timeline-visible',
  preferencesOwnerRoomTimelineVisible:
    'preferences.owner-room-timeline-visible',
  preferencesMemberRoomTimelineVisible:
    'preferences.member-room-timeline-visible',
} as const;

export const roomForYouDirectAssertions = {
  loadSettingsVisible: 'load.settings-visible',
  loadErrorHeadingVisible: 'load.error-heading-visible',
  loadAlertNotLive: 'load.alert-not-live',
  loadRetryEnabled: 'load.retry-enabled',
  loadAlertBoxPresent: 'load.alert-box-present',
  loadRetryBoxPresent: 'load.retry-box-present',
  loadRetryLeftContained: 'load.retry-left-contained',
  loadRetryTopContained: 'load.retry-top-contained',
  loadRetryRightContained: 'load.retry-right-contained',
  loadRetryBottomContained: 'load.retry-bottom-contained',
  loadFormVisible: 'load.form-visible',
  loadReadAttemptsMinimum: 'load.read-attempts-minimum',
  preferencesSettingsVisible: 'preferences.settings-visible',
  preferencesFormVisible: 'preferences.form-visible',
  preferencesHeadingFocused: 'preferences.heading-focused',
  preferencesExpectedModeChecked: 'preferences.expected-mode-checked',
  preferencesOtherModesUnchecked: 'preferences.other-modes-unchecked',
  preferencesOpeningAccount: 'preferences.opening-account',
  preferencesInitialFavouriteUnchecked:
    'preferences.initial-favourite-unchecked',
  preferencesPartialFeedback: 'preferences.partial-feedback',
  preferencesNotificationFirstWrites:
    'preferences.notification-first-writes',
  preferencesFavouriteFirstWrites: 'preferences.favourite-first-writes',
  preferencesLowPriorityFirstWrites:
    'preferences.low-priority-first-writes',
  preferencesRetryFeedback: 'preferences.retry-feedback',
  preferencesNotificationTotalWrites:
    'preferences.notification-total-writes',
  preferencesFavouriteTotalWrites: 'preferences.favourite-total-writes',
  preferencesOwnerModePersisted: 'preferences.owner-mode-persisted',
  preferencesOwnerTagsPersisted: 'preferences.owner-tags-persisted',
  preferencesMemberModePersisted: 'preferences.member-mode-persisted',
  preferencesMemberTagsPersisted: 'preferences.member-tags-persisted',
  preferencesThemeFormVisible: 'preferences.theme-form-visible',
  preferencesScaledFormVisible: 'preferences.scaled-form-visible',
  preferencesMemberAccount: 'preferences.member-account',
  preferencesMemberFavouriteChecked:
    'preferences.member-favourite-checked',
  preferencesMemberLowPriorityUnchecked:
    'preferences.member-low-priority-unchecked',
} as const;

export const roomForYouAssertions = {
  ...roomForYouInheritedAssertions,
  ...roomForYouDirectAssertions,
} as const;

assert.equal(
  Object.keys(roomForYouDirectAssertions).length,
  35,
  'Room For-you owns exactly 35 direct assertion identities',
);
assert.equal(
  Object.keys(roomForYouInheritedAssertions).length,
  3,
  'Room For-you owns exactly three inherited assertion identities',
);
assert.equal(
  Object.keys(roomForYouAssertions).length,
  38,
  'Room For-you owns exactly 38 stage-local assertion identities',
);
assert.equal(
  new Set(Object.values(roomForYouAssertions)).size,
  38,
  'Room For-you assertion identities must be unique',
);

export type RoomForYouAssertion =
  (typeof roomForYouAssertions)[keyof typeof roomForYouAssertions];
