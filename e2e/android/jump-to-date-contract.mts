import assert from 'node:assert/strict';

export const JUMP_TO_DATE_SOURCES = {
  helper: 'e2e/browser/journeys/conversations/jump-to-date.spec.mts:22-30',
  applicable:
    'e2e/browser/journeys/conversations/jump-to-date.spec.mts:42-119',
  browserOnly:
    'e2e/browser/journeys/conversations/jump-to-date.spec.mts:121-176',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const JUMP_TO_DATE_BROWSER_ONLY = {
  source: JUMP_TO_DATE_SOURCES.browserOnly,
  reason: 'requires forbidden future-date DOM mutation',
} as const;

export const jumpToDateAssertions = {
  roomReady: 'jump-to-date.room-ready',
  initialNewestVisible: 'jump-to-date.initial.newest-visible',
  initialMarkerAbsent: 'jump-to-date.initial.marker-absent',
  dialogCurrentDate: 'jump-to-date.dialog.current-date',
  resultMarkerVisible: 'jump-to-date.result.marker-visible',
} as const;

export type JumpToDateAssertion =
  (typeof jumpToDateAssertions)[keyof typeof jumpToDateAssertions];

export const jumpToDateStageAssertions = [
  jumpToDateAssertions.roomReady,
  jumpToDateAssertions.initialNewestVisible,
  jumpToDateAssertions.initialMarkerAbsent,
  jumpToDateAssertions.dialogCurrentDate,
  jumpToDateAssertions.resultMarkerVisible,
] as const;

export const JUMP_TO_DATE_ASSERTION_RECORDS =
  jumpToDateStageAssertions.length;
export const JUMP_TO_DATE_FILLER_COUNT = 120;

assert.equal(
  JUMP_TO_DATE_ASSERTION_RECORDS,
  5,
  'Jump-to-date owns exactly five assertion identities',
);
assert.equal(
  new Set(jumpToDateStageAssertions).size,
  JUMP_TO_DATE_ASSERTION_RECORDS,
  'Jump-to-date assertion identities must be unique',
);
