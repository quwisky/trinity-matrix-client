import assert from 'node:assert/strict';

const predecessorSource =
  'e2e/browser/journeys/accounts/clear-all-data.spec.mts';

export const CLEAR_ALL_DATA_SOURCES = {
  helpers: `${predecessorSource}:37-80`,
  signedIn: `${predecessorSource}:85-151`,
  signedOut: `${predecessorSource}:153-176`,
  visual: `${predecessorSource}:193-253`,
  app: 'e2e/support/app.mts',
  contrast: 'e2e/browser/support/contrast.mts',
} as const;

export const clearAllDataFunctionalAssertions = {
  signedInSecureTokenWebviewExclusion:
    'clear-all-data.signed-in.secure-token-webview-exclusion',
  signedInNativeAccountPreferencePresent:
    'clear-all-data.signed-in.native-account-preference-present',
  signedInSyncDatabasePresent:
    'clear-all-data.signed-in.sync-database-present',
  signedInCryptoDatabasePresent:
    'clear-all-data.signed-in.crypto-database-present',
  signedInEscapeHatchVisible:
    'clear-all-data.signed-in.escape-hatch-visible',
  signedInMistypeFeedback: 'clear-all-data.signed-in.mistype-feedback',
  signedInMistypePreservesState:
    'clear-all-data.signed-in.mistype-preserves-state',
  signedInNativePreferencesEmpty:
    'clear-all-data.signed-in.native-preferences-empty',
  signedInDatabaseEnumerationReady:
    'clear-all-data.signed-in.database-enumeration-ready',
  signedInDatabasesRemoved:
    'clear-all-data.signed-in.databases-removed',
  signedInSignedOutSurfaceVisible:
    'clear-all-data.signed-in.signed-out-surface-visible',
  signedOutDeadPushPreferencePresent:
    'clear-all-data.signed-out.dead-push-preference-present',
  signedOutNativePreferencesEmpty:
    'clear-all-data.signed-out.native-preferences-empty',
} as const;

export const clearAllDataVisualAssertions = {
  trinityLightApplied: 'clear-all-data.visual.trinity.light.applied',
  trinityLightDangerToken:
    'clear-all-data.visual.trinity.light.danger-token',
  trinityLightAaContrast: 'clear-all-data.visual.trinity.light.aa-contrast',
  trinityDarkApplied: 'clear-all-data.visual.trinity.dark.applied',
  trinityDarkDangerToken:
    'clear-all-data.visual.trinity.dark.danger-token',
  trinityDarkAaContrast: 'clear-all-data.visual.trinity.dark.aa-contrast',
  amethystLightApplied: 'clear-all-data.visual.amethyst.light.applied',
  amethystLightDangerToken:
    'clear-all-data.visual.amethyst.light.danger-token',
  amethystLightAaContrast:
    'clear-all-data.visual.amethyst.light.aa-contrast',
  amethystDarkApplied: 'clear-all-data.visual.amethyst.dark.applied',
  amethystDarkDangerToken:
    'clear-all-data.visual.amethyst.dark.danger-token',
  amethystDarkAaContrast: 'clear-all-data.visual.amethyst.dark.aa-contrast',
} as const;

export const clearAllDataAssertions = {
  ...clearAllDataFunctionalAssertions,
  ...clearAllDataVisualAssertions,
} as const;

export const CLEAR_ALL_DATA_HOVER_EXCLUSION = {
  source: `${predecessorSource}:230-249`,
  platform: 'android',
  media: { hover: 'none', pointer: 'coarse' },
  retainedOwner: predecessorSource,
  reason:
    'Installed Android touch has no supported persistent native hover path; touch is not hover.',
} as const;

assert.equal(
  Object.keys(clearAllDataFunctionalAssertions).length,
  13,
  'Clear-all-data owns exactly 13 functional stage-local identities',
);
assert.equal(
  Object.keys(clearAllDataVisualAssertions).length,
  12,
  'Clear-all-data owns exactly 12 visual stage-local identities',
);
assert.equal(
  Object.keys(clearAllDataAssertions).length,
  25,
  'Clear-all-data owns exactly 25 stage-local identities',
);
assert.equal(
  new Set(Object.values(clearAllDataAssertions)).size,
  25,
  'Clear-all-data identities must be unique',
);

export type ClearAllDataAssertion =
  (typeof clearAllDataAssertions)[keyof typeof clearAllDataAssertions];
