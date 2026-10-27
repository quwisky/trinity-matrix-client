import { type Observable, defer, of } from 'rxjs';
import {
  type EngineResult,
  NOT_SIGNED_IN,
  engineFail,
  engineOk,
} from '@trinity/util/matrix';
import type {
  DiscoveredUser,
  DiscoveryEngine,
  PublicRoomSummary,
  PublicRoomsPage,
  PublicRoomsQuery,
  UserDirectoryPage,
} from '../lib/discovery-engine';

/** In-memory directory: signed-in accounts, public rooms, users and a domain table. */
export class FakeDiscoveryEngine implements DiscoveryEngine {
  readonly calls: string[] = [];
  readonly accounts = new Set<string>();
  readonly rooms: PublicRoomSummary[] = [];
  readonly users: DiscoveredUser[] = [];
  /** Server name to client base URL. */
  readonly servers = new Map<string, string>();

  discover(
    domain: string,
  ): Observable<
    EngineResult<{ readonly domain: string; readonly baseUrl: string }>
  > {
    return defer(() => {
      this.calls.push(`discover:${domain}`);
      const baseUrl = this.servers.get(domain);
      return of(
        baseUrl === undefined
          ? engineFail({
              kind: 'unexpected',
              message: `Could not discover a homeserver for "${domain}".`,
              diagnostic: { kind: 'unexpected' },
            })
          : engineOk({ domain, baseUrl }),
      );
    });
  }

  searchPublicRooms(
    accountId: string,
    query: PublicRoomsQuery,
  ): Observable<EngineResult<PublicRoomsPage>> {
    return this.signedIn(accountId, `searchPublicRooms:${accountId}`, () => {
      const term = query.term?.trim().toLowerCase();
      return {
        rooms: this.rooms
          .filter((room) => !query.spaces || room.isSpace)
          .filter((room) => !term || room.name.toLowerCase().includes(term))
          .slice(0, query.limit),
        nextBatch: null,
        total: null,
      };
    });
  }

  joinRoom(
    accountId: string,
    roomIdOrAlias: string,
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return defer(() => {
      this.calls.push(`joinRoom:${accountId}:${roomIdOrAlias}`);
      if (!this.accounts.has(accountId)) return of(engineFail(NOT_SIGNED_IN));
      const room = this.rooms.find(
        (r) => r.roomId === roomIdOrAlias || r.alias === roomIdOrAlias,
      );
      return of(
        room
          ? engineOk({ roomId: room.roomId })
          : engineFail({
              kind: 'http',
              message: 'Something went wrong. Try again.',
              diagnostic: { kind: 'http', httpStatus: 404 },
            }),
      );
    });
  }

  searchUserDirectory(
    accountId: string,
    term: string,
    limit: number,
  ): Observable<EngineResult<UserDirectoryPage>> {
    return this.signedIn(accountId, `searchUserDirectory:${accountId}`, () => {
      const needle = term.toLowerCase();
      const matches = this.users.filter(
        (user) =>
          user.userId.toLowerCase().includes(needle) ||
          user.displayName.toLowerCase().includes(needle),
      );
      return {
        users: matches.slice(0, limit),
        limited: matches.length > limit,
      };
    });
  }

  private signedIn<T>(
    accountId: string,
    call: string,
    run: () => T,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      this.calls.push(call);
      return of(
        this.accounts.has(accountId)
          ? engineOk(run())
          : engineFail(NOT_SIGNED_IN),
      );
    });
  }
}
