import { bootstrapApplication } from '@angular/platform-browser';
import { provideServiceWorker } from '@angular/service-worker';
import { Capacitor } from '@capacitor/core';
import {
  ApplicationRootComponent,
  provideTrinityApplication,
  startApplicationRuntime,
} from '@trinity/application/runtime';
import { isElectronRenderer } from '@trinity/platform-native';
import { APPLICATION_DIALOG_LOADERS } from './app/application-dialog-loaders';
import { BUILD_INFO_VALUE } from './app/build-info';
import { routes } from './app/app.routes';
import { environment } from './environments/environment';

// The renderer artifact is shared unchanged by Web/PWA, Capacitor and Electron. Only the
// plain production Web host installs a service worker; native and desktop already load the
// same files from local storage and must not layer a second cache over them.
const serviceWorkerEnabled =
  environment.production &&
  !Capacitor.isNativePlatform() &&
  !isElectronRenderer();

void bootstrapApplication(ApplicationRootComponent, {
  providers: [
    provideTrinityApplication({
      routes,
      pushConfig: environment.push,
      buildInfo: BUILD_INFO_VALUE,
      dialogLoaders: APPLICATION_DIALOG_LOADERS,
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: serviceWorkerEnabled,
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
}).then(startApplicationRuntime);
