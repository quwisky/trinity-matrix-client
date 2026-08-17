import { bootstrapApplication } from '@angular/platform-browser';
import {
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
  provideZonelessChangeDetection,
} from '@angular/core';
import {
  provideRouter,
  withPreloading,
  withRouterConfig,
  PreloadAllModules,
} from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { Capacitor } from '@capacitor/core';
import { AvatarService } from '@trinity/data-access/media';
import {
  GifSettingsService,
  provideGifConfigEntries,
} from '@trinity/data-access/gif';
import {
  AccountScopeService,
  SpaceRoomOrderService,
} from '@trinity/data-access/rooms';
import {
  AppBadgeService,
  PUSH_CONFIG,
  PushGatewayService,
  providePushConfigEntries,
} from '@trinity/data-access/notifications';
import {
  BUILD_INFO,
  DateTimeFormatService,
  DraftStoreService,
  FeatureFlagsService,
  KeyboardShortcutsService,
  PrivacySettingsService,
  StoragePersistenceService,
  SystemLineSettingsService,
  ComposerSettingsService,
  ThemeService,
  TrinityErrorHandler,
  isElectronRenderer,
  providePlatformConfigEntries,
} from '@trinity/platform-native';
import {
  AVATAR_RESOLVER,
  ENCRYPTION_DIALOG_COMPONENTS,
  type EncryptionDialogLoaders,
} from '@trinity/ui';
import { provideTrnIcons } from '@trinity/components/icon';
import { provideTrnOverlayDefaults } from '@trinity/components/overlay';

import { routes } from './app/app.routes';
import { AppComponent, NavigationFocusService } from '@trinity/feature/shell';
import { environment } from './environments/environment';
import { BUILD_INFO_VALUE } from './app/build-info';

// Desktop (hand-rolled Electron) detection. Capacitor.isNativePlatform() is FALSE in
// this shell, so the service worker must be gated on this flag too. The predicate lives
// next to the bridge it reads (and is unit-tested there); this file is the composition
// root and has no test of its own.
const isElectron = isElectronRenderer();

bootstrapApplication(AppComponent, {
  providers: [
    // Zoneless change detection (no zone.js). The data-access services' matrix-js-sdk
    // event handlers write signals, which schedule change detection directly. See
    // docs/architecture/state-and-reactivity.md.
    provideZonelessChangeDetection(),
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
      withPreloading(PreloadAllModules),
      withRouterConfig({ canceledNavigationResolution: 'computed' }),
    ),
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
    // Load which system lines (joins, profile changes, room changes) the timeline shows,
    // before the first room is projected — otherwise a user who hid them would see the
    // churn flash in on every cold start.
    provideAppInitializer(() => inject(SystemLineSettingsService).init()),
    provideAppInitializer(() => inject(ComposerSettingsService).init()),
    // Load the saved date/time formats before the first timeline paints — every message
    // header carries a timestamp, so hydrating late would render the whole room in the
    // default format and then reflow it.
    provideAppInitializer(() => inject(DateTimeFormatService).init()),
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
    // Construct the per-space room ordering store so its hydrate effect is live for the
    // whole session, and read whatever accounts are already known. At this point the
    // persisted session usually has not been restored yet, so the effect — not this call —
    // does most of the work; it fires again as each account signs in.
    provideAppInitializer(() => inject(SpaceRoomOrderService).init()),
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
