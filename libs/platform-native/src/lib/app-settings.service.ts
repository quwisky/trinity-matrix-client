import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Observable, catchError, defer, from, map, of } from 'rxjs';

const PLUGIN_NAME = 'AppSettings';

interface AppSettingsPlugin {
  openAppSettings(): Promise<void>;
}

const appSettings = registerPlugin<AppSettingsPlugin>(PLUGIN_NAME);

/**
 * Opens Trinity's own page in the system settings, where a permission the user refused for
 * good (the camera, after "Don't allow") can be turned back on. Backed by the local
 * `AppSettings` plugin in the iOS and Android hosts; unavailable everywhere else.
 */
@Injectable({ providedIn: 'root' })
export class AppSettingsService {
  /** Whether this host can open its settings page. */
  readonly available =
    Capacitor.isNativePlatform() && Capacitor.isPluginAvailable(PLUGIN_NAME);

  /** Cold; true once the settings page was asked to open, false if it could not be. */
  openAppSettings(): Observable<boolean> {
    return defer(() =>
      this.available
        ? from(appSettings.openAppSettings()).pipe(map(() => true))
        : of(false),
    ).pipe(catchError(() => of(false)));
  }
}
