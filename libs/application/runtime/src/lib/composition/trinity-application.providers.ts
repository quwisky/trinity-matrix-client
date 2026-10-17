import {
  ErrorHandler,
  computed,
  inject,
  makeEnvironmentProviders,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  type EnvironmentProviders,
  type Signal,
} from '@angular/core';
import {
  PreloadAllModules,
  provideRouter,
  withDisabledInitialNavigation,
  withPreloading,
  withRouterConfig,
  type Routes,
} from '@angular/router';
import {
  WORKSPACE_APPLICATION_SURFACE_PRESENTER,
  WORKSPACE_SYSTEM_STATUS,
  type BannerPrompt,
  type SlotForecast as WorkspaceSlotForecast,
  type WorkspaceSystemStatus,
} from '@trinity/application/workspace';
import { provideTrnIcons } from '@trinity/components/foundations';
import { provideTrnOverlayDefaults } from '@trinity/components/overlay';
import {
  provideMatrixSdkLogging,
  type MatrixSdkLogLevel,
} from '@trinity/data-access/matrix-client';
import type { PushConfig } from '@trinity/data-access/notifications';
import {
  WHATS_NEW_LAUNCHER,
  type ReleaseNote,
} from '@trinity/data-access/whats-new';
import {
  DEVICE_CONFIRMATION_POLICY,
  type DeviceConfirmationPolicy,
  type SlotForecast as TrustSlotForecast,
} from '@trinity/data-access/trust';
import {
  ACCOUNT_DELETION_LAUNCHER,
  ACCOUNT_REMOVAL_LAUNCHER,
  ACCOUNT_SWITCH_LAUNCHER,
  BUG_REPORT_LAUNCHER,
  TrinityErrorHandler,
  type BuildInfo,
  provideCapacitorPreferenceStorage,
  provideHostCapabilities,
} from '@trinity/platform-native';
import { APPLICATION_RUNTIME_ADAPTER } from '../application-runtime.adapter';
import {
  ENCRYPTION_DIALOG_COMPONENTS,
  REPORT_BUG_DIALOG_COMPONENT,
  WHATS_NEW_DIALOG_COMPONENT,
  SETTINGS_DIALOG_COMPONENT,
  type ApplicationDialogLoader,
  type EncryptionDialogLoaders,
} from '../application-dialog-loaders';
import { applicationCapabilityProviders } from './application-capability.providers';
import { appLockProviders } from './app-lock.providers';
import { trinityDiagnosticProviders } from './diagnostic-log.providers';
import { AccountDeletionLauncherAdapter } from './account-deletion-launcher.adapter';
import { AccountRemovalLauncherAdapter } from './account-removal-launcher.adapter';
import { AccountSwitchLauncherAdapter } from './account-switch-launcher.adapter';
import { ReportBugLauncherAdapter } from './report-bug-launcher.adapter';
import { WhatsNewLauncherAdapter } from './whats-new-launcher.adapter';
import { TrinityApplicationRuntimeAdapter } from './trinity-application-runtime.adapter';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';
import { CapabilityHealthService } from '../capability-health.service';
import { CapabilityStatusService } from '../capability-status.service';
import { SystemStatusVisibilityService } from '../system-status-visibility.service';

export interface TrinityApplicationDialogLoaders {
  readonly settings: ApplicationDialogLoader;
  readonly encryption: EncryptionDialogLoaders;
  /** Report a bug, for the sign-in screen and System status. */
  readonly reportBug: ApplicationDialogLoader;
  /** The What's new dialog, opened once after an update and from Settings. */
  readonly whatsNew: ApplicationDialogLoader;
}

export interface TrinityApplicationProviderOptions {
  readonly routes: Routes;
  readonly pushConfig: PushConfig | null;
  /** matrix-js-sdk console verbosity; applied before any client is created. */
  readonly matrixSdkLogLevel: MatrixSdkLogLevel;
  /**
   * GitHub repository for Report a bug, from Settings › Advanced, the sign-in screen and
   * System status; null leaves GitHub out.
   */
  readonly issueRepositoryUrl: string | null;
  readonly buildInfo: BuildInfo;
  /** Bundled release notes, newest first; omitted means no What's new dialog. */
  readonly releaseNotes?: readonly ReleaseNote[];
  readonly dialogLoaders: TrinityApplicationDialogLoaders;
  /** The new-device check's build policy; left out, no build offers the debug skip. */
  readonly deviceConfirmation?: DeviceConfirmationPolicy;
}

/** `A` when the two unions have exactly the same members; `never` otherwise. */
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? A : never) : never;

/**
 * Compose the host-neutral Trinity application behind one deep provider interface.
 *
 * Host projects select environment values, routes, lazy features and deployment adapters;
 * Application Runtime owns product startup, session streams and cross-capability bindings.
 */
export function provideTrinityApplication(
  options: TrinityApplicationProviderOptions,
): EnvironmentProviders {
  return makeEnvironmentProviders([
    // SDK logging first: it attaches the diagnostic sink, which the diagnostic log can then
    // detach again once it reads a stored "off".
    provideMatrixSdkLogging(options.matrixSdkLogLevel),
    ...trinityDiagnosticProviders({
      issueRepositoryUrl: options.issueRepositoryUrl,
    }),
    provideZonelessChangeDetection(),
    provideHostCapabilities(),
    provideCapacitorPreferenceStorage(),
    ...applicationCapabilityProviders(options),
    appLockProviders(),
    provideTrnIcons(),
    provideBrowserGlobalErrorListeners(),
    { provide: ErrorHandler, useClass: TrinityErrorHandler },
    provideTrnOverlayDefaults(),
    provideRouter(
      options.routes,
      withDisabledInitialNavigation(),
      withPreloading(PreloadAllModules),
      withRouterConfig({ canceledNavigationResolution: 'computed' }),
    ),
    TrinityApplicationRuntimeAdapter,
    {
      provide: APPLICATION_RUNTIME_ADAPTER,
      useExisting: TrinityApplicationRuntimeAdapter,
    },
    WorkspaceApplicationSurfacePresenterAdapter,
    {
      provide: WORKSPACE_APPLICATION_SURFACE_PRESENTER,
      useExisting: WorkspaceApplicationSurfacePresenterAdapter,
    },
    {
      provide: WORKSPACE_SYSTEM_STATUS,
      useFactory: (): WorkspaceSystemStatus => {
        const health = inject(CapabilityHealthService);
        const visibility = inject(SystemStatusVisibilityService);
        const status = inject(CapabilityStatusService);
        return {
          hasProblems: computed(() => health.problems().length > 0),
          bannerSlot: status.bannerSlot,
          bannerSlotReserved: status.bannerSlotReserved,
          // Fails to compile when the port's prompt kinds and Trust's diverge.
          bannerPrompt: status.bannerPrompt satisfies Signal<
            | (BannerPrompt & {
                readonly kind: SameUnion<
                  TrustSlotForecast,
                  WorkspaceSlotForecast
                >;
              })
            | null
          >,
          show: () => visibility.show(),
        };
      },
    },
    {
      provide: SETTINGS_DIALOG_COMPONENT,
      useValue: options.dialogLoaders.settings,
    },
    {
      provide: ENCRYPTION_DIALOG_COMPONENTS,
      useValue: options.dialogLoaders.encryption,
    },
    {
      provide: REPORT_BUG_DIALOG_COMPONENT,
      useValue: options.dialogLoaders.reportBug,
    },
    { provide: BUG_REPORT_LAUNCHER, useExisting: ReportBugLauncherAdapter },
    {
      provide: WHATS_NEW_DIALOG_COMPONENT,
      useValue: options.dialogLoaders.whatsNew,
    },
    { provide: WHATS_NEW_LAUNCHER, useExisting: WhatsNewLauncherAdapter },
    {
      provide: ACCOUNT_REMOVAL_LAUNCHER,
      useExisting: AccountRemovalLauncherAdapter,
    },
    {
      provide: ACCOUNT_DELETION_LAUNCHER,
      useExisting: AccountDeletionLauncherAdapter,
    },
    {
      provide: ACCOUNT_SWITCH_LAUNCHER,
      useExisting: AccountSwitchLauncherAdapter,
    },
    {
      provide: DEVICE_CONFIRMATION_POLICY,
      useValue: options.deviceConfirmation ?? { allowSkip: false },
    },
  ]);
}
