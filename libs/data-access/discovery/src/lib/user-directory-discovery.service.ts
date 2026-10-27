import { Injectable, inject } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
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
  private readonly matrix = inject(MatrixClientService);

  search(term: string, limit = 30): Observable<UserDirectoryPage> {
    const trimmed = term.trim();
    if (!trimmed) {
      return of({ users: [], limited: false });
    }
    const accountId = this.matrix.activeUserId();
    if (!accountId) {
      return throwError(() => new EngineRequestError(NOT_SIGNED_IN));
    }
    return this.engine
      .searchUserDirectory(accountId, trimmed, limit)
      .pipe(unwrapEngineResult());
  }
}
