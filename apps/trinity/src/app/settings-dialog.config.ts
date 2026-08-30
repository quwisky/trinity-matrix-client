import { Capacitor } from '@capacitor/core';
import type { Type } from '@angular/core';
import { defer, map, type Observable } from 'rxjs';

export interface SettingsDialogConfig {
  readonly load: () => Observable<Type<unknown>>;
  readonly shouldPresentAsDialog: () => boolean;
}

/** Web and Electron use the modal; installed Capacitor apps keep native history. */
export function shouldPresentSettingsAsDialog(): boolean {
  return !Capacitor.isNativePlatform();
}

export const SETTINGS_DIALOG_APP_CONFIG: SettingsDialogConfig = {
  load: () =>
    defer(() => import('@trinity/feature/settings')).pipe(
      map((module) => module.SettingsDialogComponent),
    ),
  shouldPresentAsDialog: shouldPresentSettingsAsDialog,
};
