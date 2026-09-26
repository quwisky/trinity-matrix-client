import assert from 'node:assert/strict';

export const JUMP_TO_LATEST_SOURCES = {
  setup:
    'e2e/browser/journeys/conversations/jump-to-latest.spec.mts:24-110',
  helper:
    'e2e/browser/journeys/conversations/jump-to-latest.spec.mts:104-110',
  definition:
    'e2e/browser/journeys/conversations/jump-to-latest.spec.mts:115-167',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const JUMP_TO_LATEST_ANDROID_REPLACEMENT = {
  source:
    'e2e/browser/journeys/conversations/jump-to-latest.spec.mts:153-161',
  predecessor: 'Android DOM scroll workaround',
  replacement: 'measured Maestro native swipe',
} as const;

export const jumpToLatestAssertions = {
  roomReady: 'jump-to-latest.room-ready',
  timelineVisible: 'jump-to-latest.timeline-visible',
  initialBottomSettled: 'jump-to-latest.initial.bottom-settled',
  initialPillHidden: 'jump-to-latest.initial.pill-hidden',
  initialScrollableRange: 'jump-to-latest.initial.scrollable-range',
  scrolledPillVisible: 'jump-to-latest.scrolled.pill-visible',
  resultPillHidden: 'jump-to-latest.result.pill-hidden',
} as const;

export const JUMP_TO_LATEST_ASSERTION_RECORDS = 7;
export const JUMP_TO_LATEST_MESSAGE_COUNT = 20;
export const JUMP_TO_LATEST_BOTTOM_BOUND_PX = 50;
export const JUMP_TO_LATEST_MIN_RANGE_PX = 300;

const assertionIds = Object.values(jumpToLatestAssertions);
assert.equal(assertionIds.length, JUMP_TO_LATEST_ASSERTION_RECORDS);
assert.equal(new Set(assertionIds).size, JUMP_TO_LATEST_ASSERTION_RECORDS);
