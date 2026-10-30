import {
  type EnvironmentProviders,
  Injectable,
  inject,
  provideEnvironmentInitializer,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { EMPTY, catchError, mergeMap } from 'rxjs';
import { SESSION_ENGINE } from './session-engine.token';
import { SessionStorageWrites } from './session-storage-writes';

/**
 * Feeds the bound engine's `storageEffects()` to the writer for the app's lifetime. Each effect's
 * writes are sent as it arrives, so storage's queue keeps them in emission order.
 */
@Injectable({ providedIn: 'root' })
export class SessionStorageEffects {
  constructor() {
    const writes = inject(SessionStorageWrites);
    inject(SESSION_ENGINE)
      .storageEffects()
      .pipe(
        mergeMap((effect) =>
          writes.apply(effect).pipe(
            catchError(() => {
              console.warn("Couldn't save the session.", effect.kind);
              return EMPTY;
            }),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe();
  }
}

/** Subscribes the writer when the environment starts, before any account can start: effects never replay. */
export function provideSessionStorageEffects(): EnvironmentProviders {
  return provideEnvironmentInitializer(() => inject(SessionStorageEffects));
}
