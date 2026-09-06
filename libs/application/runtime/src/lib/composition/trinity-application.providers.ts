import {
  ErrorHandler,
  computed,
  inject,
  makeEnvironmentProviders,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
  type EnvironmentProviders,
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
  type WorkspaceSystemStatus,
} from '@trinity/application/workspace';
import { provideTrnIcons } from '@trinity/components/foundations';
import { provideTrnOverlayDefaults } from '@trinity/components/overlay';
import type { PushConfig } from '@trinity/data-access/notifications';
import {
  TrinityErrorHandler,
  type BuildInfo,
  provideCapacitorPreferenceStorage,
  provideHostCapabilities,
} from '@trinity/platform-native';
import { APPLICATION_RUNTIME_ADAPTER } from '../application-runtime.adapter';
import {
  ENCRYPTION_DIALOG_COMPONENTS,
  SETTINGS_DIALOG_COMPONENT,
  type ApplicationDialogLoader,
  type EncryptionDialogLoaders,
} from '../application-dialog-loaders';
import { applicationCapabilityProviders } from './application-capability.providers';
import { TrinityApplicationRuntimeAdapter } from './trinity-application-runtime.adapter';
import { WorkspaceApplicationSurfacePresenterAdapter } from './workspace-application-surface.presenter';
import { CapabilityHealthService } from '../capability-health.service';
import { SystemStatusVisibilityService } from '../system-status-visibility.service';

export interface TrinityApplicationDialogLoaders {
  readonly settings: ApplicationDialogLoader;
  readonly encryption: EncryptionDialogLoaders;
}

export interface TrinityApplicationProviderOptions {
  readonly routes: Routes;
  readonly pushConfig: PushConfig | null;
  readonly buildInfo: BuildInfo;
  readonly dialogLoaders: TrinityApplicationDialogLoaders;
}

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
    provideZonelessChangeDetection(),
    provideHostCapabilities(),
    provideCapacitorPreferenceStorage(),
    ...applicationCapabilityProviders(options),
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
        return {
          hasProblems: computed(() => health.problems().length > 0),
          show: (restoreFocus) => visibility.show(restoreFocus),
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
  ]);
}
