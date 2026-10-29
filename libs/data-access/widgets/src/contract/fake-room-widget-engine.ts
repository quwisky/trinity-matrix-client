import {
  BehaviorSubject,
  type Observable,
  defer,
  distinctUntilChanged,
  map,
  of,
} from 'rxjs';
import {
  type EngineFailure,
  type EngineFailureCode,
  type EngineResult,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import type {
  RoomWidgetEngine,
  RoomWidgetSnapshot,
  RoomWidgetStateContent,
} from '../lib/room-widget-engine';
import type { RoomWidget } from '../lib/widget.model';
import { isCallWidgetType } from '../lib/widget-embed-policy';

type FailNextCode = Exclude<
  EngineFailureCode,
  'discovery-failed' | 'account-start-failed' | 'recovery-refused'
>;

interface FakeState {
  readonly eventId: string;
  readonly sender: string;
  readonly content: Readonly<Record<string, unknown>>;
}

interface FakeRoom {
  readonly members: Set<string>;
  readonly invited: Set<string>;
  readonly power: Map<string, number>;
  /** Widget state by state key, tombstones included. */
  readonly widgets: Map<string, FakeState>;
}

/** The power level `im.vector.modular.widgets` needs, as Synapse's default `state_default`. */
const WIDGET_LEVEL = 50;
const EMPTY: RoomWidgetSnapshot = {
  widgets: [],
  canManage: false,
  identity: null,
};

function failure(code: FailNextCode): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** An in-memory {@link RoomWidgetEngine} where alice is live and bob drives rooms. */
export class FakeRoomWidgetEngine implements RoomWidgetEngine {
  private readonly rooms = new Map<string, FakeRoom>();
  private readonly live = new Set<string>();
  private readonly changes$ = new BehaviorSubject<void>(undefined);
  private nextFailure: FailNextCode | null = null;
  private nextRoom = 0;
  private nextEvent = 0;

  readonly serverName = 'example.org';
  readonly alice = `@alice:${this.serverName}`;
  readonly bob = `@bob:${this.serverName}`;

  readonly asAlice = {
    join: async (roomId: string): Promise<void> => {
      const room = this.room(roomId);
      if (!room.invited.has(this.alice))
        throw new Error(`${this.alice} is not invited to ${roomId}`);
      room.members.add(this.alice);
      this.changed();
    },
    leave: async (roomId: string): Promise<void> => {
      this.room(roomId).members.delete(this.alice);
      this.changed();
    },
  };

  readonly asBob = {
    createRoom: async (_name: string): Promise<string> => {
      const roomId = `!fake-${++this.nextRoom}:${this.serverName}`;
      this.rooms.set(roomId, {
        members: new Set([this.bob]),
        invited: new Set(),
        power: new Map([[this.bob, 100]]),
        widgets: new Map(),
      });
      return roomId;
    },
    invite: async (roomId: string, userId: string): Promise<void> => {
      this.room(roomId).invited.add(userId);
    },
    setPowerLevel: async (
      roomId: string,
      userId: string,
      level: number,
    ): Promise<void> => {
      this.room(roomId).power.set(userId, level);
      this.changed();
    },
    putWidget: async (
      roomId: string,
      stateKey: string,
      content: Readonly<Record<string, unknown>>,
    ): Promise<string> => this.write(roomId, stateKey, this.bob, content),
  };

  constructor() {
    this.live.add(this.alice);
  }

  /** Bob's room with alice joined; `canManage` gives her power to manage widgets. */
  async joinedRoom(options: { readonly canManage: boolean }): Promise<string> {
    const roomId = await this.asBob.createRoom('room');
    if (options.canManage)
      await this.asBob.setPowerLevel(roomId, this.alice, 100);
    await this.asBob.invite(roomId, this.alice);
    await this.asAlice.join(roomId);
    return roomId;
  }

  /** Makes the next command answer `code`. */
  failNext(code: FailNextCode): void {
    this.nextFailure = code;
  }

  /** Ends or restores an account, as signing out and in again would. */
  setLive(accountId: string, live: boolean): void {
    if (live) this.live.add(accountId);
    else this.live.delete(accountId);
    this.changed();
  }

  roomWidgets(
    accountId: string,
    roomId: string,
  ): Observable<RoomWidgetSnapshot> {
    return this.changes$.pipe(
      map(() => this.snapshot(accountId, roomId)),
      distinctUntilChanged<RoomWidgetSnapshot>(plainEqual),
    );
  }

  putRoomWidget(
    accountId: string,
    roomId: string,
    content: RoomWidgetStateContent,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, roomId, (room) => {
      if (room.widgets.has(content.id)) return failure('state-key-taken');
      this.write(roomId, content.id, accountId, { ...content });
      return null;
    });
  }

  removeRoomWidget(
    accountId: string,
    roomId: string,
    widgetId: string,
    expectedEventId: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, roomId, (room) => {
      const current = room.widgets.get(widgetId);
      const type = current && this.widgetFrom(widgetId, current)?.type;
      if (!type || current.eventId !== expectedEventId) {
        return failure('conflict');
      }
      if (isCallWidgetType(type)) return failure('unsupported');
      this.write(roomId, widgetId, accountId, {});
      return null;
    });
  }

  private command(
    accountId: string,
    roomId: string,
    run: (room: FakeRoom) => EngineFailure | null,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const room = this.rooms.get(roomId);
      if (!this.live.has(accountId) || !room) {
        return of(engineFail(failure('not-signed-in')));
      }
      if (!this.canManage(room, accountId)) {
        return of(engineFail(failure('forbidden')));
      }
      const code = this.nextFailure;
      this.nextFailure = null;
      const failed = code ? failure(code) : run(room);
      return of(failed ? engineFail(failed) : engineOk(null));
    });
  }

  private snapshot(accountId: string, roomId: string): RoomWidgetSnapshot {
    if (!this.live.has(accountId)) return EMPTY;
    const room = this.rooms.get(roomId);
    const widgets: RoomWidget[] = [];
    for (const [stateKey, state] of room?.widgets ?? []) {
      const widget = this.widgetFrom(stateKey, state);
      if (widget) widgets.push(widget);
    }
    return {
      widgets,
      canManage: !!room && this.canManage(room, accountId),
      identity: {
        userId: accountId,
        displayName: accountId,
        avatarUrl: '',
        deviceId: 'FAKEDEVICE',
        homeserverUrl: `https://${this.serverName}`,
      },
    };
  }

  private widgetFrom(stateKey: string, state: FakeState): RoomWidget | null {
    const { content } = state;
    const type = text(content['type']);
    const rawUrl = text(content['url']) ? (content['url'] as string) : '';
    if (!type || !rawUrl) return null;
    const data = isRecord(content['data']) ? content['data'] : {};
    return {
      id: stateKey,
      name: text(content['name']) ?? text(data['title']) ?? 'Unnamed widget',
      type,
      rawUrl,
      data,
      creatorUserId: text(content['creatorUserId']) ?? state.sender,
      waitForIframeLoad: content['waitForIframeLoad'] !== false,
      sourceEventId: state.eventId,
    };
  }

  private canManage(room: FakeRoom, userId: string): boolean {
    return (
      room.members.has(userId) && (room.power.get(userId) ?? 0) >= WIDGET_LEVEL
    );
  }

  private write(
    roomId: string,
    stateKey: string,
    sender: string,
    content: Readonly<Record<string, unknown>>,
  ): string {
    const eventId = `$fake-${++this.nextEvent}`;
    this.room(roomId).widgets.set(stateKey, { eventId, sender, content });
    this.changed();
    return eventId;
  }

  private room(roomId: string): FakeRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Unknown room ${roomId}`);
    return room;
  }

  private changed(): void {
    this.changes$.next();
  }
}
