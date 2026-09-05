import { Injectable, inject, type Signal } from '@angular/core';
import { Observable } from 'rxjs';
import { IdentityMatrixPort } from '@trinity/data-access/matrix-client';
import { ActiveAccountProjectionLifetime } from '@trinity/runtime/projection';
import { IdentityPresenceService } from './identity-presence.service';

/** Identity projections retained for one Application Runtime session. */
@Injectable({ providedIn: 'root' })
export class IdentityLifetime {
  private readonly lifetime = inject(ActiveAccountProjectionLifetime);
  private readonly matrix = inject(IdentityMatrixPort);
  private readonly presence = inject(IdentityPresenceService);

  /** Retain presence only while Workspace has a Room surface that can display it. */
  run(demanded: Signal<boolean>): Observable<void> {
    return this.lifetime.run({
      activeAccountId: this.matrix.activeAccountId,
      demanded,
      runProjection: () => this.presence.runProjection(),
    });
  }
}
