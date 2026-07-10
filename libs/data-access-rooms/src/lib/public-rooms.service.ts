import { Injectable, inject } from '@angular/core';
import { Observable, defer, from, map, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

/** A room from the public directory, projected for the browse UI. */
export interface PublicRoomSummary {
  roomId: string;
  /** Display name, falling back to the canonical alias, then the room ID. */
  name: string;
  topic: string | null;
  /** The room's canonical alias (`#room:server`), if it has one. */
  alias: string | null;
  avatarMxc: string | null;
  memberCount: number;
}

/** One page of directory results plus the token to fetch the next. */
export interface PublicRoomsPage {
  rooms: PublicRoomSummary[];
  /** Pagination token for the next page, or null when there are no more. */
  nextBatch: string | null;
  /** The homeserver's estimate of the total matching rooms, if given. */
  total: number | null;
}

/** How many directory entries to request per page. */
const PAGE_SIZE = 30;

/**
 * Browses and joins rooms from the homeserver's public room directory
 * (`publicRooms`). Reads are cold Observables (fire on subscribe) that project the
 * SDK's chunk shape into {@link PublicRoomSummary}; joining resolves to the joined
 * room's ID so the caller can select it.
 */
@Injectable({ providedIn: 'root' })
export class PublicRoomsService {
  private readonly matrix = inject(MatrixClientService);

  /**
   * Fetch a page of public rooms, optionally filtered by a search term and paginated
   * from a previous page's `nextBatch`. Cold — runs the query on subscribe.
   */
  search(
    opts: { term?: string; since?: string } = {},
  ): Observable<PublicRoomsPage> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      const term = opts.term?.trim();
      return from(
        this.matrix.instance.publicRooms({
          limit: PAGE_SIZE,
          ...(opts.since ? { since: opts.since } : {}),
          ...(term ? { filter: { generic_search_term: term } } : {}),
        }),
      ).pipe(
        map((res) => ({
          rooms: (res.chunk ?? []).map((chunk) => ({
            roomId: chunk.room_id,
            name: chunk.name || chunk.canonical_alias || chunk.room_id,
            topic: chunk.topic || null,
            alias: chunk.canonical_alias ?? null,
            avatarMxc: chunk.avatar_url ?? null,
            memberCount: chunk.num_joined_members ?? 0,
          })),
          nextBatch: res.next_batch ?? null,
          total: res.total_room_count_estimate ?? null,
        })),
      );
    });
  }

  /** Join a room by ID or alias; resolves to the joined room's ID. Cold. */
  join(roomIdOrAlias: string): Observable<string> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(this.matrix.instance.joinRoom(roomIdOrAlias)).pipe(
        map((room) => room.roomId),
      );
    });
  }
}
