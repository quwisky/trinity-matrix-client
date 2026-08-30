import {
  RoomActionPermissionsService,
  RoomMessageGovernanceService,
  RoomPinGovernanceService,
} from '@trinity/data-access/room-administration';
import { bootstrapApplication } from '@angular/platform-browser';
import {
  ErrorHandler,
  inject,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import {
  provideRouter,
  withDisabledInitialNavigation,
  withPreloading,
  withRouterConfig,
  PreloadAllModules,
} from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { Capacitor } from '@capacitor/core';
import { AvatarService, MediaService } from '@trinity/data-access/media';
import { WORKSPACE_APPLICATION_SURFACE_PRESENTER } from '@trinity/application/workspace';
import { BADGE_SINK, type BadgeSink } from '@trinity/application/badge';
import { OidcClientService } from '@trinity/data-access/auth';
import {
  ACCOUNT_LIFECYCLE_PORT,
  type AccountLifecyclePort,
} from '@trinity/data-access/accounts';
import { provideGifConfigEntries } from '@trinity/data-access/gif';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  type RoomLibraryGovernancePolicy,
} from '@trinity/data-access/room-library';
import {
  CONVERSATION_MESSAGE_POLICY,
  CONVERSATION_PIN_POLICY,
  CONVERSATION_PRIVACY_PREFERENCES,
  ConversationRuntime,
  type ConversationMessagePolicy,
  type ConversationPinPolicy,
  provideConversationPrivacyPreferences,
} from '@trinity/data-access/timeline';
import {
  NOTIFICATION_VISIBILITY,
  PUSH_CONFIG,
  PushService,
  type NotificationVisibilityPort,
  providePushConfigEntries,
} from '@trinity/data-access/notifications';
import {
  BUILD_INFO,
  DraftStoreService,
  TrinityErrorHandler,
  isElectronRenderer,
  provideHostCapabilities,
  provideCapacitorPreferenceStorage,
  providePrivacyPreferenceSet,
  providePlatformConfigEntries,
} from '@trinity/platform-native';
import {
  APPLICATION_RUNTIME_ADAPTER,
  ApplicationRootComponent,
  ApplicationRuntimeService,
} from '@trinity/application/runtime';
import { HostBadgeService } from '@trinity/runtime/host';
import {
  ENCRYPTION_DIALOG_COMPONENTS,
  type EncryptionDialogLoaders,
} from '@trinity/components/encryption-dialog';
import { AVATAR_RESOLVER } from '@trinity/components/avatar';
import { provideTrnIcons } from '@trinity/components/icon';
import { provideTrnOverlayDefaults } from '@trinity/components/overlay';

import { routes } from './app/app.routes';
import { environment } from './environments/environment';
import { BUILD_INFO_VALUE } from './app/build-info';
import { WorkspaceApplicationSurfacePresenterAdapter } from './app/workspace-application-surface.presenter';
import { TrinityApplicationRuntimeAdapter } from './app/trinity-application-runtime.adapter';
import { of, take } from 'rxjs';

// Desktop (hand-rolled Electron) detection. Capacitor.isNativePlatform() is FALSE in
// this shell, so the service worker must be gated on this flag too. The predicate lives
// next to the bridge it reads (and is unit-tested there); this file is the composition
// root and has no test of its own.
const isElectron = isElectronRenderer();

void bootstrapApplication(ApplicationRootComponent, {
  providers: [
    // Zoneless change detection (no zone.js). The data-access services' matrix-js-sdk
    // event handlers write signals, which schedule change detection directly. See
    // docs/architecture/state-and-reactivity.md.
    provideZonelessChangeDetection(),
    provideHostCapabilities(),
    provideCapacitorPreferenceStorage(),
    provideConversationPrivacyPreferences(),
    providePrivacyPreferenceSet(CONVERSATION_PRIVACY_PREFERENCES),
    {
      provide: ROOM_LIBRARY_GOVERNANCE_POLICY,
      useFactory: (): RoomLibraryGovernancePolicy => {
        const permissions = inject(RoomActionPermissionsService);
        return {
          authorize: (roomId, action) => {
            const availability =
              action === 'invite'
                ? permissions.room(roomId).invite
                : permissions.room(roomId).curateSpace;
            return availability.available
              ? { kind: 'allowed' }
              : {
                  kind: 'rejected',
                  reason:
                    availability.reason ?? 'This room action is unavailable.',
                };
          },
        };
      },
    },
    {
      provide: BADGE_SINK,
      useFactory: (): BadgeSink => {
        const host = inject(HostBadgeService);
        return { write: (count) => host.set(count) };
      },
    },
    {
      provide: CONVERSATION_MESSAGE_POLICY,
      useFactory: (): ConversationMessagePolicy => {
        const governance = inject(RoomMessageGovernanceService);
        return {
          canRedactOthers: (key) => governance.canRedactOthers(key),
          authorizeRedaction: ({ key, messageId }) =>
            governance.authorizeRedaction({ ...key, messageId }),
        };
      },
    },
    {
      provide: CONVERSATION_PIN_POLICY,
      useFactory: (): ConversationPinPolicy => {
        const governance = inject(RoomPinGovernanceService);
        return {
          canMutate: (key) => governance.canMutate(key),
          authorize: (key, operation, eventId) =>
            governance.authorize(key, operation, eventId),
        };
      },
    },
    {
      provide: NOTIFICATION_VISIBILITY,
      useFactory: (): NotificationVisibilityPort => {
        const conversations = inject(ConversationRuntime);
        return {
          snapshot: () => ({
            foreground: document.hasFocus(),
            conversation: conversations.focused()?.key ?? null,
          }),
        };
      },
    },
    {
      provide: ACCOUNT_LIFECYCLE_PORT,
      useFactory: (): AccountLifecyclePort => {
        const avatars = inject(AvatarService);
        const media = inject(MediaService);
        const push = inject(PushService);
        const drafts = inject(DraftStoreService);
        const oidc = inject(OidcClientService);
        return {
          registerNotifications: () => push.register(),
          unregisterNotifications: (accountId) => push.unregister(accountId),
          revokeProviderSession: (session) =>
            session.oidc
              ? oidc.revokeTokens(session.baseUrl, session.oidc, {
                  accessToken: session.accessToken,
                  refreshToken: session.refreshToken,
                })
              : of(void 0),
          releaseSharedCaches: () => {
            avatars.releaseAll();
            media.releaseAll();
          },
          clearDrafts: () => drafts.clearAll(),
        };
      },
    },
    // Every icon, registered once. Replaces 32 per-component provideIcons() calls, each
    // of which declared only the subset its own component used — so an icon rendered in
    // one place and silently nowhere in another.
    provideTrnIcons(),
    // Installs the window 'error'/'unhandledrejection' listeners that forward to
    // ErrorHandler. REQUIRED here: zone.js used to do this via NgZone.onUnhandledError,
    // and without it the handler below only ever sees errors thrown *inside* Angular —
    // every SDK promise rejection (the thing it was written to triage) would reach no
    // application handler at all.
    provideBrowserGlobalErrorListeners(),
    // Quiet transient homeserver noise (503s / dropped connections during the
    // initial-sync request burst) so SDK-internal rejections don't spam the
    // console as ERROR; genuine errors still reach the default handler.
    { provide: ErrorHandler, useClass: TrinityErrorHandler },
    // CDK-overlay default: turn OFF Angular 21's usePopover. That mode renders overlays in
    // the top layer, ABOVE every position:fixed element — so a dialog or tooltip would draw
    // over the toaster that is meant to sit on top of it. See the provider's own header.
    provideTrnOverlayDefaults(),
    // `canceledNavigationResolution: 'computed'` is required by the canDeactivate guards
    // on /encryption/{setup,unlock}: under the default 'replace', a guard that cancels a
    // popstate navigation makes the router replaceState the current URL over the entry
    // the browser has ALREADY moved to, destroying the forward entry — so the next Back
    // press jumps two entries instead of asking again. 'computed' navigates back to the
    // matching history index instead.
    provideRouter(
      routes,
      withDisabledInitialNavigation(),
      withPreloading(PreloadAllModules),
      withRouterConfig({ canceledNavigationResolution: 'computed' }),
    ),
    {
      provide: APPLICATION_RUNTIME_ADAPTER,
      useExisting: TrinityApplicationRuntimeAdapter,
    },
    TrinityApplicationRuntimeAdapter,
    // Let <trn-avatar> resolve mxc avatars to authenticated blob URLs (core).
    {
      provide: AVATAR_RESOLVER,
      useFactory: () => {
        const avatars = inject(AvatarService);
        return (mxc: string | null, size: number, accountId?: string) =>
          avatars.resolve(mxc, size, accountId);
      },
    },
    // Which settings Settings -> Advanced reads, exports and resets. Each owning lib
    // contributes its own through the multi: true APP_CONFIG_ENTRIES token, so the
    // settings feature never imports a data-access service it may not reach and
    // platform-native never imports data-access (which the Nx rules forbid). Every key in
    // the workspace is classified in CONFIG_KEY_LEDGER, exported or not; a new one that is
    // not fails scripts/config-schema-drift.spec.mjs.
    providePlatformConfigEntries(),
    provideGifConfigEntries(),
    providePushConfigEntries(),
    // Push-gateway config for PushService (null = push disabled; see environment.ts).
    { provide: PUSH_CONFIG, useValue: environment.push },
    // Running build's version/commit (regenerated at build), shown in Settings.
    { provide: BUILD_INFO, useValue: BUILD_INFO_VALUE },
    // Lazy loaders so EncryptionDialogService (ui) can present the unlock/verify
    // pages as desktop modals without ui/core importing feature-crypto. Dynamic
    // imports (as in app.routes / verification-host) keep the feature in its own
    // lazy chunk; only the wide split-pane layout actually opens a modal.
    {
      provide: ENCRYPTION_DIALOG_COMPONENTS,
      useValue: {
        unlock: () =>
          import('@trinity/feature/crypto').then((m) => m.EncryptionUnlockPage),
        verify: () =>
          import('@trinity/feature/crypto').then(
            (m) => m.DeviceVerificationPage,
          ),
      } satisfies EncryptionDialogLoaders,
    },
    // All in-app Settings and trust entry points use one typed Workspace presenter.
    // Direct URLs remain canonical deep links; placement and lazy UI stay app-owned.
    {
      provide: WORKSPACE_APPLICATION_SURFACE_PRESENTER,
      useExisting: WorkspaceApplicationSurfacePresenterAdapter,
    },
    WorkspaceApplicationSurfacePresenterAdapter,
    // Precache the app shell + crypto WASM for offline (web/PWA only). Native
    // (Capacitor) and desktop (Electron) already load these as bundled assets and
    // must NOT layer a second SW cache over them — gate on web + production.
    // NB: Capacitor.isNativePlatform() is false inside the hand-rolled Electron
    // shell, so we additionally exclude Electron via the preload marker / UA.
    provideServiceWorker('ngsw-worker.js', {
      enabled:
        environment.production && !Capacitor.isNativePlatform() && !isElectron,
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
}).then((applicationRef) => {
  const runtime = applicationRef.injector.get(ApplicationRuntimeService);
  const errors = applicationRef.injector.get(ErrorHandler);
  const runtimeSubscription = runtime
    .run()
    .subscribe({ error: (error: unknown) => errors.handleError(error) });
  applicationRef.onDestroy(() => {
    runtime.stop().pipe(take(1)).subscribe();
    runtimeSubscription.unsubscribe();
  });
});
