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
  RoomLinkPreviewData,
  UserDirectoryPage,
} from '../lib/discovery-engine';

const NOT_FOUND = {
  kind: 'http',
  code: 'request-failed',
  diagnostic: { kind: 'http', httpStatus: 404 },
} as const;

/** In-memory directory: signed-in accounts, public rooms, users and a domain table. */
export class FakeDiscoveryEngine implements DiscoveryEngine {
  readonly calls: string[] = [];
  readonly accounts = new Set<string>();
  readonly rooms: PublicRoomSummary[] = [];
  readonly users: DiscoveredUser[] = [];
  /** Rooms a link resolves to, found by room ID or canonical address. */
  readonly previews: RoomLinkPreviewData[] = [];
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
              code: 'discovery-failed',
              diagnostic: { kind: 'unexpected' },
              params: { domain },
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
    via: readonly string[],
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return defer(() => {
      this.calls.push(
        `joinRoom:${accountId}:${roomIdOrAlias}:${via.join(',')}`,
      );
      if (!this.accounts.has(accountId)) return of(engineFail(NOT_SIGNED_IN));
      const room = this.rooms.find(
        (r) => r.roomId === roomIdOrAlias || r.alias === roomIdOrAlias,
      );
      return of(
        room ? engineOk({ roomId: room.roomId }) : engineFail(NOT_FOUND),
      );
    });
  }

  previewRoom(
    accountId: string,
    roomIdOrAlias: string,
    via: readonly string[],
  ): Observable<EngineResult<RoomLinkPreviewData>> {
    return defer(() => {
      this.calls.push(`previewRoom:${accountId}:${roomIdOrAlias}`);
      if (!this.accounts.has(accountId)) return of(engineFail(NOT_SIGNED_IN));
      const preview = this.preview(roomIdOrAlias);
      if (!preview) return of(engineFail(NOT_FOUND));
      // An alias resolves through its own server, which joins the via list.
      const server = roomIdOrAlias.startsWith('#')
        ? [roomIdOrAlias.split(':').slice(1).join(':')]
        : [];
      return of(
        engineOk({ ...preview, via: [...new Set([...via, ...server])] }),
      );
    });
  }

  knockRoom(
    accountId: string,
    roomIdOrAlias: string,
    via: readonly string[],
    reason: string | null,
  ): Observable<EngineResult<{ readonly roomId: string }>> {
    return defer(() => {
      this.calls.push(
        `knockRoom:${accountId}:${roomIdOrAlias}:${via.join(',')}:${reason ?? ''}`,
      );
      if (!this.accounts.has(accountId)) return of(engineFail(NOT_SIGNED_IN));
      const preview = this.preview(roomIdOrAlias);
      if (!preview) return of(engineFail(NOT_FOUND));
      return of(
        preview.joinRule === 'knock' || preview.joinRule === 'knock_restricted'
          ? engineOk({ roomId: preview.roomId })
          : engineFail({
              kind: 'permission',
              code: 'request-failed',
              diagnostic: { kind: 'permission', httpStatus: 403 },
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

  private preview(roomIdOrAlias: string): RoomLinkPreviewData | undefined {
    return this.previews.find(
      (p) => p.roomId === roomIdOrAlias || p.canonicalAddress === roomIdOrAlias,
    );
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
