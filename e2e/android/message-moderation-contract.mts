import assert from 'node:assert/strict';

export const MESSAGE_MODERATION_SOURCES = {
  report: {
    helper:
      'e2e/browser/journeys/room-administration/report-message.spec.mts:19-25',
    definition:
      'e2e/browser/journeys/room-administration/report-message.spec.mts:30-80',
  },
  redact: {
    helper:
      'e2e/browser/journeys/room-administration/redact-others.spec.mts:57-63',
    definition:
      'e2e/browser/journeys/room-administration/redact-others.spec.mts:68-143',
  },
} as const;

export const messageModerationAssertions = {
  reportTimelineVisible: 'report.timeline-visible',
  reportSuccessToastVisible: 'report.success-toast-visible',
  redactTimelineVisible: 'redact.timeline-visible',
  redactDeletedMarkerVisible: 'redact.deleted-marker-visible',
  redactOriginalBodyAbsent: 'redact.original-body-absent',
} as const;

export type MessageModerationAssertion =
  (typeof messageModerationAssertions)[keyof typeof messageModerationAssertions];

assert.equal(
  Object.values(messageModerationAssertions).length,
  5,
  'Exactly five message moderation assertion identities are required',
);
assert.equal(
  new Set(Object.values(messageModerationAssertions)).size,
  5,
  'Message moderation assertion identities must be unique',
);
