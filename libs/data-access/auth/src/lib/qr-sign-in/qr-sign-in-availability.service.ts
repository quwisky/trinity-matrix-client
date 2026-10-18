import { Injectable, inject } from '@angular/core';
import { Observable, catchError, defer, from, of, tap } from 'rxjs';
import { QrSignInAdapter } from './qr-sign-in.adapter';

/** Whether a homeserver can take part in QR sign-in (device-code grant plus MSC4108). */
@Injectable({ providedIn: 'root' })
export class QrSignInAvailability {
  private readonly adapter = inject(QrSignInAdapter);
  private readonly answers = new Map<string, boolean>();

  /** Cold. A true/false answer is cached per URL; an error answers false and is not cached. */
  supports(homeserverUrl: string): Observable<boolean> {
    return defer(() => {
      const cached = this.answers.get(homeserverUrl);
      if (cached !== undefined) return of(cached);
      return from(this.adapter.isAvailable(homeserverUrl)).pipe(
        tap((answer) => this.answers.set(homeserverUrl, answer)),
        catchError(() => of(false)),
      );
    });
  }
}
