import { bootstrapApplication } from '@angular/platform-browser';
import { inject, provideAppInitializer } from '@angular/core';
import {
  RouteReuseStrategy,
  provideRouter,
  withPreloading,
  PreloadAllModules,
} from '@angular/router';
import {
  IonicRouteStrategy,
  provideIonicAngular,
} from '@ionic/angular/standalone';
import { provideServiceWorker } from '@angular/service-worker';
import { Capacitor } from '@capacitor/core';
import { AvatarService, PUSH_CONFIG, ThemeService } from '@trinity/core';
import {
  AVATAR_RESOLVER,
  ENCRYPTION_DIALOG_COMPONENTS,
  type EncryptionDialogLoaders,
} from '@trinity/ui';

import { routes } from './app/app.routes';
import { AppComponent } from './app/app.component';
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
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    // Move focus into the entering page during a route transition (before the
    // leaving page is `aria-hidden`/`ion-page-hidden`). Without this Ionic's focus
    // manager is a no-op, so a control activated by keyboard/click keeps DOM focus
    // inside the leaving page; recent Chromium (Electron) then blocks the aria-hidden
    // on that focused subtree and the IonRouterOutlet transition promise stalls —
    // a blank entering page + a dead router (ionic-framework#30240). Relocating focus
    // removes the focused-descendant condition for every transition (and improves a11y).
    provideIonicAngular({
      focusManagerPriority: ['content', 'heading', 'banner'],
      // Inject modal/popover `componentProps` via Angular's setInput() instead of
      // Object.assign. Without this, presenting a component with signal inputs (e.g.
      // DeviceVerificationPage/EncryptionUnlockPage `asModal = input()`) overwrites the
      // input GETTER with the raw value, so `this.asModal()` throws and the modal can't
      // dismiss. setInput sets the signal correctly.
      useSetInputAPI: true,
    }),
    provideRouter(routes, withPreloading(PreloadAllModules)),
    // Apply the saved light/dark preference before the first paint.
    provideAppInitializer(() => inject(ThemeService).init()),
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
