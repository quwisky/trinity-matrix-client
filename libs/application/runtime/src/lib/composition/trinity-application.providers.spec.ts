import { APPEARANCE_PREFERENCE_DESCRIPTORS } from '@trinity/application/appearance';
import { PRIVACY_PREFERENCE_DESCRIPTORS } from '@trinity/data-access/timeline';
import { RAIL_UNREAD_CHATS_PREFERENCE } from '@trinity/data-access/room-library';
import {
  AppConfigService,
  CONFIG_EXPORT_VERSION,
  exportedKeysFor,
  type BuildInfo,
} from '@trinity/platform-native';
import { EnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  DIAGNOSTIC_ACCOUNT_SOURCE,
  DIAGNOSTIC_LOG_STORE_FACTORY,
  DiagnosticLogService,
  MemoryLogStore,
} from '@trinity/data-access/diagnostic-log';
import {
  MATRIX_SDK_LOG_SINK,
  configureMatrixSdkLogging,
  matrixSdkLogLevel,
} from '@trinity/data-access/matrix-client';
import { PREFERENCE_STORAGE_ADAPTER } from '@trinity/runtime/preferences';
import { NEVER, firstValueFrom, of } from 'rxjs';
import { describe, expect, it } from 'vitest';
import { applicationCapabilityProviders } from './application-capability.providers';
import { provideTrinityApplication } from './trinity-application.providers';

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

  it('applies the host-selected matrix-js-sdk log level at startup', () => {
    TestBed.configureTestingModule({
      providers: [
        provideTrinityApplication({
          routes: [],
          pushConfig: null,
          matrixSdkLogLevel: 'warn',
          issueRepositoryUrl: null,
          buildInfo: {} as BuildInfo,
          dialogLoaders: {
            settings: () => NEVER,
            encryption: { unlock: () => NEVER, verify: () => NEVER },
          },
        }),
      ],
    });

    try {
      TestBed.inject(EnvironmentInjector);

      expect(matrixSdkLogLevel()).toBe('warn');
    } finally {
      configureMatrixSdkLogging('debug');
    }
  });

  it('starts the diagnostic log at startup and wires the SDK sink into it', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideTrinityApplication({
          routes: [],
          pushConfig: null,
          matrixSdkLogLevel: 'warn',
          issueRepositoryUrl:
            'https://github.com/quwisky/trinity-matrix-client',
          buildInfo: { version: '1.2.3', commit: 'abc1234', builtAt: '' },
          dialogLoaders: {
            settings: () => NEVER,
            encryption: { unlock: () => NEVER, verify: () => NEVER },
          },
        }),
        {
          provide: DIAGNOSTIC_LOG_STORE_FACTORY,
          useValue: () => Promise.resolve(new MemoryLogStore()),
        },
        {
          provide: DIAGNOSTIC_ACCOUNT_SOURCE,
          useValue: { accounts: () => of([]) },
        },
        {
          provide: PREFERENCE_STORAGE_ADAPTER,
          useValue: {
            read: () => of({ kind: 'missing' } as const),
            write: () => of({ kind: 'completed' } as const),
          },
        },
      ],
    });

    try {
      TestBed.inject(EnvironmentInjector);
      TestBed.inject(MATRIX_SDK_LOG_SINK).write({
        method: 'debug',
        logger: 'matrix',
        args: ['FetchHttpApi: --> GET probe'],
      });

      const bundle = await firstValueFrom(
        TestBed.inject(DiagnosticLogService).export(),
      );

      expect(bundle.text).toContain('app started: Trinity v1.2.3 · abc1234');
      expect(bundle.text).toContain(
        'DEBUG sdk/matrix FetchHttpApi: --> GET probe',
      );
      expect(matrixSdkLogLevel()).toBe('warn');
    } finally {
      TestBed.resetTestingModule();
      configureMatrixSdkLogging('debug');
    }
  });
});
