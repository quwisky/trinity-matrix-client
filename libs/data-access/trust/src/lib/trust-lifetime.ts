import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';
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
      connect: () => this.connect(),
      disconnect: () => this.disconnect(),
      prepare: () => this.health.refresh(),
    });
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
