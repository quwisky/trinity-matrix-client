import { bootstrapApplication } from '@angular/platform-browser';
import {
  ErrorHandler,
  inject,
  provideAppInitializer,
  provideZoneChangeDetection,
} from '@angular/core';
import {
  provideRouter,
  withPreloading,
  PreloadAllModules,
} from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { Capacitor } from '@capacitor/core';
import {
  AvatarService,
  FeatureFlagsService,
  PUSH_CONFIG,
  ThemeService,
  TrinityErrorHandler,
} from '@trinity/core';
import {
  AVATAR_RESOLVER,
  ENCRYPTION_DIALOG_COMPONENTS,
  type EncryptionDialogLoaders,
} from '@trinity/ui';
import { provideSpartanHlm } from '@trinity/helm/utils';

import { routes } from './app/app.routes';
import { AppComponent } from './app/app.component';
import { NavigationFocusService } from './app/navigation-focus.service';
import { environment } from './environments/environment';

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
    provideZoneChangeDetection(),
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
    // Move focus into the entering page on each route change (replaces Ionic's
    // focus manager) — a11y for screen-reader/keyboard users.
    provideAppInitializer(() => inject(NavigationFocusService).init()),
    // Let <trn-avatar> resolve mxc avatars to authenticated blob URLs (core).
    {
      provide: AVATAR_RESOLVER,
      useFactory: () => {
        const avatars = inject(AvatarService);
        return (mxc: string | null, size: number) => avatars.resolve(mxc, size);
      },
    },
    // Push-gateway config for PushService (null = push disabled; see environment.ts).
    { provide: PUSH_CONFIG, useValue: environment.push },
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
