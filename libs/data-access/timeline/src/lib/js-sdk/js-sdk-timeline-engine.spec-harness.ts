import { EventEmitter } from 'events';
import type { Provider } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ClientEvent, Direction, RoomEvent } from 'matrix-js-sdk';
import { expect, vi } from 'vitest';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
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
