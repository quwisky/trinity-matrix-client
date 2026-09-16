import assert from 'node:assert/strict';

const journeySource =
  'e2e/browser/journeys/accounts/change-password.spec.mts';

export const ACCOUNT_PASSWORD_CHANGE_SOURCES = {
  journey: `${journeySource}:52-94`,
  formReady: `${journeySource}:42-47`,
  navigation: 'e2e/support/journeys/navigation.mts:11-60',
  app: 'e2e/support/app.mts',
} as const;

export const accountPasswordChangeInheritedAssertions = {
  roomsAccountQualified: 'password-change.rooms-account-qualified',
  settingsNavigationVisible:
    'password-change.settings-navigation-visible',
  settingsDetailNonEmpty: 'password-change.settings-detail-non-empty',
} as const;

export const accountPasswordChangeDirectAssertions = {
  formReady: 'password-change.form-ready',
  wrongCurrentFeedback: 'password-change.wrong-current-feedback',
  successToast: 'password-change.success-toast',
  newPasswordLoginStatus: 'password-change.new-password-login-status',
  oldPasswordLoginStatus: 'password-change.old-password-login-status',
} as const;

export const accountPasswordChangeAssertions = {
  ...accountPasswordChangeInheritedAssertions,
  ...accountPasswordChangeDirectAssertions,
} as const;

assert.equal(
  Object.keys(accountPasswordChangeDirectAssertions).length,
  5,
  'Account password change owns exactly five direct assertion identities',
);
assert.equal(
  Object.keys(accountPasswordChangeInheritedAssertions).length,
  3,
  'Account password change owns exactly three inherited assertion identities',
);
assert.equal(
  Object.keys(accountPasswordChangeAssertions).length,
  8,
  'Account password change owns exactly eight assertion identities',
);
assert.equal(
  new Set(Object.values(accountPasswordChangeAssertions)).size,
  8,
  'Account password change assertion identities must be unique',
);

export type AccountPasswordChangeAssertion =
  (typeof accountPasswordChangeAssertions)[keyof typeof accountPasswordChangeAssertions];
