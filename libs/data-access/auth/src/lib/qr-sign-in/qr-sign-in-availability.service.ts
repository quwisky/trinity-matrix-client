import { Injectable, inject } from '@angular/core';
import {
  Observable,
  catchError,
  defer,
  of,
  shareReplay,
  throwError,
} from 'rxjs';
import { unwrapEngineResult } from '@trinity/util/matrix';
import { AUTH_ENGINE } from '../auth-engine.token';

/** Whether a homeserver can take part in QR sign-in (device-code grant plus MSC4108). */
@Injectable({ providedIn: 'root' })
export class QrSignInAvailability {
  private readonly engine = inject(AUTH_ENGINE);
  private readonly probes = new Map<string, Observable<boolean>>();

  /**
   * Cold. A true/false answer is cached per URL and concurrent subscribers share one probe;
   * an error answers false and is not cached.
   */
  supports(homeserverUrl: string): Observable<boolean> {
    return defer(() => {
      let probe = this.probes.get(homeserverUrl);
      if (!probe) {
        probe = this.engine.supportsQrRendezvous(homeserverUrl).pipe(
          unwrapEngineResult(),
          catchError((error: unknown) => {
            this.probes.delete(homeserverUrl);
            return throwError(() => error);
          }),
          shareReplay(1),
        );
        this.probes.set(homeserverUrl, probe);
      }
      return probe.pipe(catchError(() => of(false)));
    });
  }
}
