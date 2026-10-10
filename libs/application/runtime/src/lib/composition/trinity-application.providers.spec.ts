import { APPEARANCE_PREFERENCE_DESCRIPTORS } from '@trinity/application/appearance';
import { PRIVACY_PREFERENCE_DESCRIPTORS } from '@trinity/data-access/timeline';
import { RAIL_UNREAD_CHATS_PREFERENCE } from '@trinity/data-access/room-library';
import {
  AppConfigService,
  CONFIG_EXPORT_VERSION,
  exportedKeysFor,
  type BuildInfo,
} from '@trinity/platform-native';
import { TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { applicationCapabilityProviders } from './application-capability.providers';

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

  it('pins portable Room Library descriptors to the Advanced config ledger', () => {
    const descriptorKeys = [RAIL_UNREAD_CHATS_PREFERENCE]
      .filter((descriptor) => descriptor.export === 'portable')
      .map((descriptor) => descriptor.persistence.key)
      .sort();

    expect(descriptorKeys).toEqual(
      [...exportedKeysFor('data-access/room-library')].sort(),
    );
  });

  it('imports a config that still carries the retired push gateway, ignoring it', () => {
    TestBed.configureTestingModule({
      providers: [
        ...applicationCapabilityProviders({
          buildInfo: {} as BuildInfo,
          pushConfig: null,
        }),
      ],
    });

    const plan = TestBed.inject(AppConfigService).validate({
      version: CONFIG_EXPORT_VERSION - 1,
      exportedAt: '2026-08-09T00:00:00.000Z',
      settings: {
        push: {
          gateway: {
            gatewayUrl: 'https://push.example/_matrix/push/v1/notify',
            appId: null,
          },
        },
      },
    });

    expect(plan.ok).toBe(true);
    expect(plan.warnings).toEqual([
      'push.gateway.gatewayUrl is not a setting this version of Trinity has, so it will not be applied.',
      'push.gateway.appId is not a setting this version of Trinity has, so it will not be applied.',
    ]);
    expect(plan.ok && plan.changes).toEqual([]);
  });
});
