import assert from 'node:assert/strict';

export const ROOM_TOMBSTONE_SOURCE = {
  helper:
    'e2e/browser/journeys/room-administration/tombstone.spec.mts:15-23',
  definition:
    'e2e/browser/journeys/room-administration/tombstone.spec.mts:28-113',
} as const;

export const roomTombstoneAssertions = {
  oldComposerVisible: 'old.composer-visible',
  oldBannerVisible: 'old.banner-visible',
  layoutBannerAboveChatRow: 'layout.banner-above-chat-row',
  layoutTimelineShare: 'layout.timeline-share',
  successorBannerHidden: 'successor.banner-hidden',
  successorComposerVisible: 'successor.composer-visible',
} as const;

export type RoomTombstoneAssertion =
  (typeof roomTombstoneAssertions)[keyof typeof roomTombstoneAssertions];

assert.equal(
  Object.values(roomTombstoneAssertions).length,
  6,
  'Exactly six Room tombstone assertion identities are required',
);
assert.equal(
  new Set(Object.values(roomTombstoneAssertions)).size,
  6,
  'Room tombstone assertion identities must be unique',
);
