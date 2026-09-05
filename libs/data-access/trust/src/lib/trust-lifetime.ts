import { Injectable, Injector, effect, inject } from '@angular/core';
import { Observable, defer, finalize } from 'rxjs';
import { TrustCryptoPort } from '@trinity/data-access/matrix-client';
import { TrustService } from './trust.service';
import { TrustVerificationService } from './trust-verification.service';

/** Trust projections retained for one Application Runtime session. */
@Injectable({ providedIn: 'root' })
export class TrustLifetime {
  private readonly injector = inject(Injector);
  private readonly crypto = inject(TrustCryptoPort);
  private readonly health = inject(TrustService);
  private readonly verification = inject(TrustVerificationService);

  /** Attach on subscribe, reattach after an empty Account set, and release on teardown. */
  run(): Observable<void> {
    return defer(() => {
      let accountId = this.crypto.activeAccountId();
      this.connect();
      return new Observable<void>((subscriber) => {
        const accountChanges = effect(
          () => {
            const nextAccountId = this.crypto.activeAccountId();
            if (nextAccountId === accountId) return;
            accountId = nextAccountId;
            if (!nextAccountId) return;
            try {
              this.connect();
            } catch (error: unknown) {
              subscriber.error(error);
            }
          },
          { injector: this.injector },
        );
        subscriber.next();
        return () => accountChanges.destroy();
      });
    }).pipe(finalize(() => this.disconnect()));
  }

  private connect(): void {
    this.health.connect();
    this.verification.connect();
  }

  private disconnect(): void {
    this.verification.disconnect();
    this.health.disconnect();
  }
}
