import type { Observable } from 'rxjs';
import type { EngineResult } from '@trinity/util/matrix';
import type { RawImagePackStateEvent } from './image-pack-management.model';

/** Local (synced) copies of the requested account-data types; absent type → null. */
export type AccountDataSnapshot = Readonly<Record<string, unknown>>;

/** One room as the pack readers need it. */
export interface PackRoomSnapshot {
  readonly roomId: string;
  /** False when the account does not hold the room or is not joined. */
  readonly joined: boolean;
  /** The room's display name (`room.name`), or null when unknown. */
  readonly name: string | null;
  /** Whether the account is joined and may send `m.room.image_pack` here (power levels). */
  readonly canWritePack: boolean;
  /** Every `m.room.image_pack` and `im.ponies.room_emotes` state event, any state key. */
  readonly packEvents: readonly RawImagePackStateEvent[];
}

/** A pack room joined by {@link ExpressionEngine.joinPackRoom}, read from the server. */
export interface JoinedPackRoom {
  readonly roomId: string;
  /** `m.room.name` from the fetched state, else the local display name, or null. */
  readonly roomName: string | null;
  readonly events: readonly RawImagePackStateEvent[];
}

/**
 * Account data and image-pack room state for one account at a time. Subscriptions emit their
 * snapshot on subscribe, then a whole snapshot per change (the collections are small); an
 * account without a live client emits an empty snapshot. Commands emit once and complete; they
 * do not promise the local copy has caught up (sync is the authority). Commands fail
 * `account-not-live` without a live client, else `request-failed` (an `M_FORBIDDEN` as
 * `kind: 'permission'`).
 */
export interface ExpressionEngine {
  /** Subscription: snapshot, then a full snapshot on every change to one of `types`. */
  accountData(
    accountId: string,
    types: readonly string[],
  ): Observable<AccountDataSnapshot>;

  /** Command: the server's copy (null on M_NOT_FOUND), past the local store. */
  fetchAccountData(
    accountId: string,
    type: string,
  ): Observable<EngineResult<unknown | null>>;

  /** Command: raw write; keys such as `__proto__` in null-prototype maps survive. `too-large` on M_TOO_LARGE. */
  setAccountData(
    accountId: string,
    type: string,
    content: Readonly<Record<string, unknown>>,
  ): Observable<EngineResult<null>>;

  /** Subscription: one entry per id (in order), re-emitted on pack state, power, membership or name change. */
  packRooms(
    accountId: string,
    roomIds: readonly string[],
  ): Observable<readonly PackRoomSnapshot[]>;

  /** Command: server state `type`/`stateKey` content, null on M_NOT_FOUND. */
  fetchRoomState(
    accountId: string,
    roomId: string,
    type: string,
    stateKey: string,
  ): Observable<EngineResult<unknown | null>>;

  /** Command: `too-large` on M_TOO_LARGE, `kind: 'permission'` on M_FORBIDDEN. */
  setRoomState(
    accountId: string,
    roomId: string,
    type: string,
    stateKey: string,
    content: Readonly<Record<string, unknown>>,
  ): Observable<EngineResult<null>>;

  /** Command: resolve an alias, join unless joined, fetch the room's pack state from the server. */
  joinPackRoom(
    accountId: string,
    roomIdOrAlias: string,
  ): Observable<EngineResult<JoinedPackRoom>>;
}
