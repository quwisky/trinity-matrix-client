import { Injectable, inject } from '@angular/core';
import { Observable, defer, of, throwError } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  EngineRequestError,
  NOT_SIGNED_IN,
  unwrapEngineResult,
} from '@trinity/util/matrix';
import { DISCOVERY_ENGINE, type UserDirectoryPage } from './discovery-engine';

/** Remote user-directory lookup owned by Discovery rather than Identity. */
@Injectable({ providedIn: 'root' })
export class UserDirectoryDiscoveryService {
  private readonly engine = inject(DISCOVERY_ENGINE);
  private readonly session = inject(SessionStateService);

  search(term: string, limit = 30): Observable<UserDirectoryPage> {
    const trimmed = term.trim();
    if (!trimmed) {
      return of({ users: [], limited: false });
    }
    return defer(() => {
      const accountId = this.session.activeAccountId();
      if (!accountId) {
        return throwError(() => new EngineRequestError(NOT_SIGNED_IN));
      }
      return this.engine
        .searchUserDirectory(accountId, trimmed, limit)
        .pipe(unwrapEngineResult());
    });
  }
}
