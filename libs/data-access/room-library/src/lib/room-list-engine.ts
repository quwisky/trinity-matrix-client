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
}

/**
 * `createRoom`, `createDirectMessage`, `leave` and `setTag` show their effect in `rooms()`,
 * open subscriptions included, before they reply. `setMarkedUnread` and `markRead` write
 * account data, which shows once `/sync` returns it.
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
}
