import assert from 'node:assert/strict';

const predecessor =
  'e2e/browser/journeys/trust/security-settings.spec.mts';

export const SECURITY_SETTINGS_SOURCES = {
  posture: `${predecessor}:51-84`,
  narrow: `${predecessor}:86-136`,
  androidNarrow: `${predecessor}:105-121`,
  excludedFault: `${predecessor}:138-223`,
  navigation: 'e2e/support/journeys/navigation.mts:11-60',
  app: 'e2e/support/app.mts',
  account: 'e2e/support/account.mts',
} as const;

export const securitySettingsInheritedAssertions = {
  postureRoomsAccountQualified:
    'security-settings.posture.rooms-account-qualified',
  postureSettingsNavigationVisible:
    'security-settings.posture.settings-navigation-visible',
  postureSettingsDetailNonEmpty:
    'security-settings.posture.settings-detail-non-empty',
  narrowRoomsAccountQualified:
    'security-settings.narrow.rooms-account-qualified',
  narrowSettingsNavigationVisible:
    'security-settings.narrow.settings-navigation-visible',
  narrowSettingsDetailNonEmpty:
    'security-settings.narrow.settings-detail-non-empty',
} as const;

export const securitySettingsDirectAssertions = {
  postureRootVisible: 'security-settings.posture.root-visible',
  postureSessionVisible: 'security-settings.posture.session-visible',
  postureBackupVisible: 'security-settings.posture.backup-visible',
  postureVerifyVisible: 'security-settings.posture.verify-visible',
  postureSetupVisibleAndRoute:
    'security-settings.posture.setup-visible-and-route',
  narrowVerifyVisible: 'security-settings.narrow.verify-visible',
  narrowVerifyPageVisible: 'security-settings.narrow.verify-page-visible',
  narrowVerifyHeadingFocused:
    'security-settings.narrow.verify-heading-focused',
  narrowSecurityHeadingFocused:
    'security-settings.narrow.security-heading-focused',
} as const;

export const securitySettingsAssertions = {
  ...securitySettingsInheritedAssertions,
  ...securitySettingsDirectAssertions,
} as const;

assert.equal(
  Object.keys(securitySettingsInheritedAssertions).length,
  6,
  'Security settings owns exactly six inherited assertion identities',
);
assert.equal(
  Object.keys(securitySettingsDirectAssertions).length,
  9,
  'Security settings owns exactly nine direct assertion identities',
);
assert.equal(
  Object.keys(securitySettingsAssertions).length,
  15,
  'Security settings owns exactly 15 assertion identities',
);
assert.equal(
  new Set(Object.values(securitySettingsAssertions)).size,
  15,
  'Security settings assertion identities must be unique',
);

export type SecuritySettingsAssertion =
  (typeof securitySettingsAssertions)[keyof typeof securitySettingsAssertions];
