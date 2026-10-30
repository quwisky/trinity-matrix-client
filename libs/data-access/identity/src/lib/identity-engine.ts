import type { Observable } from 'rxjs';
import type { EngineResult, PresenceState } from '@trinity/util/matrix';

/** A user's public profile; a field is null when the user never set it. */
export interface UserProfile {
  readonly displayName: string | null;
  /** Raw `mxc://` URI. */
  readonly avatarMxc: string | null;
}

/** A user's presence as the account last received it. */
export interface PresenceInfo {
  readonly userId: string;
  readonly presence: PresenceState;
  /** Null when none is set. */
  readonly statusMessage: string | null;
  /** Epoch ms of the user's last activity, or null when the server did not say. */
  readonly lastActiveAt: number | null;
  readonly currentlyActive: boolean;
}

/** A user on the account's ignore list, with the profile the account knows (null when none). */
export interface IgnoredUserInfo {
  readonly userId: string;
  readonly displayName: string | null;
  readonly avatarMxc: string | null;
}

/**
 * Profiles, presence and the ignore list of an account. Commands emit once and complete;
 * without a live client they fail `account-not-live`, otherwise `request-failed` with the
 * failure's kind (`network` when the server was not reached). A subscription's first value
 * is the whole snapshot, not necessarily synchronous, and each change brings another; the
 * snapshot is empty while the account is not live. A subscription does not follow a
 * replaced client: subscribe again.
 */
export interface IdentityEngine {
  /** The account's own profile as its client knows it. */
  ownProfile(accountId: string): Observable<UserProfile>;

  /** Any user's profile from the server; a user it does not know has an empty one. */
  profile(
    accountId: string,
    userId: string,
  ): Observable<EngineResult<UserProfile>>;

  setDisplayName(
    accountId: string,
    name: string,
  ): Observable<EngineResult<null>>;

  /** Sets an already uploaded avatar. */
  setAvatar(accountId: string, mxc: string): Observable<EngineResult<null>>;

  /**
   * Every user whose presence the account has received, the account itself included once
   * the server sent it; a user never heard from is absent, not offline. Rust: the account's
   * own entry only.
   */
  presence(accountId: string): Observable<readonly PresenceInfo[]>;

  /** The account's own presence as last received; `presence` is null until the server sends one. */
  ownPresence(accountId: string): Observable<
    EngineResult<{
      readonly presence: PresenceState | null;
      readonly statusMessage: string | null;
    }>
  >;

  /** A null message clears it. */
  setPresence(
    accountId: string,
    presence: PresenceState,
    statusMessage: string | null,
  ): Observable<EngineResult<null>>;

  /** The account's `m.ignored_user_list`. */
  ignoredUsers(accountId: string): Observable<readonly IgnoredUserInfo[]>;

  /**
   * Adds `userId` to the ignore list or removes it; ignoring an ignored user, or unignoring
   * one that is not, changes nothing. Writes on one account run one after another, so
   * quick changes never undo each other.
   */
  setIgnored(
    accountId: string,
    userId: string,
    ignored: boolean,
  ): Observable<EngineResult<null>>;
}
