import assert from 'node:assert/strict';

export const ROOM_ADDRESS_LIFECYCLE_SOURCES = {
  definition:
    'e2e/browser/journeys/room-administration/room-members-and-addresses.spec.mts:403-536',
  openRoom: 'e2e/browser/support/room-settings-journey.mts:36-44',
  openSettingsTab: 'e2e/support/app.mts:228-248',
} as const;

export const roomAddressLifecycleHelperAssertions = {
  roomTimelineVisible: 'address.room-timeline-visible',
  addressesPanelVisible: 'address.addresses-panel-visible',
} as const;

export const roomAddressLifecycleDirectAssertions = {
  panelVisible: 'address.panel-visible',
  rowVisible: 'address.row-visible',
  directoryResolves: 'address.directory-resolves',
  primaryVisible: 'address.primary-visible',
  canonicalState: 'address.canonical-state',
  settingsWithinViewport: 'address.settings-within-viewport',
  primaryToastHidden: 'address.primary-toast-hidden',
  removeJoiningEffect: 'address.remove-joining-effect',
  removeRoomRetained: 'address.remove-room-retained',
  cancelKeepsRow: 'address.cancel-keeps-row',
  rowRemoved: 'address.row-removed',
  directoryRemoved: 'address.directory-removed',
  canonicalCleared: 'address.canonical-cleared',
  rejectedToastVisible: 'address.rejected-toast-visible',
  retryDraftRetained: 'address.retry-draft-retained',
} as const;

export const roomAddressLifecycleAssertions = {
  ...roomAddressLifecycleHelperAssertions,
  ...roomAddressLifecycleDirectAssertions,
} as const;

export type RoomAddressLifecycleAssertion =
  (typeof roomAddressLifecycleAssertions)[keyof typeof roomAddressLifecycleAssertions];

assert.equal(
  Object.values(roomAddressLifecycleDirectAssertions).length,
  15,
  'Exactly 15 direct Room address assertion identities are required',
);
assert.equal(
  Object.values(roomAddressLifecycleHelperAssertions).length,
  2,
  'Exactly two helper Room address assertion identities are required',
);
assert.equal(
  Object.values(roomAddressLifecycleAssertions).length,
  17,
  'Exactly 17 total Room address assertion identities are required',
);
assert.equal(
  new Set(Object.values(roomAddressLifecycleAssertions)).size,
  17,
  'Room address assertion identities must be unique',
);
