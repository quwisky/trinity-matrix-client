import { Injectable, Injector, effect, inject } from '@angular/core';
import { Observable, defer, finalize } from 'rxjs';
import { IdentityMatrixPort } from '@trinity/data-access/matrix-client';
import { IdentityPresenceService } from './identity-presence.service';

/** Identity projections retained for one Application Runtime session. */
@Injectable({ providedIn: 'root' })
export class IdentityLifetime {
  private readonly injector = inject(Injector);
  private readonly matrix = inject(IdentityMatrixPort);
  private readonly presence = inject(IdentityPresenceService);

  /** Attach on subscribe, reattach after an empty Account set, and release on teardown. */
  run(): Observable<void> {
    return defer(() => {
      let accountId = this.matrix.activeAccountId();
      this.presence.connect();
      return new Observable<void>((subscriber) => {
        const accountChanges = effect(
          () => {
            const nextAccountId = this.matrix.activeAccountId();
            if (nextAccountId === accountId) return;
            accountId = nextAccountId;
            if (!nextAccountId) return;
            try {
              this.presence.connect();
            } catch (error: unknown) {
              subscriber.error(error);
            }
          },
          { injector: this.injector },
        );
        subscriber.next();
        return () => accountChanges.destroy();
      });
    }).pipe(finalize(() => this.presence.disconnect()));
  }
}
