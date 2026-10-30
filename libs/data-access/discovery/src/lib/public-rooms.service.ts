import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { unwrapEngineResult } from '@trinity/util/matrix';
import {
  DISCOVERY_ENGINE,
  type PublicRoomsPage,
  type PublicRoomsQuery,
} from './discovery-engine';

/** How many directory entries to request per page. */
const PAGE_SIZE = 30;

/**
 * Browses and joins rooms from the homeserver's public room directory (`publicRooms`). Reads
 * are cold Observables; joining resolves to the joined room's ID.
 */
@Injectable({ providedIn: 'root' })
export class PublicRoomsService {
  private readonly engine = inject(DISCOVERY_ENGINE);

  /**
   * Fetch a page of the public directory. `term` filters by search text, `since` paginates,
   * and `spaces: true` restricts to Spaces (`room_type: m.space`). Cold.
   */
  search(
    accountId: string,
    opts: Omit<PublicRoomsQuery, 'limit'> = {},
  ): Observable<PublicRoomsPage> {
    const { term, since, spaces } = opts;
    // Plain data crosses the engine boundary: absent options are omitted, not undefined.
    const query: PublicRoomsQuery = {
      limit: PAGE_SIZE,
      ...(term !== undefined ? { term } : {}),
      ...(since !== undefined ? { since } : {}),
      ...(spaces !== undefined ? { spaces } : {}),
    };
    return this.engine
      .searchPublicRooms(accountId, query)
      .pipe(unwrapEngineResult());
  }

  /** Join a room by ID or alias; resolves to the joined room's ID. Cold. */
  join(accountId: string, roomIdOrAlias: string): Observable<string> {
    return this.engine.joinRoom(accountId, roomIdOrAlias, []).pipe(
      unwrapEngineResult(),
      map(({ roomId }) => roomId),
    );
  }
}
