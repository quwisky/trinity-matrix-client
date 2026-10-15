import { InjectionToken } from '@angular/core';

/** Epoch milliseconds; replaced in tests. */
export const APP_LOCK_CLOCK = new InjectionToken<() => number>(
  'APP_LOCK_CLOCK',
  {
    providedIn: 'root',
    factory: () => Date.now,
  },
);
