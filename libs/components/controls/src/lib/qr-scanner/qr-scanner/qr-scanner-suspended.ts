import { InjectionToken, type Signal } from '@angular/core';

/**
 * While true, such as behind App lock, every scanner closes its camera and cancels as it
 * does when the app is hidden. It never reopens on its own when this turns false.
 */
export const QR_SCANNER_SUSPENDED = new InjectionToken<Signal<boolean>>(
  'QR_SCANNER_SUSPENDED',
);
