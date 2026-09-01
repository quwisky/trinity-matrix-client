import { APPEARANCE_PREFERENCE_DESCRIPTORS } from '@trinity/application/appearance';
import { PRIVACY_PREFERENCE_DESCRIPTORS } from '@trinity/data-access/timeline';
import { exportedKeysFor } from '@trinity/platform-native';
import { describe, expect, it } from 'vitest';

describe('Trinity application provider composition', () => {
  it('pins portable Appearance descriptors to the Advanced config ledger', () => {
    const descriptorKeys = APPEARANCE_PREFERENCE_DESCRIPTORS.filter(
      (descriptor) => descriptor.export === 'portable',
    )
      .map((descriptor) => descriptor.persistence.key)
      .sort();
    const exportedAppearanceKeys = [
      ...exportedKeysFor('application/appearance'),
      ...exportedKeysFor('data-access/timeline'),
    ].sort();

    expect(descriptorKeys).toEqual(exportedAppearanceKeys);
  });

  it('pins portable Conversations privacy descriptors to the Advanced config ledger', () => {
    const descriptorKeys = PRIVACY_PREFERENCE_DESCRIPTORS.filter(
      (descriptor) => descriptor.export === 'portable',
    )
      .map((descriptor) => descriptor.persistence.key)
      .sort();
    const exportedPrivacyKeys = exportedKeysFor('platform-native')
      .filter((key) => key.startsWith('trinity.privacy.'))
      .sort();

    expect(descriptorKeys).toEqual(exportedPrivacyKeys);
  });
});
