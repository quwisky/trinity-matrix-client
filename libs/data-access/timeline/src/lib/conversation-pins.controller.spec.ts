import { TestBed } from '@angular/core/testing';
import {
  EventType,
  MatrixEventEvent,
  RoomEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONVERSATION_PIN_POLICY,
  ConversationPinsController,
} from './conversation-pins.controller';
import type { ConversationPinPolicy } from './conversation-pins';

const KEY = {
  accountId: '@alice:example.org',
  roomId: '!room:example.org',
} as const;

function emitter() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      const listeners = handlers.get(event) ?? new Set();
      listeners.add(handler);
      handlers.set(event, listeners);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      handlers.get(event)?.delete(handler);
    }),
    emit(event: string, ...args: unknown[]) {
      for (const handler of handlers.get(event) ?? []) handler(...args);
    },
    listenerCount(event: string) {
      return handlers.get(event)?.size ?? 0;
    },
  };
}

function setup() {
  let pinned = ['$one'];
  const events = new Map([
    [
      '$one',
      {
        getId: () => '$one',
        getSender: () => '@bob:example.org',
        getContent: () => ({ body: 'First pinned message' }),
        getTs: () => 10,
        isDecryptionFailure: () => false,
        isRedacted: () => false,
      },
    ],
    [
      '$two',
      {
        getId: () => '$two',
        getSender: () => '@carol:example.org',
        getContent: () => ({ body: 'Second pinned message' }),
        getTs: () => 20,
        isDecryptionFailure: () => false,
        isRedacted: () => false,
      },
    ],
  ]);
  const state = {
    getStateEvents: (type: string) =>
      type === EventType.RoomPinnedEvents
        ? { getContent: () => ({ pinned }) }
        : null,
  };
  const roomEmitter = emitter();
  const room = {
    roomId: KEY.roomId,
    getLiveTimeline: () => ({ getState: () => state }),
    findEventById: (eventId: string) => events.get(eventId),
    getMember: (userId: string) => ({
      name: userId === '@bob:example.org' ? 'Bob' : 'Carol',
    }),
    ...roomEmitter,
  };
  const clientEmitter = emitter();
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
  TestBed.configureTestingModule({
    providers: [
      ConversationPinsController,
      { provide: CONVERSATION_PIN_POLICY, useValue: policy },
    ],
  });
  const controller = TestBed.inject(ConversationPinsController);
  controller.attach(KEY, client as never);
  return {
    controller,
    client,
    room,
    policy,
    sendStateEvent,
    remote,
    fetchRoomEvent,
    setPinned: (next: string[]) => {
      pinned = next;
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
      },
    ]);
    expect(controller.canMutate()).toBe(true);
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
    const flush = () => new Promise((resolve) => setTimeout(resolve));

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
      const { controller, remote, fetchRoomEvent, setPinned, room } = setup();
      remote.set('$old', raw('$old'));
      setPinned(['$old']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      await flush();
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
      const { controller, setPinned, room } = setup();
      setPinned(['$gone', '$one']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      await flush();

      expect(controller.messages().map((m) => [m.id, m.status])).toEqual([
        ['$gone', 'unavailable'],
        ['$one', 'loaded'],
      ]);
    });

    it('decrypts an encrypted pin before showing it', async () => {
      const { controller, remote, setPinned, room } = setup();
      remote.set(
        '$secret',
        raw('$secret', {
          type: 'm.room.encrypted',
          clear_body: 'Decrypted text',
        }),
      );
      setPinned(['$secret']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      await flush();

      expect(controller.messages()[0]).toMatchObject({
        status: 'loaded',
        body: 'Decrypted text',
      });
    });

    it('skips a redacted pin as before', async () => {
      const { controller, remote, setPinned, room } = setup();
      remote.set('$old', raw('$old', { redacted: true }));
      setPinned(['$old']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      await flush();

      expect(controller.messages()).toEqual([]);
    });

    it('reports a pin whose fetch fails as failed, not unavailable', async () => {
      const { controller, fetchRoomEvent, setPinned, room } = setup();
      fetchRoomEvent.mockRejectedValueOnce(new Error('network down'));
      setPinned(['$old']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      await flush();

      expect(controller.messages().map((m) => [m.id, m.status])).toEqual([
        ['$old', 'failed'],
      ]);
    });

    it('reports a pin the server will not return as unavailable', async () => {
      const { controller, fetchRoomEvent, setPinned, room } = setup();
      fetchRoomEvent.mockRejectedValueOnce(
        Object.assign(new Error('Forbidden'), { httpStatus: 403 }),
      );
      setPinned(['$old']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      await flush();

      expect(controller.messages()[0]?.status).toBe('unavailable');
    });

    it('retries a failed pin after the next invalidation', async () => {
      const { controller, remote, fetchRoomEvent, setPinned, room } = setup();
      remote.set('$old', raw('$old'));
      fetchRoomEvent.mockRejectedValueOnce(new Error('network down'));
      setPinned(['$old']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      await flush();
      expect(controller.messages()[0]?.status).toBe('failed');

      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPowerLevels,
      });
      await flush();

      expect(fetchRoomEvent).toHaveBeenCalledTimes(2);
      expect(controller.messages()[0]?.status).toBe('loaded');
    });

    it('drops a fetch that resolves after the pin list changed', async () => {
      const { controller, remote, fetchRoomEvent, setPinned, room } = setup();
      remote.set('$old', raw('$old'));
      remote.set('$newer', raw('$newer'));
      setPinned(['$old']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      setPinned(['$newer']);
      room.emit(RoomStateEvent.Events, {
        getType: () => EventType.RoomPinnedEvents,
      });
      await flush();

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
