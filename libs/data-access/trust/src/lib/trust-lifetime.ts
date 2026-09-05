import { Injectable, inject } from '@angular/core';
import { Observable, combineLatest, map } from 'rxjs';
import { TrustCryptoPort } from '@trinity/data-access/matrix-client';
import { ActiveAccountProjectionLifetime } from '@trinity/runtime/projection';
import { TrustService } from './trust.service';
import { TrustVerificationService } from './trust-verification.service';

/** Trust projections retained for one Application Runtime session. */
@Injectable({ providedIn: 'root' })
export class TrustLifetime {
  private readonly lifetime = inject(ActiveAccountProjectionLifetime);
  private readonly crypto = inject(TrustCryptoPort);
  private readonly health = inject(TrustService);
  private readonly verification = inject(TrustVerificationService);

  /** Attach on subscribe and release with the owning Application Runtime session. */
  run(): Observable<void> {
    return this.lifetime.run({
      activeAccountId: this.crypto.activeAccountId,
      runProjection: () =>
        combineLatest([
          this.health.runProjection(),
          this.verification.runProjection(),
        ]).pipe(map(() => void 0)),
      prepare: () => this.health.refresh(),
    });
  }
}
