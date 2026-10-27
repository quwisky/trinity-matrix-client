import { InjectionToken, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type { EngineResult } from '@trinity/util/matrix';
import { JsSdkDiscoveryEngine } from './js-sdk/js-sdk-discovery-engine';

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

export interface PublicRoomsQuery {
  readonly term?: string;
  readonly since?: string;
  /** Restrict to Spaces (`room_type: m.space`). */
  readonly spaces?: boolean;
  readonly limit: number;
}

export type RoomLinkMembership =
  'join' | 'invite' | 'knock' | 'ban' | 'leave' | 'unknown';

export type RoomLinkJoinRule =
  | 'public'
  | 'knock'
  | 'knock_restricted'
  | 'restricted'
  | 'invite'
  | 'private'
  | 'unknown';

/** What a room link resolves to, as the account sees the room. */
export interface RoomLinkPreviewData {
  readonly roomId: string;
  readonly canonicalAddress: string | null;
  readonly name: string;
  readonly topic: string | null;
  readonly avatarMxc: string | null;
  readonly memberCount: number | null;
  /** `null` when neither the summary nor local state says. */
  readonly encrypted: boolean | null;
  readonly joinRule: RoomLinkJoinRule;
  readonly membership: RoomLinkMembership;
  readonly isSpace: boolean;
  /** The servers to join or knock through, including those an alias resolved to. */
  readonly via: readonly string[];
  /** Whether the account is joined to a room a restricted join rule allows. */
  readonly restrictedEligible: boolean;
}

/** Every command is cold, emits once and completes; expected failures are values. */
export interface DiscoveryEngine {
  /** Resolve a bare server name (no `@user:`) to its client base URL, without a trailing slash. */
  discover(
    domain: string,
  ): Observable<
    EngineResult<{ readonly domain: string; readonly baseUrl: string }>
  >;
  searchPublicRooms(
    accountId: string,
    query: PublicRoomsQuery,
  ): Observable<EngineResult<PublicRoomsPage>>;
  joinRoom(
    accountId: string,
    roomIdOrAlias: string,
    via: readonly string[],
  ): Observable<EngineResult<{ readonly roomId: string }>>;
  /** Uses the account's own copy of a room it is in, invited to, knocking on or banned from. */
  previewRoom(
    accountId: string,
    roomIdOrAlias: string,
    via: readonly string[],
  ): Observable<EngineResult<RoomLinkPreviewData>>;
  knockRoom(
    accountId: string,
    roomIdOrAlias: string,
    via: readonly string[],
    reason: string | null,
  ): Observable<EngineResult<{ readonly roomId: string }>>;
  searchUserDirectory(
    accountId: string,
    term: string,
    limit: number,
  ): Observable<EngineResult<UserDirectoryPage>>;
}

export const DISCOVERY_ENGINE = new InjectionToken<DiscoveryEngine>(
  'DISCOVERY_ENGINE',
  { providedIn: 'root', factory: () => inject(JsSdkDiscoveryEngine) },
);
