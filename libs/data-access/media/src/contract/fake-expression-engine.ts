import {
  type Observable,
  Subject,
  defer,
  distinctUntilChanged,
  map,
  of,
  startWith,
} from 'rxjs';
import {
  type EngineFailure,
  type EngineResult,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import type {
  AccountDataSnapshot,
  ExpressionEngine,
  JoinedPackRoom,
  PackRoomSnapshot,
} from '../lib/expression-engine';
import {
  IMAGE_PACK_EVENT_TYPE,
  LEGACY_IMAGE_PACK_EVENT_TYPE,
} from '../lib/image-pack.model';
import type { RawImagePackStateEvent } from '../lib/image-pack-management.model';

interface FakeRoom {
  readonly name: string | null;
  readonly alias: string | null;
  /** Whether alice may send state here. */
  readonly writable: boolean;
  /** Whether a non-member may read its state. */
  readonly worldReadable: boolean;
  joined: boolean;
  /** Whether alice's client holds the room: true once she has joined, also after leaving. */
  known: boolean;
  readonly state: Map<string, RawImagePackStateEvent>;
}

const NOT_LIVE: EngineFailure = {
  kind: 'unexpected',
  code: 'account-not-live',
  diagnostic: { kind: 'unexpected' },
};

const FORBIDDEN: EngineFailure = {
  kind: 'permission',
  code: 'request-failed',
  diagnostic: { kind: 'permission', httpStatus: 403, errcode: 'M_FORBIDDEN' },
};

const UNKNOWN_ALIAS: EngineFailure = {
  kind: 'http',
  code: 'request-failed',
  diagnostic: { kind: 'http', httpStatus: 404, errcode: 'M_NOT_FOUND' },
};

const PACK_TYPES = new Set([
  IMAGE_PACK_EVENT_TYPE,
  LEGACY_IMAGE_PACK_EVENT_TYPE,
]);

/** Through JSON, as the wire does: plain data, and an own `__proto__` key survives. */
function wire<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** An in-memory {@link ExpressionEngine} with one live account, {@link alice}. */
export class FakeExpressionEngine implements ExpressionEngine {
  private readonly data = new Map<string, unknown>();
  private readonly rooms = new Map<string, FakeRoom>();
  private readonly changes = new Subject<void>();
  private nextRoom = 0;

  readonly alice = '@alice:fake';

  /** A room the fake knows; `joined` and `writable` describe alice there. */
  addRoom(
    options: {
      readonly name?: string;
      readonly alias?: string;
      readonly joined?: boolean;
      readonly writable?: boolean;
      readonly worldReadable?: boolean;
      readonly state?: readonly RawImagePackStateEvent[];
    } = {},
  ): string {
    const roomId = `!room${++this.nextRoom}:fake`;
    this.rooms.set(roomId, {
      name: options.name ?? null,
      alias: options.alias ?? null,
      writable: options.writable ?? true,
      worldReadable: options.worldReadable ?? false,
      joined: options.joined ?? true,
      known: options.joined ?? true,
      state: new Map(
        (options.state ?? []).map((event) => [
          stateKey(event.type, event.state_key),
          wire(event),
        ]),
      ),
    });
    this.changes.next();
    return roomId;
  }

  /** Alice leaves `roomId`; the fake keeps its state, as a client keeps a left room's. */
  leaveRoom(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.joined = false;
    this.changes.next();
  }

  accountData(
    accountId: string,
    types: readonly string[],
  ): Observable<AccountDataSnapshot> {
    return this.changes.pipe(
      startWith(undefined),
      map(() =>
        Object.fromEntries(
          types.map((type) => [
            type,
            accountId === this.alice ? wire(this.data.get(type) ?? null) : null,
          ]),
        ),
      ),
      distinctUntilChanged<AccountDataSnapshot>(plainEqual),
    );
  }

  fetchAccountData(
    accountId: string,
    type: string,
  ): Observable<EngineResult<unknown | null>> {
    return this.command(accountId, () =>
      engineOk(wire(this.data.get(type) ?? null)),
    );
  }

  setAccountData(
    accountId: string,
    type: string,
    content: Readonly<Record<string, unknown>>,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      this.data.set(type, wire(content));
      this.changes.next();
      return engineOk(null);
    });
  }

  packRooms(
    accountId: string,
    roomIds: readonly string[],
  ): Observable<readonly PackRoomSnapshot[]> {
    return this.changes.pipe(
      startWith(undefined),
      map(() =>
        roomIds.map((roomId) => {
          const room =
            accountId === this.alice ? this.rooms.get(roomId) : undefined;
          return {
            roomId,
            joined: room?.joined ?? false,
            name: room?.known ? room.name : null,
            canWritePack: !!room?.joined && room.writable,
            packEvents: room
              ? [...room.state.values()]
                  .filter((event) => PACK_TYPES.has(event.type))
                  .map(wire)
              : [],
          };
        }),
      ),
      distinctUntilChanged<readonly PackRoomSnapshot[]>(plainEqual),
    );
  }

  fetchRoomState(
    accountId: string,
    roomId: string,
    type: string,
    key: string,
  ): Observable<EngineResult<unknown | null>> {
    return this.command(accountId, () => {
      const room = this.rooms.get(roomId);
      if (!room?.joined && !room?.worldReadable) return engineFail(FORBIDDEN);
      return engineOk(
        wire(room.state.get(stateKey(type, key))?.content ?? null),
      );
    });
  }

  setRoomState(
    accountId: string,
    roomId: string,
    type: string,
    key: string,
    content: Readonly<Record<string, unknown>>,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      const room = this.rooms.get(roomId);
      if (!room?.joined || !room.writable) return engineFail(FORBIDDEN);
      room.state.set(stateKey(type, key), {
        type,
        state_key: key,
        content: wire(content),
      });
      this.changes.next();
      return engineOk(null);
    });
  }

  joinPackRoom(
    accountId: string,
    roomIdOrAlias: string,
  ): Observable<EngineResult<JoinedPackRoom>> {
    return this.command(accountId, () => {
      const entry = [...this.rooms].find(
        ([id, room]) => id === roomIdOrAlias || room.alias === roomIdOrAlias,
      );
      if (!entry) return engineFail(UNKNOWN_ALIAS);
      const [roomId, room] = entry;
      room.joined = true;
      room.known = true;
      this.changes.next();
      return engineOk({
        roomId,
        roomName: room.name,
        events: [...room.state.values()]
          .filter((event) => PACK_TYPES.has(event.type))
          .map(wire),
      });
    });
  }

  private command<T>(
    accountId: string,
    run: () => EngineResult<T>,
  ): Observable<EngineResult<T>> {
    return defer(() =>
      of(accountId === this.alice ? run() : engineFail(NOT_LIVE)),
    );
  }
}

function stateKey(type: string, key: string): string {
  return `${type.length}:${type}:${key}`;
}
