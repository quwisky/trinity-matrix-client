import { APPEARANCE_PREFERENCE_DESCRIPTORS } from '@trinity/application/appearance';
import {
  CONVERSATION_TYPING,
  ConversationRuntime,
  PRIVACY_PREFERENCE_DESCRIPTORS,
} from '@trinity/data-access/timeline';
import {
  AppLockService,
  type AppLockStatus,
} from '@trinity/data-access/app-lock';
import { NOTIFICATION_VISIBILITY } from '@trinity/data-access/notifications';
import {
  RAIL_UNREAD_CHATS_PREFERENCE,
  RoomListStore,
} from '@trinity/data-access/room-library';
import {
  AppConfigService,
  ACCOUNT_REMOVAL_LAUNCHER,
  ACCOUNT_SWITCH_LAUNCHER,
  BUG_REPORT_LAUNCHER,
  CONFIG_EXPORT_VERSION,
  ExternalBrowserService,
  SessionStorageService,
  exportedKeysFor,
  type BuildInfo,
} from '@trinity/platform-native';
import {
  ChangeDetectionStrategy,
  Component,
  EnvironmentInjector,
  inject,
  signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  DIAGNOSTIC_ACCOUNT_SOURCE,
  DIAGNOSTIC_LOG_STORE_FACTORY,
  DIAGNOSTIC_REPORT_CONFIG,
  DiagnosticLogService,
  MemoryLogStore,
} from '@trinity/data-access/diagnostic-log';
import { TrnDialogRef } from '@trinity/components/overlay';
import { HostFileExportService } from '@trinity/runtime/host';
import { MockProvider } from 'ng-mocks';
import {
  MATRIX_SDK_LOG_SINK,
  configureMatrixSdkLogging,
  matrixSdkLogLevel,
} from '@trinity/data-access/matrix-client';
import { PREFERENCE_STORAGE_ADAPTER } from '@trinity/runtime/preferences';
import { NEVER, firstValueFrom, of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ACCOUNT_LIFECYCLE_PORT } from '@trinity/data-access/accounts';
import {
  DEVICE_CONFIRMATION_POLICY,
  TrustDevicesService,
} from '@trinity/data-access/trust';
import {
  AuthService,
  QR_LINK_IDENTITY_CHECK,
  QR_SIGN_IN_COMPLETION,
  QrSignInAvailability,
} from '@trinity/data-access/auth';
import { AccountRemovalLauncherAdapter } from './account-removal-launcher.adapter';
import { AccountSwitchLauncherAdapter } from './account-switch-launcher.adapter';
import { applicationCapabilityProviders } from './application-capability.providers';
import { ReportBugLauncherAdapter } from './report-bug-launcher.adapter';
import { provideTrinityApplication } from './trinity-application.providers';

/**
 * Stands in for Report a bug (feature-settings, which Application Runtime may not import):
 * it asks the root for exactly what the dialog injects and shows the export's account header.
 */
@Component({
  selector: 'trn-report-bug-probe',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: '<pre data-testid="report-bug-probe">{{ header() }}</pre>',
})
class ReportBugDependencyProbeComponent {
  private readonly log = inject(DiagnosticLogService);

  protected readonly header = signal('');

  constructor() {
    inject(HostFileExportService);
    inject(ExternalBrowserService);
    inject(DIAGNOSTIC_REPORT_CONFIG);
    inject(TrnDialogRef);
    this.log.export().subscribe((bundle) =>
      this.header.set(
        bundle.text
          .split('\n')
          .filter((line) => line.startsWith('# Accounts'))
          .join('\n'),
      ),
    );
  }
}

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
          releaseNotes: [],
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
          releaseNotes: [],
          dialogLoaders: {
            settings: () => NEVER,
            encryption: { unlock: () => NEVER, verify: () => NEVER },
            reportBug: () => NEVER,
            whatsNew: () => NEVER,
            addToImagePack: () => NEVER,
            imagePackEditor: () => NEVER,
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
          releaseNotes: [],
          dialogLoaders: {
            settings: () => NEVER,
            encryption: { unlock: () => NEVER, verify: () => NEVER },
            reportBug: () => NEVER,
            whatsNew: () => NEVER,
            addToImagePack: () => NEVER,
            imagePackEditor: () => NEVER,
          },
        }),
        {
          provide: DIAGNOSTIC_LOG_STORE_FACTORY,
          useValue: () => Promise.resolve(new MemoryLogStore()),
        },
        {
          provide: DIAGNOSTIC_ACCOUNT_SOURCE,
          useValue: {
            accounts: () => of([]),
            knownNames: () => [],
          },
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

  it('CONVERSATION_TYPING names other typists in the room, never the account itself', () => {
    const me = { userId: '@me:hs', displayName: 'Me' };
    const bob = { userId: '@bob:hs', displayName: 'Bob' };
    TestBed.configureTestingModule({
      providers: [
        ...applicationCapabilityProviders({
          buildInfo: {} as BuildInfo,
          releaseNotes: [],
          pushConfig: null,
        }),
        MockProvider(RoomListStore, {
          typing: (() =>
            signal({
              '!r:hs': [me, bob],
              '!other:hs': [bob],
            }).asReadonly()) as never,
        }),
      ],
    });
    const port = TestBed.inject(CONVERSATION_TYPING);

    expect(port.typing('@me:hs', '!r:hs')()).toEqual([bob]);
    expect(port.typing('@me:hs', '!quiet:hs')()).toEqual([]);
  });

  it('tells notifications nobody is looking while App lock covers the app', () => {
    const status = signal<AppLockStatus>('unknown');
    const key = { accountId: '@me:hs', roomId: '!r:hs' };
    const hidden = document.visibilityState === 'hidden';
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    try {
      TestBed.configureTestingModule({
        providers: [
          ...applicationCapabilityProviders({
            buildInfo: {} as BuildInfo,
            releaseNotes: [],
            pushConfig: null,
          }),
          MockProvider(AppLockService, {
            status: status.asReadonly() as never,
          }),
          MockProvider(ConversationRuntime, {
            focused: signal({ key }).asReadonly() as never,
          }),
        ],
      });
      const visibility = TestBed.inject(NOTIFICATION_VISIBILITY);
      const nobody = { foreground: false, hidden, conversation: null };

      expect(visibility.snapshot()).toEqual(nobody); // not known yet: fail closed
      status.set('locked');
      expect(visibility.snapshot()).toEqual(nobody);
      status.set('unlocked');
      expect(visibility.snapshot()).toEqual({
        foreground: true,
        hidden,
        conversation: key,
      });
      status.set('off');
      expect(visibility.snapshot().conversation).toEqual(key);
    } finally {
      vi.restoreAllMocks();
      TestBed.resetTestingModule();
    }
  });

  it('stops and resumes the diagnostic log for a factory reset through the account lifecycle port', async () => {
    const discard = vi.fn(() => of(undefined));
    const resumeAfterReset = vi.fn(() => of(undefined));
    TestBed.configureTestingModule({
      providers: [
        ...applicationCapabilityProviders({
          buildInfo: {} as BuildInfo,
          releaseNotes: [],
          pushConfig: null,
        }),
        {
          provide: DiagnosticLogService,
          useValue: { discard, resumeAfterReset },
        },
      ],
    });
    const port = TestBed.inject(ACCOUNT_LIFECYCLE_PORT);

    await firstValueFrom(port.stopDiagnosticLog());
    expect(discard).toHaveBeenCalledOnce();
    expect(resumeAfterReset).not.toHaveBeenCalled();
    await firstValueFrom(port.resumeDiagnosticLog());

    expect(resumeAfterReset).toHaveBeenCalledOnce();
  });

  it('offers Report a bug to the sign-in screen and System status through BUG_REPORT_LAUNCHER', () => {
    TestBed.configureTestingModule({
      providers: [
        provideTrinityApplication({
          routes: [],
          pushConfig: null,
          matrixSdkLogLevel: 'warn',
          issueRepositoryUrl: null,
          buildInfo: {} as BuildInfo,
          releaseNotes: [],
          dialogLoaders: {
            settings: () => NEVER,
            encryption: { unlock: () => NEVER, verify: () => NEVER },
            reportBug: () => NEVER,
            whatsNew: () => NEVER,
            addToImagePack: () => NEVER,
            imagePackEditor: () => NEVER,
          },
        }),
      ],
    });

    try {
      expect(TestBed.inject(BUG_REPORT_LAUNCHER)).toBe(
        TestBed.inject(ReportBugLauncherAdapter),
      );
    } finally {
      TestBed.resetTestingModule();
      configureMatrixSdkLogging('debug');
    }
  });

  it('offers one account-removal flow to the account menu and the new-device check', () => {
    TestBed.configureTestingModule({
      providers: [
        provideTrinityApplication({
          routes: [],
          pushConfig: null,
          matrixSdkLogLevel: 'warn',
          issueRepositoryUrl: null,
          buildInfo: {} as BuildInfo,
          releaseNotes: [],
          dialogLoaders: {
            settings: () => NEVER,
            encryption: { unlock: () => NEVER, verify: () => NEVER },
            reportBug: () => NEVER,
            whatsNew: () => NEVER,
            addToImagePack: () => NEVER,
            imagePackEditor: () => NEVER,
          },
        }),
      ],
    });

    try {
      expect(TestBed.inject(ACCOUNT_REMOVAL_LAUNCHER)).toBe(
        TestBed.inject(AccountRemovalLauncherAdapter),
      );
    } finally {
      TestBed.resetTestingModule();
      configureMatrixSdkLogging('debug');
    }
  });

  it('offers the new-device check a way to another signed-in account', () => {
    TestBed.configureTestingModule({
      providers: [
        provideTrinityApplication({
          routes: [],
          pushConfig: null,
          matrixSdkLogLevel: 'warn',
          issueRepositoryUrl: null,
          buildInfo: {} as BuildInfo,
          releaseNotes: [],
          dialogLoaders: {
            settings: () => NEVER,
            encryption: { unlock: () => NEVER, verify: () => NEVER },
            reportBug: () => NEVER,
            whatsNew: () => NEVER,
            addToImagePack: () => NEVER,
            imagePackEditor: () => NEVER,
          },
        }),
      ],
    });

    try {
      expect(TestBed.inject(ACCOUNT_SWITCH_LAUNCHER)).toBe(
        TestBed.inject(AccountSwitchLauncherAdapter),
      );
    } finally {
      TestBed.resetTestingModule();
      configureMatrixSdkLogging('debug');
    }
  });

  it('finishes a QR sign-in through the shared sign-in path', () => {
    TestBed.configureTestingModule({
      providers: [
        provideTrinityApplication({
          routes: [],
          pushConfig: null,
          matrixSdkLogLevel: 'warn',
          issueRepositoryUrl: null,
          buildInfo: {} as BuildInfo,
          releaseNotes: [],
          dialogLoaders: {
            settings: () => NEVER,
            encryption: { unlock: () => NEVER, verify: () => NEVER },
            reportBug: () => NEVER,
            whatsNew: () => NEVER,
            addToImagePack: () => NEVER,
            imagePackEditor: () => NEVER,
          },
        }),
      ],
    });

    try {
      expect(TestBed.inject(QR_SIGN_IN_COMPLETION)).toBe(
        TestBed.inject(AuthService),
      );
      expect(TestBed.inject(QR_LINK_IDENTITY_CHECK)).toBe(
        TestBed.inject(TrustDevicesService),
      );
      expect(TestBed.inject(QrSignInAvailability)).toBeTruthy();
    } finally {
      TestBed.resetTestingModule();
      configureMatrixSdkLogging('debug');
    }
  });

  it('offers the debug skip only where the host asks for it', () => {
    const base = {
      routes: [],
      pushConfig: null,
      matrixSdkLogLevel: 'warn' as const,
      issueRepositoryUrl: null,
      buildInfo: {} as BuildInfo,
      releaseNotes: [],
      dialogLoaders: {
        settings: () => NEVER,
        encryption: { unlock: () => NEVER, verify: () => NEVER },
        reportBug: () => NEVER,
        whatsNew: () => NEVER,
        addToImagePack: () => NEVER,
        imagePackEditor: () => NEVER,
      },
    };
    for (const [options, allowSkip] of [
      [base, false],
      [{ ...base, deviceConfirmation: { allowSkip: true } }, true],
    ] as const) {
      TestBed.configureTestingModule({
        providers: [provideTrinityApplication(options)],
      });
      try {
        expect(TestBed.inject(DEVICE_CONFIRMATION_POLICY)).toEqual({
          allowSkip,
        });
      } finally {
        TestBed.resetTestingModule();
        configureMatrixSdkLogging('debug');
      }
    }
  });

  it('opens Report a bug signed out, with everything it needs from the root injector', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideTrinityApplication({
          routes: [],
          pushConfig: null,
          matrixSdkLogLevel: 'warn',
          issueRepositoryUrl: null,
          buildInfo: { version: '1.2.3', commit: 'abc1234', builtAt: '' },
          releaseNotes: [],
          dialogLoaders: {
            settings: () => NEVER,
            encryption: { unlock: () => NEVER, verify: () => NEVER },
            reportBug: () => of(ReportBugDependencyProbeComponent),
            whatsNew: () => NEVER,
            addToImagePack: () => NEVER,
            imagePackEditor: () => NEVER,
          },
        }),
        {
          provide: DIAGNOSTIC_LOG_STORE_FACTORY,
          useValue: () => Promise.resolve(new MemoryLogStore()),
        },
        {
          provide: PREFERENCE_STORAGE_ADAPTER,
          useValue: {
            read: () => of({ kind: 'missing' } as const),
            write: () => of({ kind: 'completed' } as const),
          },
        },
        // Signed out: the account registry is empty.
        MockProvider(SessionStorageService, {
          snapshot: () => of({ activeAccountId: null, accounts: [] }),
        }),
      ],
    });

    try {
      TestBed.inject(EnvironmentInjector);
      TestBed.inject(BUG_REPORT_LAUNCHER).open();
      await vi.waitFor(() => {
        expect(
          document.querySelector('[data-testid="report-bug-probe"]')
            ?.textContent,
        ).toBe('# Accounts signed in: 0');
      });
    } finally {
      TestBed.resetTestingModule();
      configureMatrixSdkLogging('debug');
    }
  });
});
