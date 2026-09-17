import assert from 'node:assert/strict';

export const LEGACY_SSO_SOURCES = {
  signIn: 'e2e/browser/journeys/accounts/sso-login.spec.mts:29-76',
  unverified: 'e2e/browser/journeys/accounts/sso-login.spec.mts:78-107',
  inFlight: 'e2e/browser/journeys/accounts/sso-login.spec.mts:109-198',
  ssoHelper: 'e2e/browser/support/sso.mts',
  app: 'e2e/support/app.mts',
  dex: 'e2e/support/synapse/dex.yaml',
} as const;

export const legacySsoAssertions = {
  signIn: {
    passwordActionVisible: 'legacy-sso.password-action-visible',
    ssoActionVisible: 'legacy-sso.sso-action-visible',
    delegatedActionAbsent: 'legacy-sso.delegated-action-absent',
    persistedRoomsVisible: 'legacy-sso.persisted-rooms-visible',
  },
  unverified: {
    verificationErrorVisible: 'legacy-sso.verification-error-visible',
    backToSignInVisible: 'legacy-sso.back-to-sign-in-visible',
    roomsRouteAbsent: 'legacy-sso.unverified-rooms-route-absent',
    unspentTokenExactMxid: 'legacy-sso.unspent-token-exact-mxid',
  },
  inFlight: {
    completingCopyVisible: 'legacy-sso.completing-copy-visible',
    wordmarkVisible: 'legacy-sso.wordmark-visible',
    wordmarkText: 'legacy-sso.wordmark-text',
    headingCount: 'legacy-sso.heading-count',
    completingHeadingCount: 'legacy-sso.completing-heading-count',
    cardBoundsPresent: 'legacy-sso.card-bounds-present',
    cardMinWidth: 'legacy-sso.card-min-width',
    cardMaxWidth: 'legacy-sso.card-max-width',
    cardNonnegativeX: 'legacy-sso.card-nonnegative-x',
    cardWithinViewport: 'legacy-sso.card-within-viewport',
    mainCount: 'legacy-sso.main-count',
    bodyBoundsPresent: 'legacy-sso.body-bounds-present',
    bodyInset: 'legacy-sso.body-inset',
    verificationErrorAbsent:
      'legacy-sso.inflight-verification-error-absent',
    roomsRouteAbsent: 'legacy-sso.inflight-rooms-route-absent',
  },
} as const;

const assertionIdentities = Object.values(legacySsoAssertions).flatMap(
  (group) => Object.values(group),
);

assert.equal(
  assertionIdentities.length,
  23,
  'Legacy SSO owns exactly 23 direct assertion identities',
);
assert.equal(
  new Set(assertionIdentities).size,
  23,
  'Legacy SSO direct assertion identities must be unique',
);

export type LegacySsoAssertion = (typeof assertionIdentities)[number];
