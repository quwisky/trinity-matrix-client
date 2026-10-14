import {
  inject,
  makeEnvironmentProviders,
  provideAppInitializer,
  type EnvironmentProviders,
} from '@angular/core';
import { AppearanceEffects } from '@trinity/application/appearance';
import { AppLockService } from '@trinity/data-access/app-lock';
import {
  EMPTY,
  catchError,
  concat,
  defer,
  firstValueFrom,
  ignoreElements,
  timeout,
} from 'rxjs';

/**
 * How long a locked start waits for the saved Appearance (local reads) before the first
 * render, as the session-lock stage does: a stuck read must not hold the cover back.
 */
const SAVED_APPEARANCE_BUDGET_MS = 500;

/**
 * App lock's application wiring. The initializer holds the first render until the lock
 * state is known, so a locked app never paints a room, a dialog or the startup status first
 * (Review Focus 3). Hydration never errors and waits for the host at most
 * SUPPORT_TIMEOUT_MS. A locked start then puts the saved Appearance on the document, so the
 * cover paints in the person's theme instead of flashing light.
 */
export function appLockProviders(): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideAppInitializer(() => {
      const appLock = inject(AppLockService);
      const appearance = inject(AppearanceEffects);
      return firstValueFrom(
        concat(
          appLock.hydrate().pipe(ignoreElements()),
          defer(() =>
            appLock.status() === 'locked' ? appearance.applySaved() : EMPTY,
          ).pipe(
            timeout({ first: SAVED_APPEARANCE_BUDGET_MS, with: () => EMPTY }),
            ignoreElements(),
            catchError(() => EMPTY),
          ),
        ),
        { defaultValue: undefined },
      );
    }),
  ]);
}
