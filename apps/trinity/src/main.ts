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
import { ThemeService } from '@trinity/core';

import { routes } from './app/app.routes';
import { AppComponent } from './app/app.component';
import { environment } from './environments/environment';

bootstrapApplication(AppComponent, {
  providers: [
    { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
    provideIonicAngular(),
    provideRouter(routes, withPreloading(PreloadAllModules)),
    // Apply the saved light/dark preference before the first paint.
    provideAppInitializer(() => inject(ThemeService).init()),
    // Precache the app shell + crypto WASM for offline (web/PWA only). Native
    // (Capacitor) and desktop (Electron) already load these as bundled assets and
    // must NOT layer a second SW cache over them — gate on web + production.
    provideServiceWorker('ngsw-worker.js', {
      enabled: environment.production && !Capacitor.isNativePlatform(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
});
