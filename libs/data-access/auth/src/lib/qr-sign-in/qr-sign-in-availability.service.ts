import { Injectable, inject } from '@angular/core';
import {
  Observable,
  catchError,
  defer,
  from,
  of,
  shareReplay,
  throwError,
} from 'rxjs';
import { QrSignInAdapter } from './qr-sign-in.adapter';

/** Whether a homeserver can take part in QR sign-in (device-code grant plus MSC4108). */
@Injectable({ providedIn: 'root' })
export class QrSignInAvailability {
  private readonly adapter = inject(QrSignInAdapter);
  private readonly probes = new Map<string, Observable<boolean>>();

  /**
   * Cold. A true/false answer is cached per URL and concurrent subscribers share one probe;
   * an error answers false and is not cached.
   */
  supports(homeserverUrl: string): Observable<boolean> {
    return defer(() => {
      let probe = this.probes.get(homeserverUrl);
      if (!probe) {
        probe = from(this.adapter.isAvailable(homeserverUrl)).pipe(
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
