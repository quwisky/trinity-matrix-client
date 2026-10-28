import { TestBed } from '@angular/core/testing';
import {
  ConnectionError,
  EventType,
  MatrixError,
  MatrixEventEvent,
  RoomEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
import { NEVER, Subject, firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_PIN_POLICY,
  ConversationPinsController,
} from './conversation-pins.controller';
import type { ConversationPinPolicy } from './conversation-pins';
import type { PinnedEvents } from './conversation-content-engine';
import { JsSdkConversationContentEngine } from './js-sdk/js-sdk-conversation-content-engine';
import { fakeEmitter } from '@trinity/testing';
import { JS_SDK_CLIENTS } from '@trinity/data-access/matrix-client';
import { liveSession } from './timeline.spec-harness';

const KEY = {
  accountId: '@alice:example.org',
  roomId: '!room:example.org',
} as const;

const flush = () => new Promise((resolve) => setTimeout(resolve));

function setup({ roomEncrypted = false } = {}) {
  let pinned: unknown = ['$one'];
  let unreadable = false;
  const events = new Map([
    [
      '$one',
      {
        getId: () => '$one',
        getSender: () => '@bob:example.org',
        getOriginalContent: () => ({ body: 'First pinned message' }),
        getTs: () => 10,
        isDecryptionFailure: () => false,
        isRedacted: () => false,
        isEncrypted: () => false,
        isState: () => false,
        replacingEvent: () => null,
        status: null,
      },
    ],
    [
      '$two',
      {
        getId: () => '$two',
        getSender: () => '@carol:example.org',
        getOriginalContent: () => ({ body: 'Second pinned message' }),
        replacingEvent: () => null,
        getTs: () => 20,
        isDecryptionFailure: () => false,
        isRedacted: () => false,
      },
    ],
  ]);
  const state = {
    getStateEvents: (type: string) =>
      type === EventType.RoomPinnedEvents
        ? { getContent: () => ({ pinned }), getId: () => '$state' }
        : null,
  };
  const roomEmitter = fakeEmitter();
  const room = {
    roomId: KEY.roomId,
    hasEncryptionStateEvent: () => roomEncrypted,
    getLiveTimeline: () => {
      if (unreadable) throw new Error('unreadable');
      return { getState: () => state };
    },
    findEventById: (eventId: string) => events.get(eventId),
    getMember: (userId: string) => ({
      name: userId === '@bob:example.org' ? 'Bob' : 'Carol',
    }),
    ...roomEmitter,
  };
  const clientEmitter = fakeEmitter();
  // Events the server holds but the loaded timeline does not.
  const remote = new Map<string, Record<string, unknown>>();
  const fetchRoomEvent = vi.fn((_roomId: string, eventId: string) => {
    const raw = remote.get(eventId);
    return raw
      ? Promise.resolve(raw)
      : Promise.reject(
          Object.assign(new Error('Not found'), { httpStatus: 404 }),
        );
  });
  const decryptEventIfNeeded = vi.fn((event: { decrypt?: () => void }) => {
    event.decrypt?.();
    return Promise.resolve();
  });
  const getEventMapper = () => (raw: Record<string, unknown>) => {
    const encrypted = raw['type'] === 'm.room.encrypted';
    let clear: Record<string, unknown> | null = encrypted
      ? null
      : (raw['content'] as Record<string, unknown>);
    return {
      getId: () => raw['event_id'],
      getSender: () => raw['sender'],
      getContent: () => clear ?? {},
      getOriginalContent: () => clear ?? {},
      replacingEvent: () => null,
      getClearContent: () => clear,
      getTs: () => raw['origin_server_ts'],
      isEncrypted: () => encrypted,
      isDecryptionFailure: () => false,
      isRedacted: () => raw['redacted'] === true,
      decrypt: () => {
        clear = { body: raw['clear_body'] };
      },
    };
  };
  const sendStateEvent = vi.fn(() => Promise.resolve({ event_id: '$state' }));
  const client = {
    getUserId: () => KEY.accountId,
    getRoom: (roomId: string) => (roomId === KEY.roomId ? room : null),
    sendStateEvent,
    fetchRoomEvent,
    decryptEventIfNeeded,
    getEventMapper,
    ...clientEmitter,
  };
  const policy: {
    canMutate: ReturnType<typeof vi.fn<ConversationPinPolicy['canMutate']>>;
    authorize: ReturnType<typeof vi.fn<ConversationPinPolicy['authorize']>>;
  } = {
    canMutate: vi.fn(() => true),
    authorize: vi.fn(() => ({ kind: 'allowed' as const })),
  };
  const session = liveSession([KEY.accountId]);
  TestBed.configureTestingModule({
    providers: [
      ConversationPinsController,
      { provide: CONVERSATION_PIN_POLICY, useValue: policy },
      {
        provide: JS_SDK_CLIENTS,
        useValue: {
          clientFor: (accountId: string) =>
            accountId === KEY.accountId ? client : null,
        },
      },
      ...session.providers,
    ],
  });
  const controller = TestBed.inject(ConversationPinsController);
  controller.attach(KEY);
  const setPinned = (next: unknown) => {
    pinned = next;
  };
  return {
    controller,
    client,
    room,
    policy,
    sendStateEvent,
    remote,
    fetchRoomEvent,
    setPinned,
    session,
    makeUnreadable: () => {
      unreadable = true;
    },
    // Sets the pinned ids, announces the change as the SDK would, then lets fetches settle.
    pin: async (ids: string[]) => {
      setPinned(ids);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      await flush();
    },
  };
}

afterEach(() => TestBed.resetTestingModule());

describe('ConversationPinsController', () => {
  it('projects authoritative pinned state for one exact Conversation', () => {
    const { controller } = setup();

    expect(controller.eventIds()).toEqual(['$one']);
    expect(controller.messages()).toEqual([
      {
        id: '$one',
        sender: '@bob:example.org',
        senderName: 'Bob',
        body: 'First pinned message',
        ts: 10,
        status: 'loaded',
        shield: null,
      },
    ]);
    expect(controller.canMutate()).toBe(true);
  });

  it('marks a pinned message that arrived unencrypted in an encrypted room', () => {
    const { controller } = setup({ roomEncrypted: true });

    expect(controller.messages()[0]).toMatchObject({
      body: 'First pinned message',
      shield: { level: 'unencrypted', reason: 'Not encrypted' },
    });
  });

  it('reconciles remote state and late timeline resolution from the SDK', async () => {
    const { controller, room, setPinned } = setup();
    setPinned(['$two']);

    room.emit(RoomStateEvent.Events, {
      getType: () => EventType.RoomPinnedEvents,
    });

    expect(controller.eventIds()).toEqual(['$two']);
    expect(controller.messages()[0]?.id).toBe('$two');

    room.emit(RoomEvent.Timeline);
    await Promise.resolve();
    expect(controller.messages()[0]?.body).toBe('Second pinned message');
  });

  it('keeps writes cold, delegates policy, and waits for authoritative state', async () => {
    const { controller, policy, sendStateEvent } = setup();
    const command = controller.pin('$two');

    expect(sendStateEvent).not.toHaveBeenCalled();
    await expect(firstValueFrom(command)).resolves.toEqual({
      kind: 'applied',
      operation: 'pin',
    });
    expect(policy.authorize).toHaveBeenCalledWith(KEY, 'pin', '$two');
    expect(sendStateEvent).toHaveBeenCalledWith(
      KEY.roomId,
      EventType.RoomPinnedEvents,
      { pinned: ['$one', '$two'] },
      '',
    );
    // The command does not invent local state: the next room-state event is the
    // authority that publishes the new pin set.
    expect(controller.eventIds()).toEqual(['$one']);
  });

  it('returns a typed policy rejection without touching the SDK', async () => {
    const { controller, policy, sendStateEvent } = setup();
    policy.authorize.mockReturnValue({
      kind: 'rejected',
      failure: 'not-allowed',
    });

    await expect(firstValueFrom(controller.unpin('$one'))).resolves.toEqual({
      kind: 'rejected',
      operation: 'unpin',
      failure: 'not-allowed',
      retryable: false,
    });
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it.each([{}, 7, 'abc', null, { length: 0 }])(
    'opens with no pins when the pinned list is %j',
    (malformed) => {
      const { controller, setPinned, room } = setup();
      setPinned(malformed);

      expect(() => controller.attach(KEY)).not.toThrow();

      expect(controller.eventIds()).toEqual([]);
      expect(controller.messages()).toEqual([]);
      expect(room.listenerCount(RoomStateEvent.Events)).toBe(1);
    },
  );

  it('keeps only string ids from a mixed pinned list', () => {
    const { controller, setPinned } = setup();
    setPinned(['$one', 4, null, { a: 1 }, '$two']);
    controller.attach(KEY);

    expect(controller.eventIds()).toEqual(['$one', '$two']);
  });

  it('releases its listeners when reading the room state fails', () => {
    const { controller, room, client, makeUnreadable } = setup();
    makeUnreadable();

    controller.attach(KEY);

    expect(controller.eventIds()).toEqual([]);
    expect(controller.messages()).toEqual([]);

    expect(room.listenerCount(RoomStateEvent.Events)).toBe(0);
    expect(room.listenerCount(RoomEvent.Timeline)).toBe(0);
    expect(client.listenerCount(MatrixEventEvent.Decrypted)).toBe(0);
  });

  it('caps the pin list and fetches a few pins at a time', async () => {
    const { controller, setPinned, fetchRoomEvent } = setup();
    let inFlight = 0;
    let peak = 0;
    fetchRoomEvent.mockImplementation(async () => {
      peak = Math.max(peak, ++inFlight);
      await new Promise((resolve) => setTimeout(resolve, 0));
      inFlight--;
      throw Object.assign(new Error('Not found'), { httpStatus: 404 });
    });
    setPinned(Array.from({ length: 250 }, (_, i) => `$p${i}`));
    controller.attach(KEY);

    expect(controller.eventIds()).toHaveLength(100);
    await vi.waitFor(() => expect(fetchRoomEvent).toHaveBeenCalledTimes(100));
    expect(peak).toBe(4);
  });

  describe('writes keep what the display list drops', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `$p${i}`);
    const sent = (sendStateEvent: { mock: { calls: unknown[][] } }) =>
      sendStateEvent.mock.calls[0]?.[2];

    it('unpins from a 130-pin room without dropping the other 129', async () => {
      const { controller, setPinned, sendStateEvent } = setup();
      setPinned(ids(130));
      controller.attach(KEY);

      await firstValueFrom(controller.unpin('$p120'));

      expect(sent(sendStateEvent)).toEqual({
        pinned: ids(130).filter((id) => id !== '$p120'),
      });
    });

    it('keeps non-string entries when unpinning', async () => {
      const { controller, setPinned, sendStateEvent } = setup();
      setPinned(['$a', 5, '$b', null]);
      controller.attach(KEY);

      await firstValueFrom(controller.unpin('$a'));

      expect(sent(sendStateEvent)).toEqual({ pinned: [5, '$b', null] });
    });

    it('appends a pin to a 100-pin room and then shows it', async () => {
      const { controller, setPinned, room, sendStateEvent } = setup();
      setPinned(ids(100));
      controller.attach(KEY);

      await firstValueFrom(controller.pin('$new'));

      expect(sent(sendStateEvent)).toEqual({ pinned: [...ids(100), '$new'] });
      setPinned([...ids(100), '$new']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      expect(controller.eventIds().at(-1)).toBe('$new');
      expect(controller.eventIds()).toHaveLength(100);
    });

    it('shows the newest 100 pins and still knows the older ones', () => {
      const { controller, setPinned } = setup();
      setPinned(ids(130));
      controller.attach(KEY);

      expect(controller.eventIds()).toEqual(ids(130).slice(30));
      expect(controller.isPinned('$p0')).toBe(true);
      expect(controller.isPinned('$nope')).toBe(false);
    });
  });

  describe('bounded pin fetches', () => {
    const ids = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => `${prefix}${i}`);
    function hung() {
      const fixture = setup();
      const settle: Array<() => void> = [];
      fixture.fetchRoomEvent.mockImplementation(
        (_roomId: string, eventId: string) =>
          new Promise((resolve) =>
            settle.push(() =>
              resolve({
                event_id: eventId,
                room_id: KEY.roomId,
                sender: '@bob:example.org',
                type: 'm.room.message',
                origin_server_ts: 5,
                content: { body: `Body ${eventId}` },
              }),
            ),
          ),
      );
      const changeTo = (next: string[]) => {
        fixture.setPinned(next);
        fixture.room.emit(RoomStateEvent.Events, {
          getType: () => EventType.RoomPinnedEvents,
        });
      };
      const flush = () => new Promise((resolve) => setTimeout(resolve));
      return { ...fixture, settle, changeTo, flush };
    }

    it('drops queued pins when the list changes, and still resolves the new list', async () => {
      const f = hung();
      f.changeTo(ids('$q', 6));
      expect(f.fetchRoomEvent).toHaveBeenCalledTimes(4);

      f.changeTo(['$r0']);
      f.settle.splice(0).forEach((fn) => fn());
      await f.flush();

      expect(f.fetchRoomEvent.mock.calls.map((c) => c[1])).toEqual([
        '$q0',
        '$q1',
        '$q2',
        '$q3',
        '$r0',
      ]);
      f.settle.splice(0).forEach((fn) => fn());
      await f.flush();
      expect(f.controller.messages()).toMatchObject([
        { id: '$r0', status: 'loaded', body: 'Body $r0' },
      ]);
    });

    it('resolves queued pins of the current list as slots free up', async () => {
      const f = hung();
      f.changeTo(ids('$q', 6));
      f.settle.splice(0).forEach((fn) => fn());
      await f.flush();
      f.settle.splice(0).forEach((fn) => fn());
      await f.flush();

      expect(f.fetchRoomEvent).toHaveBeenCalledTimes(6);
      expect(f.controller.messages().map((m) => m.status)).toEqual(
        Array(6).fill('loaded'),
      );
    });

    it('starts no queued fetch after release and ignores late results', async () => {
      const f = hung();
      f.changeTo(ids('$q', 6));

      f.controller.release();
      f.settle.splice(0).forEach((fn) => fn());
      await f.flush();

      expect(f.fetchRoomEvent).toHaveBeenCalledTimes(4);
      expect(f.controller.messages()).toEqual([]);
    });

    it('treats a second release as a no-op', () => {
      const { controller } = setup();
      controller.release();

      expect(() => controller.release()).not.toThrow();
      expect(controller.resources().listenerCount).toBe(0);
    });

    it('survives a malformed list arriving after attach', () => {
      const { controller, setPinned, room } = setup();
      setPinned({});

      expect(() =>
        room.emit(RoomStateEvent.Events, {
          getType: () => EventType.RoomPinnedEvents,
        }),
      ).not.toThrow();
      expect(controller.eventIds()).toEqual([]);
      expect(controller.messages()).toEqual([]);
    });
  });

  it('detaches every listener and rejects commands after release', async () => {
    const { controller, room, client } = setup();
    expect(controller.resources().listenerCount).toBe(3);

    controller.release();

    expect(room.listenerCount(RoomStateEvent.Events)).toBe(0);
    expect(room.listenerCount(RoomEvent.Timeline)).toBe(0);
    expect(client.listenerCount(MatrixEventEvent.Decrypted)).toBe(0);
    expect(controller.resources()).toEqual({
      listenerCount: 0,
      retainedBytes: 0,
    });
    await expect(firstValueFrom(controller.pin('$two'))).resolves.toMatchObject(
      {
        kind: 'rejected',
        failure: 'conversation-unavailable',
      },
    );
    await expect(
      firstValueFrom(controller.unpin('$one')),
    ).resolves.toMatchObject({
      kind: 'rejected',
      failure: 'conversation-unavailable',
    });
  });

  it('retryFailed asks again only when a pin failed', async () => {
    const { controller, fetchRoomEvent, pin } = setup();
    await pin(['$gone']);

    controller.retryFailed();
    await flush();

    expect(fetchRoomEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects an unpin before the pin list has loaded', async () => {
    const { controller, sendStateEvent } = setup();
    vi.spyOn(
      TestBed.inject(JsSdkConversationContentEngine),
      'pinnedEvents',
    ).mockReturnValue(NEVER);
    controller.attach(KEY);

    await expect(firstValueFrom(controller.unpin('$two'))).resolves.toEqual({
      kind: 'rejected',
      operation: 'unpin',
      failure: 'conversation-unavailable',
      retryable: false,
    });
    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('closes a feed that errors and leaves an empty list', () => {
    const { controller } = setup();
    const feed = new Subject<PinnedEvents>();
    vi.spyOn(
      TestBed.inject(JsSdkConversationContentEngine),
      'pinnedEvents',
    ).mockReturnValue(feed);
    controller.attach(KEY);
    feed.next({ eventIds: ['$one'], allEventIds: ['$one'], entries: [] });
    expect(controller.eventIds()).toEqual(['$one']);

    feed.error(new Error('feed broke'));

    expect(feed.observed).toBe(false);
    expect(controller.eventIds()).toEqual([]);
    expect(controller.messages()).toEqual([]);
    expect(controller.isPinned('$one')).toBe(false);
    expect(controller.resources().listenerCount).toBe(0);
  });

  it('closes its feed when the account leaves and reopens it when it returns', () => {
    const { controller, room, client, session } = setup();

    session.publish([]);

    expect(room.listenerCount(RoomStateEvent.Events)).toBe(0);
    expect(client.listenerCount(MatrixEventEvent.Decrypted)).toBe(0);
    expect(controller.messages()).toEqual([]);
    expect(controller.canMutate()).toBe(false);

    session.publish([KEY.accountId]);

    expect(room.listenerCount(RoomStateEvent.Events)).toBe(1);
    expect(controller.eventIds()).toEqual(['$one']);
  });

  it.each([
    ['a network failure', Object.assign(new Error('down'), {}), false],
    ['a forbidden write', { httpStatus: 403, errcode: 'M_FORBIDDEN' }, false],
  ])('rejects a pin after %s', async (_name, error, retryable) => {
    const { controller, sendStateEvent } = setup();
    sendStateEvent.mockRejectedValueOnce(error as never);

    await expect(firstValueFrom(controller.pin('$two'))).resolves.toEqual({
      kind: 'rejected',
      operation: 'pin',
      failure: 'request-rejected',
      retryable,
    });
  });

  it.each([
    ['a lost connection', () => new ConnectionError('down')],
    ['a server error', () => new MatrixError({ errcode: 'M_UNKNOWN' }, 502)],
    [
      'rate limiting',
      () => new MatrixError({ errcode: 'M_LIMIT_EXCEEDED' }, 429),
    ],
  ])('marks a pin rejected by %s retryable', async (_name, error) => {
    const { controller, sendStateEvent } = setup();
    sendStateEvent.mockRejectedValueOnce(error() as never);

    await expect(firstValueFrom(controller.pin('$two'))).resolves.toEqual({
      kind: 'rejected',
      operation: 'pin',
      failure: 'request-rejected',
      retryable: true,
    });
  });

  describe('pins outside the loaded timeline', () => {
    const raw = (id: string, over: Record<string, unknown> = {}) => ({
      event_id: id,
      room_id: KEY.roomId,
      sender: '@bob:example.org',
      type: 'm.room.message',
      origin_server_ts: 5,
      content: { body: `Old ${id}` },
      ...over,
    });
    beforeEach(() => vi.useFakeTimers({ toFake: ['Date'] }));
    afterEach(() => vi.useRealTimers());

    it('lists a loading row, then the fetched message, in pin order', async () => {
      const { controller, remote, fetchRoomEvent, setPinned, room } = setup();
      remote.set('$old', raw('$old'));
      setPinned(['$old', '$one']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });

      expect(controller.messages().map((m) => [m.id, m.status])).toEqual([
        ['$old', 'loading'],
        ['$one', 'loaded'],
      ]);
      await flush();

      expect(fetchRoomEvent).toHaveBeenCalledWith(KEY.roomId, '$old');
      expect(controller.messages()).toMatchObject([
        { id: '$old', status: 'loaded', body: 'Old $old', senderName: 'Bob' },
        { id: '$one', status: 'loaded' },
      ]);
    });

    it('fetches each unloaded pin once, not on every recompute', async () => {
      const { controller, remote, fetchRoomEvent, room, pin } = setup();
      remote.set('$old', raw('$old'));
      await pin(['$old']);
      room.emit(RoomEvent.Timeline);
      await flush();
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPowerLevels,
      });
      await flush();

      expect(fetchRoomEvent).toHaveBeenCalledTimes(1);
      expect(controller.messages()[0]?.status).toBe('loaded');
    });

    it('shows an unavailable row when the server will not return the event', async () => {
      const { controller, pin } = setup();
      await pin(['$gone', '$one']);

      expect(controller.messages().map((m) => [m.id, m.status])).toEqual([
        ['$gone', 'unavailable'],
        ['$one', 'loaded'],
      ]);
    });

    it('decrypts an encrypted pin before showing it', async () => {
      const { controller, remote, pin } = setup();
      remote.set(
        '$secret',
        raw('$secret', {
          type: 'm.room.encrypted',
          clear_body: 'Decrypted text',
        }),
      );
      await pin(['$secret']);

      expect(controller.messages()[0]).toMatchObject({
        status: 'loaded',
        body: 'Decrypted text',
      });
    });

    it('skips a redacted pin as before', async () => {
      const { controller, remote, pin } = setup();
      remote.set('$old', raw('$old', { redacted: true }));
      await pin(['$old']);

      expect(controller.messages()).toEqual([]);
    });

    it('reports a pin whose fetch fails as failed, not unavailable', async () => {
      const { controller, fetchRoomEvent, pin } = setup();
      fetchRoomEvent.mockRejectedValueOnce(new Error('network down'));
      await pin(['$old']);

      expect(controller.messages().map((m) => [m.id, m.status])).toEqual([
        ['$old', 'failed'],
      ]);
    });

    it('reports a pin the server will not return as unavailable', async () => {
      const { controller, fetchRoomEvent, pin } = setup();
      fetchRoomEvent.mockRejectedValueOnce(
        Object.assign(new Error('Not found'), { httpStatus: 404 }),
      );
      await pin(['$old']);

      expect(controller.messages()[0]?.status).toBe('unavailable');
    });

    it('retries a failed pin after the next invalidation', async () => {
      const { controller, remote, fetchRoomEvent, room, pin } = setup();
      remote.set('$old', raw('$old'));
      fetchRoomEvent.mockRejectedValueOnce(new Error('network down'));
      await pin(['$old']);
      expect(controller.messages()[0]?.status).toBe('failed');

      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPowerLevels,
      });
      await flush();

      expect(fetchRoomEvent).toHaveBeenCalledTimes(2);
      expect(controller.messages()[0]?.status).toBe('loaded');
    });

    it.each([
      [
        'Decrypted',
        () => [MatrixEventEvent.Decrypted, { getRoomId: () => KEY.roomId }],
      ],
      ['Timeline', () => [RoomEvent.Timeline]],
    ] as const)(
      'retries a failed pin after a %s event',
      async (_name, args) => {
        const { controller, remote, client, room, fetchRoomEvent, pin } =
          setup();
        remote.set('$old', raw('$old'));
        fetchRoomEvent.mockRejectedValueOnce(new Error('network down'));
        await pin(['$old']);
        expect(controller.messages()[0]?.status).toBe('failed');

        vi.setSystemTime(Date.now() + 30_000);
        const [event, ...rest] = args() as [string, ...unknown[]];
        (event === MatrixEventEvent.Decrypted ? client : room).emit(
          event,
          ...rest,
        );
        await flush();

        expect(fetchRoomEvent).toHaveBeenCalledTimes(2);
        expect(controller.messages()[0]?.status).toBe('loaded');
      },
    );

    it('throttles automatic retries to one per 30 seconds', async () => {
      const { controller, room, fetchRoomEvent, pin } = setup();
      fetchRoomEvent.mockRejectedValue(new Error('network down'));
      await pin(['$old']);
      expect(fetchRoomEvent).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 10_000);
      room.emit(RoomEvent.Timeline);
      room.emit(RoomEvent.Timeline);
      await flush();
      expect(fetchRoomEvent).toHaveBeenCalledTimes(1);

      vi.setSystemTime(Date.now() + 20_000);
      room.emit(RoomEvent.Timeline);
      await flush();
      expect(fetchRoomEvent).toHaveBeenCalledTimes(2);
      expect(controller.messages()[0]?.status).toBe('failed');
    });

    it('keeps showing failed, never loading, while a failed pin is re-fetched', async () => {
      const { controller, remote, fetchRoomEvent, pin } = setup();
      remote.set('$old', raw('$old'));
      fetchRoomEvent.mockRejectedValueOnce(new Error('network down'));
      await pin(['$old']);
      let release!: () => void;
      fetchRoomEvent.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve(remote.get('$old') as never);
          }),
      );

      controller.retryFailed();
      await flush();
      expect(fetchRoomEvent).toHaveBeenCalledTimes(2);
      expect(controller.messages()[0]?.status).toBe('failed');

      release();
      await flush();
      expect(controller.messages()[0]?.status).toBe('loaded');
    });

    it('retries failed pins on retryFailed and keeps an unavailable one unavailable', async () => {
      const { controller, remote, fetchRoomEvent, pin } = setup();
      remote.set('$old', raw('$old'));
      fetchRoomEvent.mockRejectedValueOnce(new Error('network down'));
      await pin(['$old', '$gone']);
      expect(fetchRoomEvent).toHaveBeenCalledTimes(2);

      controller.retryFailed();
      expect(controller.messages().map((m) => m.status)).toEqual([
        'failed',
        'unavailable',
      ]);
      await flush();

      // Only the failed pin is asked for again.
      expect(fetchRoomEvent).toHaveBeenCalledTimes(3);
      expect(fetchRoomEvent).toHaveBeenLastCalledWith(KEY.roomId, '$old');
      expect(controller.messages().map((m) => [m.id, m.status])).toEqual([
        ['$old', 'loaded'],
        ['$gone', 'unavailable'],
      ]);
    });

    it('drops a fetch that resolves after the pin list changed', async () => {
      const { controller, remote, fetchRoomEvent, setPinned, room, pin } =
        setup();
      remote.set('$old', raw('$old'));
      remote.set('$newer', raw('$newer'));
      setPinned(['$old']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      await pin(['$newer']);

      expect(fetchRoomEvent).toHaveBeenCalledTimes(2);
      expect(controller.messages().map((m) => m.id)).toEqual(['$newer']);
    });

    it('drops results that resolve after the room was released', async () => {
      const { controller, remote, setPinned, room } = setup();
      remote.set('$old', raw('$old'));
      setPinned(['$old']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      controller.release();
      await flush();

      expect(controller.messages()).toEqual([]);
    });
  });
});
