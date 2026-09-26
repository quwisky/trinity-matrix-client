import assert from 'node:assert/strict';

export const SPACE_LEAVE_SOURCE = {
  helpers:
    'e2e/browser/journeys/room-administration/space-leave.spec.mts:17-53',
  definition:
    'e2e/browser/journeys/room-administration/space-leave.spec.mts:58-125',
} as const;

export const spaceLeaveAssertions = {
  dialogSpaceName: 'dialog.space-name',
  dialogAccountName: 'dialog.account-name',
  dialogChildMembershipCopy: 'dialog.child-membership-copy',
  cancelMembershipsRetained: 'cancel.memberships-retained',
  cancelSpacePillVisible: 'cancel.space-pill-visible',
  confirmSpaceLeft: 'confirm.space-left',
  confirmChildMembershipRetained: 'confirm.child-membership-retained',
} as const;

export type SpaceLeaveAssertion =
  (typeof spaceLeaveAssertions)[keyof typeof spaceLeaveAssertions];

assert.equal(
  Object.values(spaceLeaveAssertions).length,
  7,
  'Exactly seven Space leave assertion identities are required',
);
assert.equal(
  new Set(Object.values(spaceLeaveAssertions)).size,
  7,
  'Space leave assertion identities must be unique',
);
