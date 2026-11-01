import { bootstrapApplication } from '@angular/platform-browser';
import { provideServiceWorker } from '@angular/service-worker';
import { seedSystemColourMode } from '@trinity/application/appearance';
import {
  ApplicationRootComponent,
  provideTrinityApplication,
  startApplicationRuntime,
} from '@trinity/application/runtime';
import {
  isElectronRenderer,
  isInstalledNativePlatform,
} from '@trinity/platform-native';
import { APPLICATION_DIALOG_LOADERS } from './app/application-dialog-loaders';
import { BUILD_INFO_VALUE } from './app/build-info';
import { RELEASE_NOTES_VALUE } from './app/release-notes';
import { routes } from './app/app.routes';
import { environment } from './environments/environment';

// The renderer artifact is shared unchanged by Web/PWA, Capacitor and Electron. Only the
// plain production Web host installs a service worker; native and desktop already load the
// same files from local storage and must not layer a second cache over them.
const serviceWorkerEnabled =
  environment.production &&
  !isInstalledNativePlatform() &&
  !isElectronRenderer();

seedSystemColourMode();

void bootstrapApplication(ApplicationRootComponent, {
  providers: [
    provideTrinityApplication({
      routes,
      pushConfig: environment.push,
      // matrix-js-sdk logs sync, crypto and request details at debug level; production
      // builds keep its warnings and errors only.
      matrixSdkLogLevel: environment.production ? 'warn' : 'debug',
      issueRepositoryUrl: environment.issueTracker?.repositoryUrl ?? null,
      buildInfo: BUILD_INFO_VALUE,
      releaseNotes: RELEASE_NOTES_VALUE,
      dialogLoaders: APPLICATION_DIALOG_LOADERS,
      // Element X parity: only debug builds may skip the new-device check.
      deviceConfirmation: { allowSkip: !environment.production },
    }),
    provideServiceWorker('ngsw-worker.js', {
      enabled: serviceWorkerEnabled,
      registrationStrategy: 'registerWhenStable:30000',
    }),
  ],
}).then(startApplicationRuntime);
