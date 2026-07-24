import { bootstrapApplication } from '@angular/platform-browser';
import {
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideZonelessChangeDetection,
} from '@angular/core';
import {
  provideRouter,
  withPreloading,
  PreloadAllModules,
} from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { Capacitor } from '@capacitor/core';
import { AvatarService } from '@trinity/data-access-media';
import { GifSettingsService } from '@trinity/data-access-gif';
import { AccountScopeService } from '@trinity/data-access-rooms';
import {
  AppBadgeService,
  PUSH_CONFIG,
  PushGatewayService,
} from '@trinity/data-access-notifications';
import {
  BUILD_INFO,
  DraftStoreService,
  FeatureFlagsService,
  KeyboardShortcutsService,
  PrivacySettingsService,
  StoragePersistenceService,
  ThemeService,
  TrinityErrorHandler,
} from '@trinity/platform-native';
import {
  AVATAR_RESOLVER,
  ENCRYPTION_DIALOG_COMPONENTS,
  type EncryptionDialogLoaders,
} from '@trinity/ui';
import { provideSpartanHlm } from '@trinity/helm/utils';

import { routes } from './app/app.routes';
import { AppComponent, NavigationFocusService } from '@trinity/feature-shell';
import { environment } from './environments/environment';
import { BUILD_INFO_VALUE } from './app/build-info';

// Desktop (hand-rolled Electron) detection. The preload bridge exposes
// `trinityDesktop.isElectron`; we fall back to the Electron user-agent token in
// case the marker is ever unavailable. Capacitor.isNativePlatform() is FALSE in
// this shell, so the service worker must be gated on this flag too.
const isElectron =
  !!(globalThis as { trinityDesktop?: { isElectron?: boolean } }).trinityDesktop
    ?.isElectron ||
  (typeof navigator !== 'undefined' &&
    navigator.userAgent.includes('Electron'));

bootstrapApplication(AppComponent, {
  providers: [
    // Zoneless change detection (no zone.js). The data-access services' matrix-js-sdk
    // event handlers write signals, which schedule change detection directly. See
    // docs/ZONELESS.md.
    provideZonelessChangeDetection(),
    // Quiet transient homeserver noise (503s / dropped connections during the
    // initial-sync request burst) so SDK-internal rejections don't spam the
    // console as ERROR; genuine errors still reach the default handler.
    { provide: ErrorHandler, useClass: TrinityErrorHandler },
    // Spartan/helm CDK-overlay default: disable Angular 21's usePopover so helm
    // dialogs/tooltips render above position:fixed elements (e.g. the toaster).
    provideSpartanHlm(),
    provideRouter(routes, withPreloading(PreloadAllModules)),
    // Apply the saved light/dark preference before the first paint.
    provideAppInitializer(() => inject(ThemeService).init()),
    // Load persisted experimental feature flags (e.g. virtualized timeline).
    provideAppInitializer(() => inject(FeatureFlagsService).init()),
    // Load persisted privacy preferences (e.g. whether to send read receipts)
    // before the timeline sends its first receipt.
    provideAppInitializer(() => inject(PrivacySettingsService).init()),
    // Load persisted per-conversation composer drafts before any composer mounts,
    // so a half-typed message is restored on cold start.
    provideAppInitializer(() => inject(DraftStoreService).init()),
    // Load any custom keyboard-shortcut bindings before the rooms page mounts, so a
    // rebound chord is in effect from the first keydown.
    provideAppInitializer(() => inject(KeyboardShortcutsService).init()),
    // Ask the browser to make our IndexedDB persistent so multi-account sync +
    // crypto stores aren't evicted under storage pressure (best-effort; no-op where
    // unsupported). Fire-and-forget — nothing blocks startup on the prompt.
    provideAppInitializer(() => {
      void inject(StoragePersistenceService).requestPersistence();
    }),
    // Load the saved GIF provider + API key so the composer knows whether to
    // offer the GIF picker on first paint.
    provideAppInitializer(() => inject(GifSettingsService).init()),
    // Restore which accounts the room list mixes, before the shell projects its
    // first room list — otherwise a multi-account user's chosen mix would flash
    // as single-account on every cold start.
    provideAppInitializer(() => inject(AccountScopeService).init()),
    // Load any user-set push gateway before the shell mounts and calls
    // PushService.register() — otherwise the first registration would use the
    // build-time default (usually none) and push would stay dead until a restart.
    provideAppInitializer(() => inject(PushGatewayService).init()),
    // Instantiate the dock-badge service so its unread-total effect is live for
    // the whole session (desktop-only by feature detection; a no-op elsewhere).
    provideAppInitializer(() => {
      inject(AppBadgeService);
    }),
    // Move focus into the entering page on each route change (replaces Ionic's
    // focus manager) — a11y for screen-reader/keyboard users.
    provideAppInitializer(() => inject(NavigationFocusService).init()),
    // Let <trn-avatar> resolve mxc avatars to authenticated blob URLs (core).
    {
      provide: AVATAR_RESOLVER,
      useFactory: () => {
        const avatars = inject(AvatarService);
        return (mxc: string | null, size: number, accountId?: string) =>
          avatars.resolve(mxc, size, accountId);
      },
    },
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
          import('@trinity/feature-crypto').then((m) => m.EncryptionUnlockPage),
        verify: () =>
          import('@trinity/feature-crypto').then(
            (m) => m.DeviceVerificationPage,
          ),
      } satisfies EncryptionDialogLoaders,
    },
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
});
