import { EventEmitter } from 'events';
import type { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  Direction,
  EventStatus,
  MatrixEvent,
  RoomEvent,
  type IEvent,
} from 'matrix-js-sdk';
import { NEVER } from 'rxjs';
import { expect, vi } from 'vitest';
import {
  JS_SDK_CLIENTS,
  SESSION_ENGINE,
} from '@trinity/data-access/matrix-client';
import {
  applyVectorDiffs,
  assertPlainData,
  type EngineResult,
} from '@trinity/util/matrix';
import { fakeClient, fakeEvent, fakeRoom } from '../timeline.spec-harness';
import type {
  EventTimelineItem,
  TimelineFocus,
  TimelineItem,
  TimelineUpdate,
} from '../timeline-engine';
import { JsSdkTimelineEngine } from './js-sdk-timeline-engine';

export const ME = '@me:hs';
export const ROOM = '!r:hs';
export const LIVE: TimelineFocus = { kind: 'live' };

export type FakeEvent = ReturnType<typeof fakeEvent> & Record<string, unknown>;

export interface Options {
  fullyRead?: string;
  token?: string | null;
  crypto?: unknown;
  roomMissing?: boolean;
  member?: (userId: string) => unknown;
}

/** A live timeline the adapter can tell apart from its replacement. */
export function liveTimeline(events: FakeEvent[], token: string | null) {
  const tokens = { [Direction.Backward]: token };
  return {
    getEvents: () => events,
    getPaginationToken: (direction: Direction) =>
      tokens[direction as Direction.Backward] ?? null,
    setPaginationToken: (value: string | null, direction: Direction) => {
      tokens[direction as Direction.Backward] = value;
    },
    getState: () => ({
      getStateEvents: () => null,
      setUnknownStateEvents: () => undefined,
    }),
  };
}

/** The harness room and client, emitting through real EventEmitters so listeners can be counted. */
export function world(events: FakeEvent[], options: Options = {}) {
  let timeline = liveTimeline(events, options.token ?? null);
  const base = fakeRoom(events, {}, false, [], options.fullyRead ?? null);
  const room = Object.assign(new EventEmitter(), base, {
    on: EventEmitter.prototype.on,
    off: EventEmitter.prototype.off,
    getLiveTimeline: () => timeline,
    findEventById: (id: string) =>
      timeline.getEvents().find((e) => e.getId() === id),
    getMember: options.member ?? base.getMember,
    getThread: vi.fn(() => undefined as unknown),
    partitionThreadedEvents: (mapped: FakeEvent[]) => [mapped, [], []],
    addEventsToTimeline: vi.fn((added: FakeEvent[], toStart: boolean) => {
      for (const event of added) {
        if (toStart) timeline.getEvents().unshift(event);
        else timeline.getEvents().push(event);
        room.emit(RoomEvent.Timeline, event, room, toStart, false);
      }
    }),
    relations: { ...base.relations, aggregateChildEvent: () => undefined },
  });
  let present = !options.roomMissing;
  const client = Object.assign(new EventEmitter(), fakeClient(base, []), {
    on: EventEmitter.prototype.on,
    off: EventEmitter.prototype.off,
    getRoom: (roomId: string) => (present && roomId === ROOM ? room : null),
    getCrypto: () => options.crypto,
    createMessagesRequest: vi.fn(),
    getEventMapper: () => (raw: FakeEvent) => raw,
    processAggregatedTimelineEvents: () => undefined,
    processThreadEvents: () => undefined,
    timestampToEvent: vi.fn(),
    fetchRoomEvent: vi.fn(),
    decryptEventIfNeeded: () => Promise.resolve(),
    sendReadReceipt: vi.fn(() => Promise.resolve({})),
    setRoomReadMarkers: vi.fn(() => Promise.resolve({})),
    sendTyping: vi.fn(() => Promise.resolve({})),
  });
  return {
    room,
    client,
    /** Replace the live timeline, as a gappy sync does. */
    replaceTimeline: (next: FakeEvent[]) => {
      timeline = liveTimeline(next, 'fresh');
    },
    arrive: () => {
      present = true;
      client.emit(ClientEvent.Room, room);
    },
  };
}

export function engineFor(
  client: unknown,
  providers: Provider[] = [],
): JsSdkTimelineEngine {
  TestBed.configureTestingModule({
    providers: [
      { provide: SESSION_ENGINE, useValue: { session: () => NEVER } },
      ...providers,
      {
        provide: JS_SDK_CLIENTS,
        useValue: {
          clientFor: (accountId: string) => (accountId === ME ? client : null),
        },
      },
    ],
  });
  return TestBed.inject(JsSdkTimelineEngine);
}

/** Every update a `timeline()` subscription gets, and its items as folded so far. */
export function watch(engine: JsSdkTimelineEngine, roomId = ROOM) {
  const updates: TimelineUpdate[] = [];
  let items: readonly TimelineItem[] = [];
  const subscription = engine.timeline(ME, roomId, LIVE).subscribe((update) => {
    expect(() => assertPlainData(update)).not.toThrow();
    updates.push(update);
    items =
      update.kind === 'items' ? applyVectorDiffs(items, update.diffs) : [];
  });
  return {
    updates,
    items: () => items,
    events: () =>
      items.filter((item): item is EventTimelineItem => item.kind === 'event'),
    last: () => updates[updates.length - 1],
    subscription,
  };
}

export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

export function failureCode<T>(result: EngineResult<T>): string | null {
  return result.ok ? null : result.failure.code;
}

export function msg(id: string, sender = '@alice:hs', extra: object = {}) {
  return Object.assign(fakeEvent({ id, sender, body: id }), extra) as FakeEvent;
}

export interface Send {
  readonly echo: MatrixEvent;
  readonly args: readonly unknown[];
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

/** {@link world} with a client that adds a real local echo per send, as the SDK does. */
export function sendingWorld(
  events: FakeEvent[] = [msg('$a')],
  options: Options = {},
) {
  const w = world(events, options);
  const { room, client } = w;
  const sends: Send[] = [];
  const echoes = new Map<string, MatrixEvent>();
  let txn = 0;
  const update = (echo: MatrixEvent, status: EventStatus | null) => {
    const oldId = echo.getId();
    echo.setStatus(status);
    room.emit(RoomEvent.LocalEchoUpdated, echo, room, oldId);
  };
  const send = (type: string, args: unknown[]) => {
    // The SDK's overloads: (roomId, [threadId,] [type,] content, txnId).
    const [, ...rest] = args;
    const content = rest.find(
      (arg) => typeof arg === 'object' && arg !== null,
    ) as Record<string, unknown>;
    const txnId = rest[rest.length - 1] as string;
    const echo = new MatrixEvent({
      type,
      content,
      sender: ME,
      room_id: args[0] as string,
      event_id: `~${ROOM}:${txnId}`,
      origin_server_ts: 1,
    });
    echo.setTxnId(txnId);
    echo.setStatus(EventStatus.SENDING);
    if (args[0] === ROOM) {
      echoes.set(txnId, echo);
      room
        .getLiveTimeline()
        .getEvents()
        .push(echo as unknown as FakeEvent);
      room.emit(RoomEvent.Timeline, echo, room, false, false);
    }
    return new Promise((resolve, reject) =>
      sends.push({ echo, args, resolve, reject }),
    );
  };
  Object.assign(room, {
    getEventForTxnId: (txnId: string) => echoes.get(txnId),
  });
  const sending = Object.assign(client, {
    makeTxnId: () => `txn-${++txn}`,
    sendMessage: vi.fn((...args: unknown[]) => send('m.room.message', args)),
    sendEvent: vi.fn((...args: unknown[]) =>
      send(
        args.find(
          (a, i) => i > 0 && typeof a === 'string' && !a.startsWith('$'),
        ) as string,
        args,
      ),
    ),
    redactEvent: vi.fn(() => Promise.resolve({ event_id: '$redaction' })),
    resendEvent: vi.fn((echo: MatrixEvent) => {
      update(echo, EventStatus.SENDING);
      return Promise.resolve({ event_id: '$resent' });
    }),
    cancelPendingEvent: vi.fn((echo: MatrixEvent) => {
      if (echo.status !== EventStatus.NOT_SENT) {
        throw new Error(`cannot cancel an event with status ${echo.status}`);
      }
      // As the SDK does, a cancelled echo leaves the timeline.
      const events = room.getLiveTimeline().getEvents();
      events.splice(events.indexOf(echo as unknown as FakeEvent), 1);
      update(echo, EventStatus.CANCELLED);
    }),
    getEventMapper: () => (raw: Partial<IEvent>) => new MatrixEvent(raw),
  });
  return {
    ...w,
    client: sending,
    sends,
    /** The server accepted send `index` as `eventId`. */
    confirm(index: number, eventId: string) {
      const { echo, resolve } = sends[index];
      echo.replaceLocalEventId(eventId);
      update(echo, EventStatus.SENT);
      resolve({ event_id: eventId });
    },
    /** Send `index` failed with `error`, leaving its echo unsent. */
    fail(index: number, error: Error) {
      const { echo, reject } = sends[index];
      echo.error = error as never;
      update(echo, EventStatus.NOT_SENT);
      reject(error);
    },
    update,
  };
}
