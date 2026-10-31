import type { Observable } from 'rxjs';
import type { EngineResult } from '@trinity/util/matrix';

export type JsonValue =
  string | number | boolean | null | readonly JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

/** A user's effective power; `'infinite'` for a privileged creator (room v12+, MSC4289). */
export type PowerLevel = number | 'infinite';
export type Membership = 'join' | 'invite' | 'knock' | 'leave' | 'ban';

export interface RoomCreatorInfo {
  readonly userId: string;
  /** Room-scoped, disambiguated display name; the user id when there is none. */
  readonly displayName: string;
}

export interface RoomCreateState {
  readonly sender: string | null;
  readonly originServerTs: number | null;
  readonly content: JsonObject;
}

/** The raw `content` of single-state-key events Room Administration reads; null when absent. */
export interface AdministeredRoomState {
  readonly create: RoomCreateState | null;
  readonly name: JsonObject | null;
  readonly topic: JsonObject | null;
  readonly avatar: JsonObject | null;
  readonly joinRules: JsonObject | null;
  readonly historyVisibility: JsonObject | null;
  readonly canonicalAlias: JsonObject | null;
  readonly encryption: JsonObject | null;
  readonly tombstone: JsonObject | null;
}

/** One room's current state as Room Administration reads it. */
export interface AdministeredRoom {
  readonly roomId: string;
  readonly ownUserId: string;
  /** null when the account's membership is none of {@link Membership}. */
  readonly ownMembership: Membership | null;
  readonly ownPower: PowerLevel;
  /** The raw `m.room.power_levels` content; null when the room has none (spec defaults apply). */
  readonly powerLevels: JsonObject | null;
  readonly isSpace: boolean;
  readonly state: AdministeredRoomState;
  /** `m.space.parent` state keys. */
  readonly spaceParents: readonly string[];
  /** The create sender (or legacy `creator`) first, then v12 `additional_creators`. */
  readonly creators: readonly RoomCreatorInfo[];
  /** From room state or the crypto store; `'unknown'` until the store answers, never guessed. */
  readonly encryption: 'encrypted' | 'unencrypted' | 'unknown';
}

export interface RoomMemberInfo {
  readonly userId: string;
  /** Room-scoped display name, disambiguated as js-sdk `RoomMember.name` does; the user id when none. */
  readonly displayName: string;
  readonly avatarMxc: string | null;
  readonly membership: Membership;
  /** The membership event's `reason` (ban, knock, kick); null when absent or blank. */
  readonly reason: string | null;
  readonly power: PowerLevel;
}

export interface RoomMembers {
  readonly roomId: string;
  /** False while lazily loaded members are still being fetched; true once that ends, even if it failed. */
  readonly complete: boolean;
  readonly members: readonly RoomMemberInfo[];
}

export type DirectoryVisibility = 'public' | 'private';

/** One current state event, for the read-only state viewer. */
export interface RawStateEvent {
  readonly type: string;
  readonly stateKey: string;
  /** The whole event as JSON (state events are not end-to-end encrypted). */
  readonly event: JsonObject;
}

/** One space this account has joined that links the room. */
export interface LinkingSpace {
  readonly spaceId: string;
  readonly name: string;
  /**
   * The space's `m.space.child` content for the room (an empty `via` means removed); null
   * when the space's state is not loaded and only the room's `m.space.parent` names it.
   */
  readonly childContent: JsonObject | null;
  readonly ownPower: PowerLevel;
  readonly powerLevels: JsonObject | null;
}

/**
 * Room state, members and raw state writes for Room Administration. Subscriptions emit
 * their snapshot first (synchronously in the js-sdk engine), then a whole value per
 * change, and `null` while the account is not live or does not know the room. Commands
 * are cold and emit one result; a write's effect arrives through `room()`/`members()`.
 */
export interface RoomAdministrationEngine {
  room(accountId: string, roomId: string): Observable<AdministeredRoom | null>;
  /** Asks the server for lazily loaded members once per subscription. */
  members(accountId: string, roomId: string): Observable<RoomMembers | null>;
  /**
   * Sends `content` as is, so unknown keys round-trip. Fails `account-not-live`,
   * `room-unavailable` when the account has not joined the room, or `request-failed`.
   */
  setState(
    accountId: string,
    roomId: string,
    type: string,
    stateKey: string,
    content: JsonObject,
  ): Observable<EngineResult<null>>;
  /**
   * Every current state event of the room, unsorted. Fails `account-not-live`,
   * `room-unavailable` when the account does not know the room, or `request-failed`.
   */
  stateEvents(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<readonly RawStateEvent[]>>;

  /**
   * One state event's content as the server holds it now; null when it has none. Fails
   * `account-not-live` or `request-failed`.
   */
  stateEvent(
    accountId: string,
    roomId: string,
    type: string,
    stateKey: string,
  ): Observable<EngineResult<JsonObject | null>>;

  // Server commands below fail `account-not-live`, else leave every other check to the
  // server: its refusal arrives as `request-failed` with the status and errcode.
  kick(
    accountId: string,
    roomId: string,
    userId: string,
    reason: string | null,
  ): Observable<EngineResult<null>>;
  ban(
    accountId: string,
    roomId: string,
    userId: string,
    reason: string | null,
  ): Observable<EngineResult<null>>;
  unban(
    accountId: string,
    roomId: string,
    userId: string,
  ): Observable<EngineResult<null>>;
  /** Reports an event to the account's server admins; js sends score -100, Rust sends no score. */
  reportEvent(
    accountId: string,
    roomId: string,
    eventId: string,
    reason: string,
  ): Observable<EngineResult<null>>;
  reportRoom(
    accountId: string,
    roomId: string,
    reason: string,
  ): Observable<EngineResult<null>>;
  reportUser(
    accountId: string,
    userId: string,
    reason: string,
  ): Observable<EngineResult<null>>;
  /** The room's aliases in the account's server directory. */
  localAliases(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<readonly string[]>>;
  publishAlias(
    accountId: string,
    roomId: string,
    alias: string,
  ): Observable<EngineResult<null>>;
  removeAlias(accountId: string, alias: string): Observable<EngineResult<null>>;
  /** Whether the room is listed in the account's server room directory. */
  directoryVisibility(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<DirectoryVisibility>>;
  setDirectoryVisibility(
    accountId: string,
    roomId: string,
    visibility: DirectoryVisibility,
  ): Observable<EngineResult<null>>;
  invite(
    accountId: string,
    roomId: string,
    userId: string,
  ): Observable<EngineResult<null>>;
  /**
   * Asks the server to replace the room with one of `version`; `additionalCreators` are
   * sent as given (v12+ targets only).
   */
  upgradeRoom(
    accountId: string,
    roomId: string,
    version: string,
    additionalCreators: readonly string[] | null,
  ): Observable<EngineResult<{ readonly replacementRoomId: string }>>;

  /**
   * Sends Megolm `m.room.encryption` and applies it on this device. Adopts the server's
   * event instead when sync missed it. Fails `account-not-live`, `room-unavailable` when
   * the account does not know the room, `already-encrypted` (state or crypto store; a
   * store that cannot answer counts as encrypted), `request-failed`, or
   * `encryption-not-applied` when the server has the event but this device could not
   * apply it.
   */
  enableEncryption(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<null>>;
  /**
   * Joined spaces whose state links the room, plus spaces only the room's parent events
   * name. Fails `account-not-live` or `room-unavailable`.
   */
  linkingSpaces(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<readonly LinkingSpace[]>>;
}
