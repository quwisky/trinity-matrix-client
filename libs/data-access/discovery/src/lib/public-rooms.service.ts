import { Injectable, inject } from '@angular/core';
import { Observable, defer, from, map, throwError } from 'rxjs';
import { RoomType } from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';

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
  /** Whether this directory entry is a Space (`m.space`) rather than a normal room. */
  isSpace: boolean;
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
   * Fetch a page of the public directory. `term` filters by search text, `since`
   * paginates, and `spaces: true` restricts to Spaces (`room_type: m.space`) instead of
   * normal rooms. Cold — runs the query on subscribe.
   */
  search(
    accountId: string,
    opts: { term?: string; since?: string; spaces?: boolean } = {},
  ): Observable<PublicRoomsPage> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      const term = opts.term?.trim();
      const filter = {
        ...(term ? { generic_search_term: term } : {}),
        ...(opts.spaces ? { room_types: [RoomType.Space] } : {}),
      };
      return from(
        client.publicRooms({
          limit: PAGE_SIZE,
          ...(opts.since ? { since: opts.since } : {}),
          ...(Object.keys(filter).length ? { filter } : {}),
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
            isSpace: chunk.room_type === 'm.space',
          })),
          nextBatch: res.next_batch ?? null,
          total: res.total_room_count_estimate ?? null,
        })),
      );
    });
  }

  /** Join a room by ID or alias; resolves to the joined room's ID. Cold. */
  join(accountId: string, roomIdOrAlias: string): Observable<string> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(client.joinRoom(roomIdOrAlias)).pipe(
        map((room) => room.roomId),
      );
    });
  }
}
