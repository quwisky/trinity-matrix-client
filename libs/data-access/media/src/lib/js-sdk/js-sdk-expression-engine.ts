import { Injectable, inject } from '@angular/core';
import {
  ClientEvent,
  type MatrixClient,
  MatrixError,
  type MatrixEvent,
  Method,
  type Room,
  RoomEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
import {
  NEVER,
  Observable,
  catchError,
  concat,
  defer,
  distinctUntilChanged,
  from,
  map,
  of,
} from 'rxjs';
import { JS_SDK_CLIENTS, coalesce } from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  type EngineResult,
  engineFail,
  engineOk,
  liveRoomState,
  plainEqual,
} from '@trinity/util/matrix';
import type {
  AccountDataSnapshot,
  ExpressionEngine,
  JoinedPackRoom,
  PackRoomSnapshot,
} from '../expression-engine';
import type { RawImagePackStateEvent } from '../image-pack-management.model';
import {
  IMAGE_PACK_EVENT_TYPE,
  LEGACY_IMAGE_PACK_EVENT_TYPE,
} from '../image-pack.model';
import { tooLargeOrFailed } from './request-failure';

const PACK_TYPES: ReadonlySet<string> = new Set([
  IMAGE_PACK_EVENT_TYPE,
  LEGACY_IMAGE_PACK_EVENT_TYPE,
]);

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

async function nullWhenNotFound<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (error instanceof MatrixError && error.errcode === 'M_NOT_FOUND') {
      return null;
    }
    throw error;
  }
}

/** The SDK types account data and state by known event types; these are not among them. */
interface UntypedClient {
  getAccountData(type: string): MatrixEvent | undefined;
  setAccountDataRaw(type: string, content: object): Promise<unknown>;
  getStateEvent(
    roomId: string,
    type: string,
    stateKey: string,
  ): Promise<unknown>;
  sendStateEvent(
    roomId: string,
    type: string,
    content: object,
    stateKey: string,
  ): Promise<unknown>;
}

const untyped = (client: MatrixClient): UntypedClient =>
  client as unknown as UntypedClient;

/** {@link ExpressionEngine} over the live matrix-js-sdk clients of {@link JS_SDK_CLIENTS}. */
@Injectable({ providedIn: 'root' })
export class JsSdkExpressionEngine implements ExpressionEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);

  accountData(
    accountId: string,
    types: readonly string[],
  ): Observable<AccountDataSnapshot> {
    const watched = new Set(types);
    return this.follow(
      accountId,
      (client) =>
        Object.fromEntries(
          types.map((type) => [
            type,
            (client && untyped(client).getAccountData(type)?.getContent()) ??
              null,
          ]),
        ),
      (client, schedule) => {
        const onAccountData = (event: MatrixEvent): void => {
          if (watched.has(event.getType())) schedule();
        };
        client.on(ClientEvent.AccountData, onAccountData);
        return () => client.off(ClientEvent.AccountData, onAccountData);
      },
    );
  }

  fetchAccountData(
    accountId: string,
    type: string,
  ): Observable<EngineResult<unknown | null>> {
    // Past the local store: the SDK's getAccountData serves it after the first sync.
    return this.command(accountId, (client) =>
      nullWhenNotFound(
        client.http.authedRequest<unknown>(
          Method.Get,
          `/user/${encodeURIComponent(client.getUserId() ?? accountId)}/account_data/${encodeURIComponent(type)}`,
        ),
      ),
    );
  }

  setAccountData(
    accountId: string,
    type: string,
    content: Readonly<Record<string, unknown>>,
  ): Observable<EngineResult<null>> {
    // Raw: the SDK's setAccountData deep-compares and throws on null-prototype maps.
    return this.command(accountId, async (client) => {
      await untyped(client).setAccountDataRaw(type, content);
      return null;
    });
  }

  packRooms(
    accountId: string,
    roomIds: readonly string[],
  ): Observable<readonly PackRoomSnapshot[]> {
    const watched = new Set(roomIds);
    return this.follow(
      accountId,
      (client) => roomIds.map((roomId) => packRoomOf(client, roomId)),
      (client, schedule) => {
        const onRoom = (room: Room | undefined): void => {
          if (room && watched.has(room.roomId)) schedule();
        };
        const onState = (event: MatrixEvent): void => {
          if (watched.has(event.getRoomId() ?? '')) schedule();
        };
        client.on(ClientEvent.Room, onRoom);
        client.on(RoomEvent.MyMembership, onRoom);
        client.on(RoomEvent.Name, onRoom);
        client.on(RoomStateEvent.Events, onState);
        return () => {
          client.off(ClientEvent.Room, onRoom);
          client.off(RoomEvent.MyMembership, onRoom);
          client.off(RoomEvent.Name, onRoom);
          client.off(RoomStateEvent.Events, onState);
        };
      },
    );
  }

  fetchRoomState(
    accountId: string,
    roomId: string,
    type: string,
    stateKey: string,
  ): Observable<EngineResult<unknown | null>> {
    return this.command(accountId, (client) =>
      nullWhenNotFound(untyped(client).getStateEvent(roomId, type, stateKey)),
    );
  }

  setRoomState(
    accountId: string,
    roomId: string,
    type: string,
    stateKey: string,
    content: Readonly<Record<string, unknown>>,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, async (client) => {
      await untyped(client).sendStateEvent(roomId, type, content, stateKey);
      return null;
    });
  }

  joinPackRoom(
    accountId: string,
    roomIdOrAlias: string,
  ): Observable<EngineResult<JoinedPackRoom>> {
    return this.command(accountId, async (client) => {
      let roomId = roomIdOrAlias;
      let viaServers: string[] | undefined;
      if (roomIdOrAlias.startsWith('#')) {
        const resolved = await client.getRoomIdForAlias(roomIdOrAlias);
        roomId = resolved.room_id;
        viaServers = resolved.servers;
      }
      if (client.getRoom(roomId)?.getMyMembership() !== 'join') {
        await client.joinRoom(roomId, { viaServers });
      }
      const state = await client.roomState(roomId);
      const nameContent: unknown = state.find(
        (event) => event.type === 'm.room.name' && event.state_key === '',
      )?.content;
      const stateName =
        isRecord(nameContent) && typeof nameContent['name'] === 'string'
          ? nameContent['name']
          : '';
      return {
        roomId,
        roomName: stateName.trim()
          ? stateName
          : (client.getRoom(roomId)?.name ?? null),
        events: state
          .filter((event) => PACK_TYPES.has(event.type))
          .map(({ type, state_key, content }) => ({
            type,
            state_key,
            content,
          })),
      };
    });
  }

  /**
   * A snapshot on subscribe, then one per coalesced burst of `bind`'s changes, unchanged ones
   * dropped. Without a live client: `read(null)` and nothing more. A replaced client is not
   * followed; the caller subscribes again for the new one.
   */
  private follow<T>(
    accountId: string,
    read: (client: MatrixClient | null) => T,
    bind: (client: MatrixClient, schedule: () => void) => () => void,
  ): Observable<T> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of(read(null)), NEVER);
      return new Observable<T>((subscriber) => {
        const publish = (): void => {
          if (this.clients.clientFor(accountId) === client) {
            subscriber.next(read(client));
          }
        };
        const queued = coalesce(publish);
        const unbind = bind(client, () => queued.schedule());
        publish();
        return () => {
          queued.cancel();
          unbind();
        };
      }).pipe(distinctUntilChanged<T>(plainEqual));
    });
  }

  private command<T>(
    accountId: string,
    run: (client: MatrixClient) => Promise<T>,
  ): Observable<EngineResult<T>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(NOT_LIVE));
      return from(run(client)).pipe(
        map((value) => engineOk(value)),
        catchError((error: unknown) => of(engineFail(tooLargeOrFailed(error)))),
      );
    });
  }
}

function packRoomOf(
  client: MatrixClient | null,
  roomId: string,
): PackRoomSnapshot {
  const room = client?.getRoom(roomId) ?? null;
  const state = room ? liveRoomState(room) : undefined;
  const userId = client?.getUserId();
  const joined = room?.getMyMembership() === 'join';
  return {
    roomId,
    joined,
    name: room?.name ?? null,
    // A left or invited room keeps its old power levels; only a member may write.
    canWritePack:
      joined &&
      !!userId &&
      !!state?.maySendStateEvent(IMAGE_PACK_EVENT_TYPE, userId),
    packEvents: state
      ? [IMAGE_PACK_EVENT_TYPE, LEGACY_IMAGE_PACK_EVENT_TYPE].flatMap((type) =>
          state.getStateEvents(type).map((event): RawImagePackStateEvent => ({
            type,
            state_key: event.getStateKey() ?? '',
            content: event.getContent(),
          })),
        )
      : [],
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
