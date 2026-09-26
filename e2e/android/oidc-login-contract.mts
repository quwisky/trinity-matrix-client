import assert from 'node:assert/strict';

export const OIDC_LOGIN_SOURCES = {
  classification:
    'e2e/browser/journeys/accounts/oidc-login.spec.mts:86-100',
  providerError:
    'e2e/browser/journeys/accounts/oidc-login.spec.mts:102-169',
  redemption: 'e2e/browser/journeys/accounts/oidc-login.spec.mts:171-248',
  fallback: 'e2e/browser/journeys/accounts/oidc-login.spec.mts:250-285',
  app: 'e2e/support/app.mts',
} as const;

export const oidcLoginAssertions = {
  classification: {
    delegatedContinueVisible: 'oidc-login.delegated-continue-visible',
    createAccountVisible: 'oidc-login.create-account-visible',
    passwordActionAbsent: 'oidc-login.password-action-absent',
    legacySsoActionAbsent: 'oidc-login.legacy-sso-action-absent',
  },
  providerError: {
    providerErrorVisible: 'oidc-login.provider-error-visible',
    backToSignInVisible: 'oidc-login.back-to-sign-in-visible',
    authorizeRequestPresent: 'oidc-login.authorize-request-present',
    clientIdExact: 'oidc-login.client-id-exact',
    responseTypeCode: 'oidc-login.response-type-code',
    challengeMethodS256: 'oidc-login.challenge-method-s256',
    challengeNonempty: 'oidc-login.challenge-nonempty',
    stateNonempty: 'oidc-login.state-nonempty',
    callbackUriExact: 'oidc-login.callback-uri-exact',
    registrationApplicationTypeNative:
      'oidc-login.registration-application-type-native',
    scopeClientApi: 'oidc-login.scope-client-api',
    scopeDevice: 'oidc-login.scope-device',
    responseModeQuery: 'oidc-login.response-mode-query',
  },
  redemption: {
    tokenRequestPresent: 'oidc-login.token-request-present',
    grantTypeAuthorizationCode:
      'oidc-login.grant-type-authorization-code',
    authorizationCodeExact: 'oidc-login.authorization-code-exact',
    tokenClientIdExact: 'oidc-login.token-client-id-exact',
    verifierNonempty: 'oidc-login.verifier-nonempty',
    pkceS256Match: 'oidc-login.pkce-s256-match',
    callbackErrorsAbsent: 'oidc-login.callback-errors-absent',
  },
  fallback: {
    passwordActionVisible: 'oidc-login.password-action-visible',
    delegatedContinueAbsent: 'oidc-login.delegated-continue-absent',
  },
} as const;

const assertionIdentities = Object.values(oidcLoginAssertions).flatMap(
  (group) => Object.values(group),
);

assert.equal(
  assertionIdentities.length,
  26,
  'OIDC-native login owns exactly 26 direct assertion identities',
);
assert.equal(
  new Set(assertionIdentities).size,
  26,
  'OIDC-native login assertion identities must be unique',
);

export type OidcLoginAssertion = (typeof assertionIdentities)[number];
