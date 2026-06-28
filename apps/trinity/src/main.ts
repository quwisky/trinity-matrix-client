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
import { AVATAR_RESOLVER } from '@trinity/ui';

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
    provideIonicAngular(),
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
