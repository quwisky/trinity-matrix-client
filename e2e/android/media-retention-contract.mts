import assert from 'node:assert/strict';

export const MEDIA_RETENTION_SOURCES = {
  fixture:
    'e2e/browser/journeys/conversations/media-retention.spec.mts:16-167',
  helpers:
    'e2e/browser/journeys/conversations/media-retention.spec.mts:169-221',
  definition:
    'e2e/browser/journeys/conversations/media-retention.spec.mts:226-257',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const MEDIA_RETENTION_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
export const MEDIA_RETENTION_PLAIN_FILENAME = 'retained-plain.png';
export const MEDIA_RETENTION_ENCRYPTED_FILENAME = 'retained-encrypted.png';
export const MEDIA_RETENTION_ROOM_ASSERTIONS = 5;
export const MEDIA_RETENTION_READY_ASSERTIONS = 18;
export const MEDIA_RETENTION_LIGHTBOX_ASSERTIONS = 24;
export const MEDIA_RETENTION_ASSERTION_RECORDS = 47;

export const mediaRetentionAssertions = [
  'media-retention.initial.room-a-ready',
  'media-retention.round-1.room-b-ready',
  'media-retention.round-1.room-a-ready',
  'media-retention.round-2.room-b-ready',
  'media-retention.round-2.room-a-ready',
  'media-retention.initial.plain.bubble-ready',
  'media-retention.initial.plain.image-complete',
  'media-retention.initial.plain.natural-width-positive',
  'media-retention.initial.encrypted.bubble-ready',
  'media-retention.initial.encrypted.image-complete',
  'media-retention.initial.encrypted.natural-width-positive',
  'media-retention.round-1.plain.bubble-ready',
  'media-retention.round-1.plain.image-complete',
  'media-retention.round-1.plain.natural-width-positive',
  'media-retention.round-1.encrypted.bubble-ready',
  'media-retention.round-1.encrypted.image-complete',
  'media-retention.round-1.encrypted.natural-width-positive',
  'media-retention.round-2.plain.bubble-ready',
  'media-retention.round-2.plain.image-complete',
  'media-retention.round-2.plain.natural-width-positive',
  'media-retention.round-2.encrypted.bubble-ready',
  'media-retention.round-2.encrypted.image-complete',
  'media-retention.round-2.encrypted.natural-width-positive',
  'media-retention.initial.plain.dialog-visible',
  'media-retention.initial.plain.lightbox-image-complete',
  'media-retention.initial.plain.lightbox-natural-width-positive',
  'media-retention.initial.plain.dialog-hidden',
  'media-retention.initial.encrypted.dialog-visible',
  'media-retention.initial.encrypted.lightbox-image-complete',
  'media-retention.initial.encrypted.lightbox-natural-width-positive',
  'media-retention.initial.encrypted.dialog-hidden',
  'media-retention.round-1.plain.dialog-visible',
  'media-retention.round-1.plain.lightbox-image-complete',
  'media-retention.round-1.plain.lightbox-natural-width-positive',
  'media-retention.round-1.plain.dialog-hidden',
  'media-retention.round-1.encrypted.dialog-visible',
  'media-retention.round-1.encrypted.lightbox-image-complete',
  'media-retention.round-1.encrypted.lightbox-natural-width-positive',
  'media-retention.round-1.encrypted.dialog-hidden',
  'media-retention.round-2.plain.dialog-visible',
  'media-retention.round-2.plain.lightbox-image-complete',
  'media-retention.round-2.plain.lightbox-natural-width-positive',
  'media-retention.round-2.plain.dialog-hidden',
  'media-retention.round-2.encrypted.dialog-visible',
  'media-retention.round-2.encrypted.lightbox-image-complete',
  'media-retention.round-2.encrypted.lightbox-natural-width-positive',
  'media-retention.round-2.encrypted.dialog-hidden',
] as const;

export type MediaRetentionAssertion =
  (typeof mediaRetentionAssertions)[number];
export type MediaRetentionVisit = 'initial' | 'round-1' | 'round-2';
export type MediaRetentionAttachmentKind = 'plain' | 'encrypted';
export type MediaRetentionRoomVisit =
  | 'initial.room-a-ready'
  | 'round-1.room-b-ready'
  | 'round-1.room-a-ready'
  | 'round-2.room-b-ready'
  | 'round-2.room-a-ready';

const assertionSet = new Set<string>(mediaRetentionAssertions);
assert.equal(
  mediaRetentionAssertions.length,
  MEDIA_RETENTION_ASSERTION_RECORDS,
  'Exactly 47 media-retention assertion records are required',
);
assert.equal(
  assertionSet.size,
  MEDIA_RETENTION_ASSERTION_RECORDS,
  'Media-retention assertion identities are globally unique',
);

function exactAssertion(identity: string): MediaRetentionAssertion {
  assert(
    assertionSet.has(identity),
    `Unknown media-retention assertion identity ${identity}`,
  );
  return identity as MediaRetentionAssertion;
}

export function mediaRetentionRoomAssertion(
  visit: MediaRetentionRoomVisit,
): MediaRetentionAssertion {
  return exactAssertion(`media-retention.${visit}`);
}

export function mediaRetentionReadyAssertions(
  visit: MediaRetentionVisit,
  kind: MediaRetentionAttachmentKind,
): readonly [
  MediaRetentionAssertion,
  MediaRetentionAssertion,
  MediaRetentionAssertion,
] {
  return [
    exactAssertion(`media-retention.${visit}.${kind}.bubble-ready`),
    exactAssertion(`media-retention.${visit}.${kind}.image-complete`),
    exactAssertion(
      `media-retention.${visit}.${kind}.natural-width-positive`,
    ),
  ];
}

export function mediaRetentionLightboxAssertions(
  visit: MediaRetentionVisit,
  kind: MediaRetentionAttachmentKind,
): readonly [
  MediaRetentionAssertion,
  MediaRetentionAssertion,
  MediaRetentionAssertion,
  MediaRetentionAssertion,
] {
  return [
    exactAssertion(`media-retention.${visit}.${kind}.dialog-visible`),
    exactAssertion(
      `media-retention.${visit}.${kind}.lightbox-image-complete`,
    ),
    exactAssertion(
      `media-retention.${visit}.${kind}.lightbox-natural-width-positive`,
    ),
    exactAssertion(`media-retention.${visit}.${kind}.dialog-hidden`),
  ];
}
