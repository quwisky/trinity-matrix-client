import assert from 'node:assert/strict';

export const PASSWORD_REGISTRATION_SOURCES = {
  journey: 'e2e/browser/journeys/accounts/registration.spec.mts:10-48',
  app: 'e2e/support/app.mts:124-166',
  account: 'e2e/support/account.mts:57-79',
} as const;

export const passwordRegistrationAssertions = {
  availabilityActionVisible:
    'password-registration.availability-action-visible',
  registrationRoute: 'password-registration.registration-route',
  encryptionSetupRoute: 'password-registration.encryption-setup-route',
  exactMxid: 'password-registration.exact-mxid',
} as const;

assert.equal(
  Object.keys(passwordRegistrationAssertions).length,
  4,
  'Password registration owns exactly four assertion identities',
);
assert.equal(
  new Set(Object.values(passwordRegistrationAssertions)).size,
  4,
  'Password registration assertion identities must be unique',
);

export type PasswordRegistrationAssertion =
  (typeof passwordRegistrationAssertions)[keyof typeof passwordRegistrationAssertions];
