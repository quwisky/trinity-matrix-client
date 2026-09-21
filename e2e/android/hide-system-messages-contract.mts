import assert from 'node:assert/strict';

export const HIDE_SYSTEM_MESSAGES_SOURCES = {
  helpers:
    'e2e/browser/journeys/conversations/hide-system-messages.spec.mts:27-56',
  definition:
    'e2e/browser/journeys/conversations/hide-system-messages.spec.mts:61-144',
  navigation: 'e2e/support/journeys/navigation.mts',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const hideSystemMessagesAssertions = {
  initialRoomReady: 'hide-system-messages.initial.room-ready',
  initialJoinVisible: 'hide-system-messages.initial.join-visible',
  initialMessageVisible: 'hide-system-messages.initial.message-visible',
  settingsRoomsRouteReady:
    'hide-system-messages.settings.rooms-route-ready',
  settingsSectionsVisible:
    'hide-system-messages.settings.sections-visible',
  settingsDetailReady: 'hide-system-messages.settings.detail-ready',
  settingsToggleVisible: 'hide-system-messages.settings.toggle-visible',
  filteredRoomReady: 'hide-system-messages.filtered.room-ready',
  filteredMessageVisible: 'hide-system-messages.filtered.message-visible',
  filteredJoinAbsent: 'hide-system-messages.filtered.join-absent',
  relaunchRoomReady: 'hide-system-messages.relaunch.room-ready',
  relaunchMessageVisible: 'hide-system-messages.relaunch.message-visible',
  relaunchJoinAbsent: 'hide-system-messages.relaunch.join-absent',
} as const;

export type HideSystemMessagesAssertion =
  (typeof hideSystemMessagesAssertions)[keyof typeof hideSystemMessagesAssertions];

export const hideSystemMessagesStageAssertions = [
  hideSystemMessagesAssertions.initialRoomReady,
  hideSystemMessagesAssertions.initialJoinVisible,
  hideSystemMessagesAssertions.initialMessageVisible,
  hideSystemMessagesAssertions.settingsRoomsRouteReady,
  hideSystemMessagesAssertions.settingsSectionsVisible,
  hideSystemMessagesAssertions.settingsDetailReady,
  hideSystemMessagesAssertions.settingsToggleVisible,
  hideSystemMessagesAssertions.filteredRoomReady,
  hideSystemMessagesAssertions.filteredMessageVisible,
  hideSystemMessagesAssertions.filteredJoinAbsent,
  hideSystemMessagesAssertions.relaunchRoomReady,
  hideSystemMessagesAssertions.relaunchMessageVisible,
  hideSystemMessagesAssertions.relaunchJoinAbsent,
] as const;

export const HIDE_SYSTEM_MESSAGES_ASSERTION_RECORDS =
  hideSystemMessagesStageAssertions.length;

assert.equal(
  HIDE_SYSTEM_MESSAGES_ASSERTION_RECORDS,
  13,
  'Hide-system-messages owns exactly thirteen assertion identities',
);
assert.equal(
  new Set(hideSystemMessagesStageAssertions).size,
  HIDE_SYSTEM_MESSAGES_ASSERTION_RECORDS,
  'Hide-system-messages assertion identities must be unique',
);
