import { EventEmitter } from 'events';
import { TestBed } from '@angular/core/testing';
import {
  ClientEvent,
  Direction,
  MatrixError,
  MatrixEventEvent,
  ReceiptType,
  RoomEvent,
} from 'matrix-js-sdk';
import {
  CryptoEvent,
  EventShieldColour,
  EventShieldReason,
} from 'matrix-js-sdk/lib/crypto-api';
import { firstValueFrom, type Observable } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
import { TIMELINE_ENGINE } from '../timeline-engine.token';
import { profileName } from '../timeline-item-presentation';
import { JsSdkTimelineEngine } from './js-sdk-timeline-engine';

const ME = '@me:hs';
const ROOM = '!r:hs';
const LIVE: TimelineFocus = { kind: 'live' };

type FakeEvent = ReturnType<typeof fakeEvent> & Record<string, unknown>;

interface Options {
  fullyRead?: string;
  token?: string | null;
  crypto?: unknown;
  roomMissing?: boolean;
  member?: (userId: string) => unknown;
}

/** A live timeline the adapter can tell apart from its replacement. */
function liveTimeline(events: FakeEvent[], token: string | null) {
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
function world(events: FakeEvent[], options: Options = {}) {
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

function engineFor(client: unknown): JsSdkTimelineEngine {
  TestBed.configureTestingModule({
    providers: [
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
function watch(engine: JsSdkTimelineEngine, roomId = ROOM) {
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

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function failureCode<T>(result: EngineResult<T>): string | null {
  return result.ok ? null : result.failure.code;
}

function msg(id: string, sender = '@alice:hs', extra: object = {}) {
  return Object.assign(fakeEvent({ id, sender, body: id }), extra) as FakeEvent;
}

describe('JsSdkTimelineEngine', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('is the default TIMELINE_ENGINE', () => {
    const { client } = world([]);
    const engine = engineFor(client);
    expect(TestBed.inject(TIMELINE_ENGINE)).toBe(engine);
  });

  it('emits its snapshot synchronously on subscribe', () => {
    const { client } = world([msg('$a')]);
    const timeline = watch(engineFor(client));

    expect(timeline.updates).toHaveLength(1);
    expect(timeline.updates[0]).toMatchObject({
      kind: 'items',
      diffs: [{ op: 'reset' }],
      backPagination: 'start-reached',
      room: {
        encryption: 'unknown',
        hasEncryptionStateEvent: false,
        tombstone: null,
        latestConfirmedEventId: '$a',
        oldestEventId: '$a',
      },
    });
    expect(timeline.events().map((item) => item.eventId)).toEqual(['$a']);
    timeline.subscription.unsubscribe();
  });

  it('room-unavailable until ClientEvent.Room brings the room', () => {
    const { client, arrive } = world([msg('$a')], { roomMissing: true });
    const timeline = watch(engineFor(client));

    expect(timeline.updates).toEqual([{ kind: 'room-unavailable' }]);

    arrive();

    expect(timeline.updates).toHaveLength(2);
    expect(timeline.events().map((item) => item.eventId)).toEqual(['$a']);
    timeline.subscription.unsubscribe();
  });

  it('reuses the item object for an unchanged event across a reset', async () => {
    const events = [msg('$a')];
    const { client, room } = world(events);
    const timeline = watch(engineFor(client));
    const first = timeline.events()[0];

    const added = msg('$b');
    events.push(added);
    room.emit(RoomEvent.Timeline, added, room, false, false);
    await Promise.resolve();

    expect(timeline.updates).toHaveLength(2);
    expect(timeline.events()[0]).toBe(first);
    expect(timeline.events()[1].eventId).toBe('$b');
    timeline.subscription.unsubscribe();
  });

  it('uniqueId is txn-based for a local echo and survives the remote echo', async () => {
    const echo = msg('~!r:hs:txn1', ME, {
      getTxnId: () => 'txn1',
      status: 'sending',
    });
    const fields = { id: '~!r:hs:txn1' };
    echo.getId = () => fields.id;
    const { client, room } = world([echo]);
    const timeline = watch(engineFor(client));

    expect(timeline.events()[0]).toMatchObject({
      uniqueId: 'txn:txn1',
      eventId: null,
      transactionId: 'txn1',
      sendState: { kind: 'sending' },
    });

    fields.id = '$remote';
    echo['status'] = null;
    room.emit(RoomEvent.LocalEchoUpdated, echo, room, '~!r:hs:txn1');
    await Promise.resolve();

    expect(timeline.events()[0]).toMatchObject({
      uniqueId: 'txn:txn1',
      eventId: '$remote',
      sendState: null,
    });
    timeline.subscription.unsubscribe();
  });

  it('re-emits once per microtask for a burst of Receipt and Decrypted events', async () => {
    const event = msg('$a');
    const { client, room } = world([event]);
    const timeline = watch(engineFor(client));

    for (let i = 0; i < 5; i++) {
      room.emit(RoomEvent.Receipt, { getContent: () => ({ $a: {} }) }, room);
      client.emit(MatrixEventEvent.Decrypted, event);
    }
    expect(timeline.updates).toHaveLength(1);
    await Promise.resolve();

    expect(timeline.updates).toHaveLength(2);
    timeline.subscription.unsubscribe();
  });

  it('emits a second reset when shields resolve', async () => {
    const event = msg('$a', '@alice:hs', {
      isEncrypted: () => true,
      getClearContent: () => ({ body: '$a' }),
    });
    const crypto = {
      getEncryptionInfoForEvent: vi.fn(async () => ({
        shieldColour: EventShieldColour.RED,
        shieldReason: EventShieldReason.UNKNOWN_DEVICE,
      })),
      isEncryptionEnabledInRoom: async () => false,
    };
    const { client } = world([event], { crypto });
    const timeline = watch(engineFor(client));
    expect(timeline.events()[0].shield).toBeNull();

    await tick();

    expect(timeline.updates).toHaveLength(2);
    expect(timeline.events()[0].shield).toEqual({
      colour: 'red',
      reason: 'unknown-device',
    });
    timeline.subscription.unsubscribe();
  });

  it('hides thread replies in live focus', () => {
    const reply = msg('$reply', '@alice:hs', {
      threadRootId: '$root',
      isThreadRoot: false,
    });
    const root = msg('$root', '@alice:hs', {
      threadRootId: '$root',
      isThreadRoot: true,
    });
    const { client } = world([root, reply]);
    const timeline = watch(engineFor(client));

    expect(timeline.events().map((item) => item.eventId)).toEqual(['$root']);
    timeline.subscription.unsubscribe();
  });

  it('places readMarker before the first non-own displayable event after m.fully_read', () => {
    const { client } = world([msg('$a'), msg('$b', ME), msg('$c'), msg('$d')], {
      fullyRead: '$a',
    });
    const timeline = watch(engineFor(client));

    expect(
      timeline
        .items()
        .map((item) => (item.kind === 'event' ? item.eventId : item.kind)),
    ).toEqual(['timelineStart', '$a', '$b', 'readMarker', '$c', '$d']);
    timeline.subscription.unsubscribe();
  });

  it('emits readMarker once a page brings in the m.fully_read event', async () => {
    const { client } = world([msg('$b'), msg('$c')], {
      fullyRead: '$a',
      token: 't1',
    });
    client.createMessagesRequest.mockResolvedValue({
      chunk: [msg('$a')],
      end: 't2',
    });
    const engine = engineFor(client);
    const timeline = watch(engine);
    const kinds = () =>
      timeline
        .items()
        .map((item) => (item.kind === 'event' ? item.eventId : item.kind));
    expect(kinds()).toEqual(['$b', '$c']);

    await firstValueFrom(engine.paginateBackwards(ME, ROOM, LIVE, 10));

    expect(kinds()).toEqual(['$a', 'readMarker', '$b', '$c']);
    timeline.subscription.unsubscribe();
  });

  it('keeps readMarker where m.fully_read was at subscribe when it moves later', async () => {
    const { client, room } = world([msg('$a'), msg('$b'), msg('$c')], {
      fullyRead: '$a',
    });
    const timeline = watch(engineFor(client));
    room.getAccountData = (() => ({
      getContent: () => ({ event_id: '$b' }),
    })) as typeof room.getAccountData;

    room.addEventsToTimeline([msg('$d')], false);
    await Promise.resolve();

    expect(
      timeline
        .items()
        .map((item) => (item.kind === 'event' ? item.eventId : item.kind)),
    ).toEqual(['timelineStart', '$a', 'readMarker', '$b', '$c', '$d']);
    timeline.subscription.unsubscribe();
  });

  it('emits timelineStart only once the start of the room is reached', () => {
    const { client } = world([msg('$a')], { token: 'older' });
    const timeline = watch(engineFor(client));

    expect(timeline.items().map((item) => item.kind)).toEqual(['event']);
    expect(timeline.last()).toMatchObject({ backPagination: 'idle' });
    timeline.subscription.unsubscribe();
  });

  it('paginateBackwards emits its page with idle in one update, then replies', async () => {
    const { client } = world([msg('$b')], { token: 't1' });
    let respond: (value: unknown) => void = () => undefined;
    client.createMessagesRequest.mockReturnValue(
      new Promise((resolve) => (respond = resolve)),
    );
    const engine = engineFor(client);
    const timeline = watch(engine);
    const order: string[] = [];
    timeline.subscription.add(
      engine.timeline(ME, ROOM, LIVE).subscribe((update) => {
        if (update.kind === 'items') order.push(update.backPagination);
      }),
    );
    order.length = 0;

    const reply = firstValueFrom(
      engine.paginateBackwards(ME, ROOM, LIVE, 10),
    ).then((result) => {
      order.push('reply');
      return result;
    });
    expect(timeline.last()).toMatchObject({
      diffs: [],
      backPagination: 'paginating',
    });
    respond({ chunk: [msg('$a')], end: 't2' });

    await expect(reply).resolves.toEqual({
      ok: true,
      value: { startReached: false },
    });
    expect(order).toEqual(['paginating', 'idle', 'reply']);
    expect(client.createMessagesRequest).toHaveBeenCalledWith(
      ROOM,
      't1',
      10,
      Direction.Backward,
    );
    expect(timeline.last()).toMatchObject({ backPagination: 'idle' });
    expect(timeline.events().map((item) => item.eventId)).toEqual(['$a', '$b']);
    timeline.subscription.unsubscribe();
  });

  it('emits a live message while a page request is pending, and the page with idle after', async () => {
    const events = [msg('$b')];
    const { client, room } = world(events, { token: 't1' });
    let respond: (value: unknown) => void = () => undefined;
    client.createMessagesRequest.mockReturnValue(
      new Promise((resolve) => (respond = resolve)),
    );
    const engine = engineFor(client);
    const timeline = watch(engine);
    const replied: number[] = [];

    const reply = firstValueFrom(
      engine.paginateBackwards(ME, ROOM, LIVE, 10),
    ).then(() => replied.push(timeline.updates.length));
    const live = msg('$c');
    events.push(live);
    room.emit(RoomEvent.Timeline, live, room, false, false);
    await Promise.resolve();

    expect(timeline.last()).toMatchObject({ backPagination: 'paginating' });
    expect(timeline.events().map((item) => item.eventId)).toEqual(['$b', '$c']);
    const beforePage = timeline.updates.length;

    respond({ chunk: [msg('$a')], end: 't2' });
    await reply;

    const after = timeline.updates.slice(beforePage);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ backPagination: 'idle' });
    expect(replied).toEqual([timeline.updates.length]);
    expect(timeline.events().map((item) => item.eventId)).toEqual([
      '$a',
      '$b',
      '$c',
    ]);
    timeline.subscription.unsubscribe();
  });

  it('runs overlapping pages one at a time, each replying after its page is visible', async () => {
    const { client } = world([msg('$c')], { token: 't1' });
    const responders: ((value: unknown) => void)[] = [];
    client.createMessagesRequest.mockImplementation(
      () => new Promise((resolve) => responders.push(resolve)),
    );
    const engine = engineFor(client);
    const timeline = watch(engine);
    const seen: string[][] = [];
    const ids = () => timeline.events().map((item) => item.eventId ?? '');

    const first = firstValueFrom(
      engine.paginateBackwards(ME, ROOM, LIVE, 10),
    ).then(() => seen.push(ids()));
    const second = firstValueFrom(
      engine.paginateBackwards(ME, ROOM, LIVE, 10),
    ).then(() => seen.push(ids()));
    await tick();
    expect(client.createMessagesRequest).toHaveBeenCalledTimes(1);

    responders[0]({ chunk: [msg('$b')], end: 't2' });
    await first;
    expect(seen).toEqual([['$b', '$c']]);
    await tick();
    expect(client.createMessagesRequest).toHaveBeenLastCalledWith(
      ROOM,
      't2',
      10,
      Direction.Backward,
    );
    responders[1]({ chunk: [msg('$a')], end: 't3' });
    await second;

    expect(seen).toEqual([
      ['$b', '$c'],
      ['$a', '$b', '$c'],
    ]);
    expect(timeline.last()).toMatchObject({ backPagination: 'idle' });
    const pageUpdates = timeline.updates.filter(
      (update) => update.kind === 'items' && update.diffs.length > 0,
    );
    expect(
      pageUpdates.every(
        (update) =>
          update.kind === 'items' && update.backPagination !== 'paginating',
      ),
    ).toBe(true);
    timeline.subscription.unsubscribe();
  });

  it('a decryption changes only the decrypted item; the others stay the same object', async () => {
    const content = { body: 'sealed', msgtype: 'm.text' };
    const sealed = msg('$b', '@alice:hs', { getRoomId: () => ROOM });
    sealed.getOriginalContent = () => content;
    sealed.getContent = () => content;
    const { client } = world([msg('$a'), sealed, msg('$c')]);
    const timeline = watch(engineFor(client));
    const [a, b, c] = timeline.events();

    content.body = 'opened';
    Object.assign(sealed, {
      getOriginalContent: () => ({ ...content }),
      getContent: () => ({ ...content }),
    });
    client.emit(MatrixEventEvent.Decrypted, sealed);
    await Promise.resolve();

    const [a2, b2, c2] = timeline.events();
    expect(a2).toBe(a);
    expect(c2).toBe(c);
    expect(b2).not.toBe(b);
    expect(b2.content).toMatchObject({ body: 'opened' });
    timeline.subscription.unsubscribe();
  });

  it("emits a live message during paginateUntil's second page request", async () => {
    const events = [msg('$c')];
    const { client, room } = world(events, { token: 't1' });
    const responders: ((value: unknown) => void)[] = [];
    client.createMessagesRequest.mockImplementation(
      () => new Promise((resolve) => responders.push(resolve)),
    );
    const engine = engineFor(client);
    const timeline = watch(engine);
    const replied: number[] = [];

    const reply = firstValueFrom(engine.paginateUntil(ME, ROOM, '$a', 5)).then(
      (result) => {
        replied.push(timeline.updates.length);
        return result;
      },
    );
    await tick();
    responders[0]({ chunk: [msg('$b')], end: 't2' });
    await tick();
    expect(responders).toHaveLength(2);
    const live = msg('$d');
    events.push(live);
    room.emit(RoomEvent.Timeline, live, room, false, false);
    await Promise.resolve();

    expect(timeline.last()).toMatchObject({ backPagination: 'paginating' });
    expect(timeline.events().map((item) => item.eventId)).toEqual([
      '$b',
      '$c',
      '$d',
    ]);
    const beforePage = timeline.updates.length;

    responders[1]({ chunk: [msg('$a')], end: 't3' });

    await expect(reply).resolves.toEqual({ ok: true, value: { found: true } });
    const after = timeline.updates.slice(beforePage);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ backPagination: 'idle' });
    expect(replied).toEqual([timeline.updates.length]);
    expect(timeline.events().map((item) => item.eventId)).toEqual([
      '$a',
      '$b',
      '$c',
      '$d',
    ]);
    timeline.subscription.unsubscribe();
  });

  it('skips a queued paginateBackwards unsubscribed before its turn', async () => {
    const { client } = world([msg('$c')], { token: 't1' });
    const responders: ((value: unknown) => void)[] = [];
    client.createMessagesRequest.mockImplementation(
      () => new Promise((resolve) => responders.push(resolve)),
    );
    const engine = engineFor(client);
    const timeline = watch(engine);

    const first = firstValueFrom(engine.paginateBackwards(ME, ROOM, LIVE, 10));
    const queued = engine
      .paginateBackwards(ME, ROOM, LIVE, 10)
      .subscribe(() => undefined);
    queued.unsubscribe();
    responders[0]({ chunk: [msg('$b')], end: 't2' });
    await first;
    await tick();

    expect(client.createMessagesRequest).toHaveBeenCalledTimes(1);
    expect(timeline.last()).toMatchObject({ backPagination: 'idle' });
    // The skipped page never shows as paging: one start and one end, for the first page.
    expect(
      timeline.updates.map(
        (update) => update.kind === 'items' && update.backPagination,
      ),
    ).toEqual(['idle', 'paginating', 'idle']);
    timeline.subscription.unsubscribe();
  });

  it('asks the crypto store once, not on every update with nothing to check', async () => {
    const isEncryptionEnabledInRoom = vi.fn(async () => false);
    const crypto = {
      getEncryptionInfoForEvent: vi.fn(async () => null),
      isEncryptionEnabledInRoom,
    };
    const event = msg('$a');
    const { client, room } = world([event], { crypto });
    const timeline = watch(engineFor(client));
    await tick();

    for (let i = 0; i < 3; i++) {
      room.emit(RoomEvent.Receipt, { getContent: () => ({ $a: {} }) }, room);
      await tick();
    }

    expect(timeline.updates.length).toBeGreaterThan(3);
    expect(isEncryptionEnabledInRoom).toHaveBeenCalledOnce();
    timeline.subscription.unsubscribe();
  });

  it('re-projects when the live timeline is reset', async () => {
    const { client, room, replaceTimeline } = world([msg('$a')]);
    const timeline = watch(engineFor(client));

    replaceTimeline([]);
    room.emit(RoomEvent.TimelineReset, room);
    await Promise.resolve();

    expect(timeline.events()).toEqual([]);
    timeline.subscription.unsubscribe();
  });

  it('drops a page when the live timeline was replaced', async () => {
    const { client, room, replaceTimeline } = world([msg('$b')], {
      token: 't1',
    });
    client.createMessagesRequest.mockImplementation(async () => {
      replaceTimeline([msg('$c')]);
      return { chunk: [msg('$a')], end: 't2' };
    });
    const engine = engineFor(client);
    const timeline = watch(engine);

    const result = await firstValueFrom(
      engine.paginateBackwards(ME, ROOM, LIVE, 10),
    );

    expect(result.ok).toBe(true);
    expect(room.addEventsToTimeline).not.toHaveBeenCalled();
    expect(timeline.events().map((item) => item.eventId)).toEqual(['$c']);
    timeline.subscription.unsubscribe();
  });

  it('unsubscribing a paginate stops after the page in flight', async () => {
    const { client } = world([msg('$b')], { token: 't1' });
    let respond: (value: unknown) => void = () => undefined;
    client.createMessagesRequest.mockImplementation(
      () => new Promise((resolve) => (respond = resolve)),
    );
    const engine = engineFor(client);
    const timeline = watch(engine);

    const paging = engine
      .paginateUntil(ME, ROOM, '$far', 5)
      .subscribe(() => undefined);
    await tick();
    paging.unsubscribe();
    respond({ chunk: [msg('$a')], end: 't2' });
    await tick();

    expect(client.createMessagesRequest).toHaveBeenCalledTimes(1);
    expect(timeline.last()).toMatchObject({ backPagination: 'idle' });
    expect(timeline.events().map((item) => item.eventId)).toEqual(['$a', '$b']);
    timeline.subscription.unsubscribe();
  });

  it('paginateUntil with an unknown event only inspects loaded events', async () => {
    const { client } = world([msg('$a')]);
    const engine = engineFor(client);

    await expect(
      firstValueFrom(engine.paginateUntil(ME, ROOM, '$missing', 3)),
    ).resolves.toEqual({ ok: true, value: { found: false } });
    await expect(
      firstValueFrom(engine.paginateUntil(ME, ROOM, '$a', 3)),
    ).resolves.toEqual({ ok: true, value: { found: true } });
    expect(client.createMessagesRequest).not.toHaveBeenCalled();
    expect(client.fetchRoomEvent).not.toHaveBeenCalled();
  });

  it('eventAt maps M_UNRECOGNIZED to unsupported', async () => {
    const { client } = world([]);
    const engine = engineFor(client);
    client.timestampToEvent.mockRejectedValueOnce(
      new MatrixError({ errcode: 'M_UNRECOGNIZED' }, 404),
    );

    const result = await firstValueFrom(engine.eventAt(ME, ROOM, 5));

    expect(failureCode(result)).toBe('unsupported');
    expect(client.timestampToEvent).toHaveBeenCalledWith(
      ROOM,
      5,
      Direction.Forward,
    );
  });

  it('eventAt answers null when the room has no event then, else the event id', async () => {
    const { client } = world([]);
    const engine = engineFor(client);
    client.timestampToEvent
      .mockRejectedValueOnce(new MatrixError({ errcode: 'M_NOT_FOUND' }, 404))
      .mockResolvedValueOnce({ event_id: '$then', origin_server_ts: 5 });

    await expect(firstValueFrom(engine.eventAt(ME, ROOM, 5))).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(firstValueFrom(engine.eventAt(ME, ROOM, 5))).resolves.toEqual({
      ok: true,
      value: { eventId: '$then' },
    });
  });

  it('eventSource returns a loaded event as plain JSON and maps a 404 to message-unavailable', async () => {
    const event = msg('$a', '@alice:hs', {
      getEffectiveEvent: () => ({
        event_id: '$a',
        content: { body: 'a' },
        unsigned: undefined,
      }),
    });
    const { client } = world([event]);
    const engine = engineFor(client);
    client.fetchRoomEvent.mockRejectedValueOnce(
      new MatrixError({ errcode: 'M_NOT_FOUND' }, 404),
    );

    const loaded = await firstValueFrom(engine.eventSource(ME, ROOM, '$a'));
    expect(loaded).toEqual({
      ok: true,
      value: { event_id: '$a', content: { body: 'a' } },
    });
    expect(() => assertPlainData(loaded)).not.toThrow();
    const missing = await firstValueFrom(
      engine.eventSource(ME, ROOM, '$unknown'),
    );
    expect(failureCode(missing)).toBe('message-unavailable');
  });

  it('sendReceipt private with fullyRead sends ReadPrivate and setRoomReadMarkers', async () => {
    const event = msg('$a');
    const { client } = world([event]);
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.sendReceipt(ME, ROOM, '$a', {
        threadRootId: null,
        visibility: 'private',
        fullyRead: true,
      }),
    );

    expect(result).toEqual({ ok: true, value: null });
    expect(client.sendReadReceipt).toHaveBeenCalledWith(
      event,
      ReceiptType.ReadPrivate,
    );
    expect(client.setRoomReadMarkers).toHaveBeenCalledWith(ROOM, '$a');
  });

  it('sendReceipt with threadRootId sends a threaded receipt and no read marker', async () => {
    const { client, room } = world([msg('$root')]);
    const reply = msg('$reply', '@alice:hs', { threadRootId: '$root' });
    room.getThread.mockReturnValue({ events: [reply] });
    const engine = engineFor(client);

    const result = await firstValueFrom(
      engine.sendReceipt(ME, ROOM, '$reply', {
        threadRootId: '$root',
        visibility: 'public',
        fullyRead: true,
      }),
    );

    expect(result).toEqual({ ok: true, value: null });
    expect(room.getThread).toHaveBeenCalledWith('$root');
    expect(client.sendReadReceipt).toHaveBeenCalledWith(
      reply,
      ReceiptType.Read,
    );
    expect(client.setRoomReadMarkers).not.toHaveBeenCalled();
  });

  it('setTyping sends the typing flag with its timeout', async () => {
    const { client } = world([]);
    const engine = engineFor(client);

    await firstValueFrom(engine.setTyping(ME, ROOM, true));
    await firstValueFrom(engine.setTyping(ME, ROOM, false));

    expect(client.sendTyping).toHaveBeenNthCalledWith(1, ROOM, true, 8000);
    expect(client.sendTyping).toHaveBeenNthCalledWith(2, ROOM, false, 0);
  });

  it('reactionDetails lists every sender with their profile', async () => {
    const { client, room } = world([msg('$a')]);
    room.relations.getChildEventsForEvent = () => ({
      getSortedAnnotationsByKey: () => [
        [
          '👍',
          new Set([
            {
              getSender: () => '@bob:hs',
              getId: () => '$r1',
              isRedacted: () => false,
              getTs: () => 1,
            },
          ]),
        ],
      ],
    });
    const engine = engineFor(client);

    await expect(
      firstValueFrom(engine.reactionDetails(ME, ROOM, '$a')),
    ).resolves.toEqual({
      ok: true,
      value: [
        {
          key: '👍',
          senders: ['@bob:hs'],
          profiles: {
            '@bob:hs': {
              displayName: 'Alice',
              displayNameAmbiguous: false,
              avatarMxc: null,
            },
          },
        },
      ],
    });
  });

  it('profileName matches member.name for an ambiguous name', () => {
    const member = {
      name: 'Alice (@alice:hs)',
      rawDisplayName: 'Alice',
      disambiguate: true,
      getMxcAvatarUrl: () => null,
    };
    const { client } = world([msg('$a')], { member: () => member });
    const timeline = watch(engineFor(client));

    const item = timeline.events()[0];
    expect(profileName(item.sender, item.profiles[item.sender])).toBe(
      member.name,
    );
    timeline.subscription.unsubscribe();
  });

  it('unsubscribe removes every listener', () => {
    const { client, room } = world([msg('$a')], { roomMissing: true });
    const count = (emitter: EventEmitter) =>
      emitter
        .eventNames()
        .reduce((sum, name) => sum + emitter.listenerCount(name), 0);
    const engine = engineFor(client);

    const waiting = watch(engine);
    expect(count(client)).toBeGreaterThan(0);
    waiting.subscription.unsubscribe();
    expect(count(client)).toBe(0);

    const { client: live, room: liveRoom } = world([msg('$a')]);
    TestBed.resetTestingModule();
    const attached = watch(engineFor(live));
    expect(count(live)).toBeGreaterThan(0);
    expect(count(liveRoom)).toBeGreaterThan(0);
    for (const event of [
      MatrixEventEvent.Decrypted,
      MatrixEventEvent.Replaced,
      CryptoEvent.UserTrustStatusChanged,
      CryptoEvent.DevicesUpdated,
      CryptoEvent.KeysChanged,
    ]) {
      expect(live.listenerCount(event)).toBe(1);
    }
    attached.subscription.unsubscribe();
    expect(count(live)).toBe(0);
    expect(count(liveRoom)).toBe(0);
    expect(count(room)).toBe(0);
  });

  it('account-not-live when JS_SDK_CLIENTS has no client', async () => {
    const engine = engineFor(null);
    const nobody = '@nobody:hs';
    const commands: Observable<EngineResult<unknown>>[] = [
      engine.paginateBackwards(nobody, ROOM, LIVE, 10),
      engine.paginateUntil(nobody, ROOM, '$e', 1),
      engine.eventAt(nobody, ROOM, 0),
      engine.eventSource(nobody, ROOM, '$e'),
      engine.reactionDetails(nobody, ROOM, '$e'),
      engine.sendReceipt(nobody, ROOM, '$e', {
        threadRootId: null,
        visibility: 'private',
        fullyRead: false,
      }),
      engine.setTyping(nobody, ROOM, true),
    ];

    for (const command of commands) {
      expect(failureCode(await firstValueFrom(command))).toBe(
        'account-not-live',
      );
    }
    const first = await firstValueFrom(engine.timeline(nobody, ROOM, LIVE));
    expect(first).toEqual({ kind: 'room-unavailable' });
  });
});
