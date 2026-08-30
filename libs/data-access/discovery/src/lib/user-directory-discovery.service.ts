import { Injectable, inject } from '@angular/core';
import { Observable, defer, from, map, of, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

/** Stable presentation data from the homeserver user directory. */
export interface DiscoveredUser {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarMxc: string | null;
}

/** A bounded directory response. Matrix exposes truncation, but no continuation token. */
export interface UserDirectoryPage {
  readonly users: readonly DiscoveredUser[];
  readonly limited: boolean;
}

/** Remote user-directory lookup owned by Discovery rather than Identity. */
@Injectable({ providedIn: 'root' })
export class UserDirectoryDiscoveryService {
  private readonly matrix = inject(MatrixClientService);

  search(term: string, limit = 30): Observable<UserDirectoryPage> {
    const trimmed = term.trim();
    if (!trimmed) {
      return of({ users: [], limited: false });
    }
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.matrix.instance.searchUserDirectory({ term: trimmed, limit }),
      ).pipe(
        map((response) => ({
          users: response.results.map((user) => ({
            userId: user.user_id,
            displayName: user.display_name || user.user_id,
            avatarMxc: user.avatar_url ?? null,
          })),
          limited: response.limited === true,
        })),
      );
    });
  }
}
