import { Capacitor } from '@capacitor/core';
import type { SettingsDialogConfig } from '@trinity/components/settings-dialog';

/** Web and Electron use the modal; installed Capacitor apps keep native history. */
export function shouldPresentSettingsAsDialog(): boolean {
  return !Capacitor.isNativePlatform();
}

export const SETTINGS_DIALOG_APP_CONFIG: SettingsDialogConfig = {
  load: () =>
    import('@trinity/feature/settings').then((m) => m.SettingsDialogComponent),
  shouldPresentAsDialog: shouldPresentSettingsAsDialog,
};
