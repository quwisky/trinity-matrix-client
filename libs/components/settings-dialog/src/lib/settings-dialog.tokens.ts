import { InjectionToken, type Type } from '@angular/core';

/** App-level wiring that keeps the public presenter independent of feature-settings. */
export interface SettingsDialogConfig {
  readonly load: () => Promise<Type<unknown>>;
  readonly shouldPresentAsDialog: () => boolean;
}

export const SETTINGS_DIALOG_CONFIG = new InjectionToken<SettingsDialogConfig>(
  'SETTINGS_DIALOG_CONFIG',
);
