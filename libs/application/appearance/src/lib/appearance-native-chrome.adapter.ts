import { InjectionToken } from '@angular/core';
import type { Observable } from 'rxjs';
import type { NativeChromeAppearance } from './appearance-resolution';

/** Finite best-effort command implemented by the selected native host adapter. */
export interface AppearanceNativeChromeAdapter {
  apply(appearance: NativeChromeAppearance): Observable<void>;
}

export const APPEARANCE_NATIVE_CHROME_ADAPTER =
  new InjectionToken<AppearanceNativeChromeAdapter>(
    'APPEARANCE_NATIVE_CHROME_ADAPTER',
  );
