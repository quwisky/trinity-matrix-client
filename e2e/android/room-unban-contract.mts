import assert from 'node:assert/strict';

export const ROOM_UNBAN_SOURCES = {
  definition:
    'e2e/browser/journeys/room-administration/room-members-and-addresses.spec.mts:75-170',
  openRoom: 'e2e/browser/support/room-settings-journey.mts:36-44',
  openSettingsTab: 'e2e/support/app.mts:228-248',
} as const;

export const roomUnbanHelperAssertions = {
  roomTimelineVisible: 'unban.room-timeline-visible',
  membersPanelVisible: 'unban.members-panel-visible',
} as const;

export const roomUnbanDirectAssertions = {
  bannedSurfaceVisible: 'unban.banned-surface-visible',
  targetRowVisible: 'unban.target-row-visible',
  confirmTarget: 'unban.confirm-target',
  confirmRoom: 'unban.confirm-room',
  confirmAccount: 'unban.confirm-account',
  toastVisible: 'unban.toast-visible',
  serverMembership: 'unban.server-membership',
} as const;

export const roomUnbanAssertions = {
  ...roomUnbanHelperAssertions,
  ...roomUnbanDirectAssertions,
} as const;

export type RoomUnbanAssertion =
  (typeof roomUnbanAssertions)[keyof typeof roomUnbanAssertions];

assert.equal(
  Object.values(roomUnbanDirectAssertions).length,
  7,
  'Exactly seven direct Room unban assertion identities are required',
);
assert.equal(
  Object.values(roomUnbanHelperAssertions).length,
  2,
  'Exactly two helper Room unban assertion identities are required',
);
assert.equal(
  Object.values(roomUnbanAssertions).length,
  9,
  'Exactly nine total Room unban assertion identities are required',
);
assert.equal(
  new Set(Object.values(roomUnbanAssertions)).size,
  9,
  'Room unban assertion identities must be unique',
);
