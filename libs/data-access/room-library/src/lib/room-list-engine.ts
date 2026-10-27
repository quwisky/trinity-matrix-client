import type { Observable } from 'rxjs';
import type {
  EngineResult,
  UnencryptedMark,
  VectorDiff,
} from '@trinity/util/matrix';

export type RoomMembership = 'join' | 'invite' | 'knock';

export interface RoomInfo {
  readonly roomId: string;
  readonly membership: RoomMembership;
  readonly isSpace: boolean;
  /** The room name, or the room id when unnamed. */
  readonly displayName: string;
  /** The avatar with a DM resolved to the other member's. */
  readonly avatarMxc: string | null;
  /** Empty when unset. */
  readonly topic: string;
  readonly joinedMemberCount: number;
  /** The other user of a direct message, from a reverse `m.direct` lookup. */
  readonly directUserId: string | null;
  readonly encryption: 'encrypted' | 'unencrypted' | 'unknown';
  readonly historyVisibility:
    'invited' | 'joined' | 'shared' | 'world_readable';
  readonly notificationCount: number;
  readonly highlightCount: number;
  readonly markedUnread: boolean;
  /** Last activity, thread replies included. */
  readonly recencyStamp: number;
  readonly latestMessage: {
    readonly text: string;
    readonly mark: UnencryptedMark | null;
  } | null;
  readonly favourite: boolean;
  readonly lowPriority: boolean;
  readonly inviter: {
    readonly userId: string;
    readonly displayName: string;
    readonly isDirect: boolean;
  } | null;
}

export interface TypingMember {
  readonly userId: string;
  readonly displayName: string;
}

export interface CreateRoomRequest {
  readonly name: string;
  readonly topic: string | null;
  readonly isPublic: boolean;
  /** A room is encrypted from its first event; a space is not. */
  readonly kind: 'room' | 'space';
  /** Links the new room into this space both ways: `m.space.child` and `m.space.parent`. */
  readonly parentSpaceId: string | null;
}

/** One `m.space.child` link. */
export interface SpaceChildLink {
  readonly childId: string;
  readonly via: readonly string[];
  readonly suggested: boolean;
  /** Empty when unset. */
  readonly order: string;
}

/** One room of a `/hierarchy` response, the space itself included. */
export interface HierarchyEntry {
  readonly roomId: string;
  readonly name: string | null;
  readonly canonicalAlias: string | null;
  readonly topic: string | null;
  readonly avatarMxc: string | null;
  readonly joinedMemberCount: number;
  readonly joinRule: string | null;
  readonly isSpace: boolean;
  /** The entry's own child links as the server reports them, tombstones included; `order` is the raw state value, not normalised like spaceChildLinks. */
  readonly childrenState: readonly SpaceChildLink[];
}

/** MSC4380 invite blocking, enforced by the homeserver. */
export interface InviteBlocking {
  /** False until the server has answered `/versions`, and when that fails. */
  readonly supported: boolean;
  /** Whether the server turns down every invite to the account; false while unsupported. */
  readonly blocked: boolean;
}

/**
 * `createRoom`, `createDirectMessage`, `join`, `leave` and `setTag` show their effect in
 * `rooms()`, `setSpaceChild` and `createRoom` with a parent in `spaceChildLinks()`, and
 * `setInviteBlocking` in `inviteBlocking()`, open subscriptions included, before they reply.
 * `setMarkedUnread` and `markRead` write account data, which shows once `/sync` returns it.
 * The js-sdk adapter emits synchronously on subscribe; other engines may not.
 * Every command on an account that is not live returns `account-not-live`.
 */
export interface RoomListEngine {
  rooms(accountId: string): Observable<readonly VectorDiff<RoomInfo>[]>;
  typing(
    accountId: string,
  ): Observable<Readonly<Record<string, readonly TypingMember[]>>>;
  directMap(
    accountId: string,
  ): Observable<Readonly<Record<string, readonly string[]>>>;
  setTag(
    accountId: string,
    roomId: string,
    tag: 'favourite' | 'lowPriority',
    on: boolean,
  ): Observable<EngineResult<null>>;
  setMarkedUnread(
    accountId: string,
    roomId: string,
    unread: boolean,
  ): Observable<EngineResult<null>>;
  markRead(
    accountId: string,
    roomId: string,
    receipts: 'public' | 'private',
  ): Observable<EngineResult<null>>;
  leave(accountId: string, roomId: string): Observable<EngineResult<null>>;
  createRoom(
    accountId: string,
    request: CreateRoomRequest,
  ): Observable<EngineResult<{ readonly roomId: string }>>;
  createDirectMessage(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<{ readonly roomId: string }>>;
  resolveAlias(
    accountId: string,
    alias: string,
  ): Observable<EngineResult<{ readonly roomId: string }>>;
  invite(
    accountId: string,
    roomId: string,
    userId: string,
  ): Observable<EngineResult<null>>;
  /** An empty `via` lets the homeserver route the join alone. */
  join(
    accountId: string,
    roomIdOrAlias: string,
    via: readonly string[],
  ): Observable<EngineResult<{ readonly roomId: string }>>;
  /**
   * The live child links of a space the account knows, in spec order. A link with an empty
   * `via` is a removed child and is left out; an order key the spec rejects reads as empty.
   */
  spaceChildLinks(
    accountId: string,
    spaceId: string,
  ): Observable<readonly SpaceChildLink[]>;
  /**
   * The space and its direct children, every page up to `maxPages` (`null`: no limit). A page
   * token the server repeats fails the request rather than looping.
   */
  spaceHierarchy(
    accountId: string,
    spaceId: string,
    options: { readonly maxPages: number | null },
  ): Observable<EngineResult<readonly HierarchyEntry[]>>;
  /** Writes the link as given, or removes it when `link` is null. */
  setSpaceChild(
    accountId: string,
    spaceId: string,
    childId: string,
    link: Omit<SpaceChildLink, 'childId'> | null,
  ): Observable<EngineResult<null>>;
  /** Writes a canonical `m.space.parent` on the child. */
  setSpaceParent(
    accountId: string,
    childId: string,
    spaceId: string,
    via: readonly string[],
  ): Observable<EngineResult<null>>;
  inviteBlocking(accountId: string): Observable<InviteBlocking>;
  /** Fails with `request-failed` where the server does not support invite blocking. */
  setInviteBlocking(
    accountId: string,
    blocked: boolean,
  ): Observable<EngineResult<null>>;
}
