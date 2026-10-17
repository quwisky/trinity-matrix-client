import { InjectionToken } from '@angular/core';

export interface WhatsNewLauncher {
  showAll(): void;
}

export const WHATS_NEW_LAUNCHER = new InjectionToken<WhatsNewLauncher>(
  'WHATS_NEW_LAUNCHER',
);
