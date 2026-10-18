import { Injectable } from '@angular/core';
import { Capacitor, registerPlugin } from '@capacitor/core';
import { Observable, catchError, defer, from, map, of } from 'rxjs';

const PLUGIN_NAME = 'AppSettings';

interface AppSettingsPlugin {
  openAppSettings(): Promise<void>;
  openNotificationSettings(): Promise<void>;
  notificationPreviewSetting(): Promise<{ value: unknown }>;
}

/** iOS's Show Previews for Trinity; null where the host can't tell (Android, the web). */
export type NotificationPreviewSetting = 'always' | 'when-unlocked' | 'never';

const appSettings = registerPlugin<AppSettingsPlugin>(PLUGIN_NAME);

/** The host's answer, checked: anything but the three iOS values is unknown. */
function previewSettingOf(answer: unknown): NotificationPreviewSetting | null {
  const value =
    answer !== null && typeof answer === 'object'
      ? (answer as { value?: unknown }).value
      : undefined;
  switch (value) {
    case 'always':
      return 'always';
    case 'whenUnlocked':
      return 'when-unlocked';
    case 'never':
      return 'never';
    default:
      return null;
  }
}

/**
 * Opens Trinity's own page in the system settings, where a permission the user refused for
 * good (the camera, after "Don't allow") can be turned back on, and Trinity's notification
 * settings, which App lock's "Hide on the lock screen" follows. Backed by the local
 * `AppSettings` plugin in the iOS and Android hosts; unavailable everywhere else.
 */
@Injectable({ providedIn: 'root' })
export class AppSettingsService {
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

  /**
   * Cold; true once the system's notification settings were asked to open (iOS: Trinity's
   * page; Android: the Messages channel's, or Trinity's before that channel exists).
   */
  openNotificationSettings(): Observable<boolean> {
    return defer(() =>
      this.available
        ? from(appSettings.openNotificationSettings()).pipe(map(() => true))
        : of(false),
    ).pipe(catchError(() => of(false)));
  }

  /** Cold; iOS's Show Previews for Trinity, or null where it isn't known (Android). */
  previewSetting(): Observable<NotificationPreviewSetting | null> {
    return defer(() =>
      this.available
        ? from(appSettings.notificationPreviewSetting()).pipe(
            map(previewSettingOf),
          )
        : of(null),
    ).pipe(catchError(() => of(null)));
  }
}
