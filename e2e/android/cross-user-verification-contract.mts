import assert from 'node:assert/strict';

export const CROSS_USER_VERIFICATION_SOURCES = {
  helpers: 'e2e/browser/journeys/trust/verify-user.spec.mts:31-226',
  ordinary: 'e2e/browser/journeys/trust/verify-user.spec.mts:231-244',
  delayed: 'e2e/browser/journeys/trust/verify-user.spec.mts:246-263',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const crossUserVerificationAssertions = {
  shared: {
    membersPanelInitiallyHidden:
      'cross-user-verification.members-panel-initially-hidden',
    membersPanelVisible: 'cross-user-verification.members-panel-visible',
    counterpartMemberVisible:
      'cross-user-verification.counterpart-member-visible',
    memberInfoVisible: 'cross-user-verification.member-info-visible',
    verificationPageVisible:
      'cross-user-verification.verification-page-visible',
  },
  delayed: {
    identityQueryObserved:
      'cross-user-verification.delayed-identity-query-observed',
  },
} as const;

type SharedAssertion =
  (typeof crossUserVerificationAssertions.shared)[keyof typeof crossUserVerificationAssertions.shared];
type DelayedAssertion =
  (typeof crossUserVerificationAssertions.delayed)[keyof typeof crossUserVerificationAssertions.delayed];

export type CrossUserVerificationAssertion =
  | SharedAssertion
  | DelayedAssertion;

const assertionIds = [
  ...Object.values(crossUserVerificationAssertions.shared),
  ...Object.values(crossUserVerificationAssertions.delayed),
] as const;

export const CROSS_USER_VERIFICATION_ASSERTION_RECORDS =
  Object.values(crossUserVerificationAssertions.shared).length * 2 +
  Object.values(crossUserVerificationAssertions.delayed).length;

assert.equal(
  assertionIds.length,
  6,
  'Cross-user verification owns exactly six direct assertion identities',
);
assert.equal(
  new Set(assertionIds).size,
  6,
  'Cross-user verification assertion identities must be unique',
);
assert.equal(
  CROSS_USER_VERIFICATION_ASSERTION_RECORDS,
  11,
  'Cross-user verification owns exactly 11 stage-local records',
);
