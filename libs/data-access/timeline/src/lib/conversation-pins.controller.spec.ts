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
  const sendStateEvent = vi.fn(() => Promise.resolve({ event_id: '$state' }));
  const client = {
    getUserId: () => KEY.accountId,
    getRoom: (roomId: string) => (roomId === KEY.roomId ? room : null),
    sendStateEvent,
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
});
