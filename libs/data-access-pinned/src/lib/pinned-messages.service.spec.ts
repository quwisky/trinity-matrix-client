import { TestBed } from '@angular/core/testing';
import {
  EventType,
  MatrixEventEvent,
  RoomEvent,
  RoomStateEvent,
} from 'matrix-js-sdk';
import { MockProvider } from 'ng-mocks';
import { describe, expect, it, vi } from 'vitest';
import { PinnedMessagesService } from './pinned-messages.service';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

const MEMBERS: Record<string, string> = {
  '@me:hs': 'Me',
  '@a:hs': 'Alice',
  '@b:hs': 'Bob',
};

/** Minimal mutable event-emitter shim so tests can fire SDK listeners. */
function emitter() {
  const handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  return {
    on(ev: string, h: (...a: unknown[]) => void) {
      (handlers[ev] ??= []).push(h);
    },
    off(ev: string, h: (...a: unknown[]) => void) {
      handlers[ev] = (handlers[ev] ?? []).filter((x) => x !== h);
    },
    emit(ev: string, ...args: unknown[]) {
      (handlers[ev] ?? []).slice().forEach((h) => h(...args));
    },
    /** How many handlers are attached — lets a test prove nothing was left behind. */
    listenerCount(ev: string) {
      return (handlers[ev] ?? []).length;
    },
  };
}

function fakeEvent(o: {
  id: string;
  sender: string;
  body?: string;
  ts?: number;
  type?: string;
  redacted?: boolean;
  decryptFail?: boolean;
  roomId?: string;
}) {
  return {
    getId: () => o.id,
    getSender: () => o.sender,
    getRoomId: () => o.roomId ?? '!r:hs',
    getTs: () => o.ts ?? 0,
    getType: () => o.type ?? 'm.room.message',
    getContent: () => ({ body: o.body ?? '' }),
    isRedacted: () => o.redacted ?? false,
    isDecryptionFailure: () => o.decryptFail ?? false,
  };
}

type FakeEvent = ReturnType<typeof fakeEvent>;

/** A state event carrying just the bits `onStateEvent`'s type-filter reads. */
function stateEvent(type: string) {
  return { getType: () => type };
}

function setup(
  opts: {
    pinned?: string[];
    canPin?: boolean;
    events?: FakeEvent[];
    roomId?: string;
    noRoom?: boolean;
  } = {},
) {
  const roomId = opts.roomId ?? '!r:hs';
  let pinnedContent: { pinned: string[] } | null = opts.pinned
    ? { pinned: opts.pinned }
    : null;
  let canPin = opts.canPin ?? true;
  const events = opts.events ?? [];
  const maySendStateEvent = vi.fn(() => canPin);
  const roomEmitter = emitter();

  /**
   * A RoomState, modelled after the SDK: emitting on the *current* state also fires the
   * Room's handlers (matrix-js-sdk re-emits RoomStateEvent.* off the Room via reEmitter).
   * A state that has been replaced stops re-emitting, mirroring `stopReEmitting`.
   */
  function makeState() {
    const own = emitter();
    return {
      getStateEvents: (type: string, stateKey?: string) =>
        type === EventType.RoomPinnedEvents && stateKey === ''
          ? pinnedContent
            ? { getContent: () => pinnedContent }
            : null
          : null,
      maySendStateEvent,
      ...own,
      emit(ev: string, ...args: unknown[]) {
        own.emit(ev, ...args);
        if (live === this) {
          roomEmitter.emit(ev, ...args);
        }
      },
    };
  }
  let live = makeState();
  const currentState = live;

  const room = {
    roomId,
    // `Room.currentState` is a cached property the SDK reassigns from the live timeline
    // whenever that timeline is reset, so it has to be readable through the variable.
    get currentState() {
      return live;
    },
    findEventById: (id: string) => events.find((e) => e.getId() === id),
    getMember: (id: string) => ({ name: MEMBERS[id] ?? id }),
    ...roomEmitter,
  };
  const sendStateEvent = vi.fn(
    (_rid: string, _type: string, content: { pinned: string[] }) => {
      pinnedContent = content;
      return Promise.resolve({ event_id: '$state' });
    },
  );
  const client = {
    getRoom: (id: string) => (opts.noRoom ? null : id === roomId ? room : null),
    getUserId: () => '@me:hs',
    sendStateEvent,
    ...emitter(),
  };
  TestBed.configureTestingModule({
    providers: [
      PinnedMessagesService,
      MockProvider(MatrixClientService, {
        isInitialized: true,
        instance: client as never,
      }),
    ],
  });
  const svc = TestBed.inject(PinnedMessagesService);
  return {
    svc,
    room,
    client,
    /** The state object present at setup — stale once {@link replaceLiveState} runs. */
    currentState,
    /** The room state the service would read right now (changes after a replacement). */
    liveState: () => live,
    /**
     * Replace the room's live RoomState, as the SDK does whenever the live timeline is
     * reset (fixUpLegacyTimelineFields swaps the object and rewires re-emission).
     */
    replaceLiveState: () => {
      live = makeState();
    },
    sendStateEvent,
    maySendStateEvent,
    setPinned: (p: string[] | null) => {
      pinnedContent = p ? { pinned: p } : null;
    },
    setCanPin: (v: boolean) => {
      canPin = v;
    },
  };
}

describe('PinnedMessagesService', () => {
  it('reads pinnedEventIds from the m.room.pinned_events state on open', () => {
    const { svc } = setup({ pinned: ['$a', '$b'] });

    svc.open('!r:hs');

    expect(svc.pinnedEventIds()).toEqual(['$a', '$b']);
  });

  it('defaults to an empty array when there is no pinned_events state', () => {
    const { svc } = setup();

    svc.open('!r:hs');

    expect(svc.pinnedEventIds()).toEqual([]);
  });

  it('resolves pinnedMessages via findEventById, skipping missing and redacted ids', () => {
    const a = fakeEvent({
      id: '$a',
      sender: '@a:hs',
      body: 'hello world',
      ts: 100,
    });
    const redacted = fakeEvent({ id: '$r', sender: '@b:hs', redacted: true });
    const { svc } = setup({
      pinned: ['$a', '$missing', '$r'],
      events: [a, redacted],
    });

    svc.open('!r:hs');

    const views = svc.pinnedMessages();
    expect(views.map((v) => v.id)).toEqual(['$a']);
    expect(views[0]).toMatchObject({
      id: '$a',
      sender: '@a:hs',
      senderName: 'Alice',
      body: 'hello world',
      ts: 100,
    });
  });

  it('canPin reflects maySendStateEvent when true', () => {
    const { svc } = setup({ canPin: true });

    svc.open('!r:hs');

    expect(svc.canPin()).toBe(true);
  });

  it('canPin reflects maySendStateEvent when false', () => {
    const { svc } = setup({ canPin: false });

    svc.open('!r:hs');

    expect(svc.canPin()).toBe(false);
  });

  it('pin(id) appends the id and writes the full array via sendStateEvent', () => {
    const { svc, sendStateEvent } = setup({ pinned: ['$a'] });
    svc.open('!r:hs');

    svc.pin('$b');

    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      EventType.RoomPinnedEvents,
      { pinned: ['$a', '$b'] },
      '',
    );
  });

  it('unpin(id) filters the id out and writes the remaining array', () => {
    const { svc, sendStateEvent } = setup({ pinned: ['$a', '$b', '$c'] });
    svc.open('!r:hs');

    svc.unpin('$b');

    expect(sendStateEvent).toHaveBeenCalledWith(
      '!r:hs',
      EventType.RoomPinnedEvents,
      { pinned: ['$a', '$c'] },
      '',
    );
  });

  it('isPinned reports membership in the current pinned array', () => {
    const { svc } = setup({ pinned: ['$a'] });
    svc.open('!r:hs');

    expect(svc.isPinned('$a')).toBe(true);
    expect(svc.isPinned('$z')).toBe(false);
  });

  it('pin is a no-op when the id is already pinned', () => {
    const { svc, sendStateEvent } = setup({ pinned: ['$a'] });
    svc.open('!r:hs');

    svc.pin('$a');

    expect(sendStateEvent).not.toHaveBeenCalled();
  });

  it('a RoomStateEvent.Events emission for pinned_events re-reads pinnedEventIds live', () => {
    const { svc, currentState, setPinned } = setup({ pinned: ['$a'] });
    svc.open('!r:hs');
    expect(svc.pinnedEventIds()).toEqual(['$a']);

    // A remote client pinned another message; the room re-emits its state event.
    setPinned(['$a', '$b']);
    currentState.emit(
      RoomStateEvent.Events,
      stateEvent(EventType.RoomPinnedEvents),
    );

    expect(svc.pinnedEventIds()).toEqual(['$a', '$b']);
  });

  it('a RoomStateEvent.Events emission for power_levels re-reads canPin live', () => {
    const { svc, currentState, setCanPin } = setup({ canPin: false });
    svc.open('!r:hs');
    expect(svc.canPin()).toBe(false);

    // A moderator promotion changes the user's ability to pin.
    setCanPin(true);
    currentState.emit(
      RoomStateEvent.Events,
      stateEvent(EventType.RoomPowerLevels),
    );

    expect(svc.canPin()).toBe(true);
  });

  it('ignores unrelated state event types', () => {
    const { svc, currentState, setPinned } = setup({ pinned: ['$a'] });
    svc.open('!r:hs');

    setPinned(['$a', '$b']);
    currentState.emit(RoomStateEvent.Events, stateEvent('m.room.topic'));

    // No re-read for an irrelevant state type.
    expect(svc.pinnedEventIds()).toEqual(['$a']);
  });

  // The SDK replaces a room's RoomState object whenever the live timeline is reset
  // (e.g. a limited sync), re-pointing its re-emission at the new one. A listener bound
  // to the old object would both stop hearing updates and survive close().
  it('keeps tracking pins after the live room state is replaced', () => {
    const { svc, liveState, replaceLiveState, setPinned } = setup({
      pinned: ['$a'],
    });
    svc.open('!r:hs');

    replaceLiveState();
    setPinned(['$a', '$b']);
    liveState().emit(RoomStateEvent.Events, stateEvent('m.room.pinned_events'));

    expect(svc.pinnedEventIds()).toEqual(['$a', '$b']);
  });

  it('leaves no state listener behind on close after the state was replaced', () => {
    const { svc, currentState, replaceLiveState } = setup({ pinned: ['$a'] });
    svc.open('!r:hs');

    replaceLiveState(); // the object open() saw is now stale
    svc.close();

    expect(currentState.listenerCount(RoomStateEvent.Events)).toBe(0);
  });

  it('resolves a pinned message that loads later via RoomEvent.Timeline', () => {
    const { svc, room } = setup({ pinned: ['$late'] });
    svc.open('!r:hs');
    expect(svc.pinnedMessages()).toEqual([]);

    // The event backfills into the room's local timeline.
    const late = fakeEvent({ id: '$late', sender: '@a:hs', body: 'hi' });
    (
      room as unknown as {
        findEventById: (id: string) => FakeEvent | undefined;
      }
    ).findEventById = (id: string) => (id === '$late' ? late : undefined);
    room.emit(RoomEvent.Timeline);

    expect(svc.pinnedMessages().map((v) => v.id)).toEqual(['$late']);
  });

  it('resolves a pinned message that decrypts later via MatrixEventEvent.Decrypted', () => {
    const { svc, room, client } = setup({ pinned: ['$enc'] });
    svc.open('!r:hs');
    expect(svc.pinnedMessages()).toEqual([]);

    const decrypted = fakeEvent({
      id: '$enc',
      sender: '@a:hs',
      body: 'secret',
      roomId: '!r:hs',
    });
    (
      room as unknown as {
        findEventById: (id: string) => FakeEvent | undefined;
      }
    ).findEventById = (id: string) => (id === '$enc' ? decrypted : undefined);
    client.emit(MatrixEventEvent.Decrypted, decrypted);

    expect(svc.pinnedMessages().map((v) => v.id)).toEqual(['$enc']);
  });

  it('does not bump the revision for a Decrypted event from a different room', () => {
    const enc = fakeEvent({
      id: '$enc',
      sender: '@a:hs',
      body: 'secret',
      roomId: '!other:hs',
    });
    const { svc, client } = setup({ pinned: ['$enc'] });
    svc.open('!r:hs');
    // Not yet resolvable: the event was never added to the room's timeline.
    expect(svc.pinnedMessages()).toEqual([]);

    client.emit(MatrixEventEvent.Decrypted, enc);

    // Still unresolved — the decrypted event belongs to a different room.
    expect(svc.pinnedMessages()).toEqual([]);
  });

  it('close() detaches listeners and clears state; a later emission does not mutate', () => {
    const { svc, room, currentState, client, setPinned } = setup({
      pinned: ['$a'],
      canPin: true,
    });
    svc.open('!r:hs');
    expect(svc.pinnedEventIds()).toEqual(['$a']);
    expect(svc.canPin()).toBe(true);

    svc.close();
    expect(svc.pinnedEventIds()).toEqual([]);
    expect(svc.canPin()).toBe(false);
    expect(svc.pinnedMessages()).toEqual([]);

    // Late emissions on the now-detached room/state/client must not resurrect state.
    setPinned(['$a', '$b']);
    currentState.emit(
      RoomStateEvent.Events,
      stateEvent(EventType.RoomPinnedEvents),
    );
    room.emit(RoomEvent.Timeline);
    client.emit(
      MatrixEventEvent.Decrypted,
      fakeEvent({ id: '$a', sender: '@a:hs' }),
    );

    expect(svc.pinnedEventIds()).toEqual([]);
    expect(svc.canPin()).toBe(false);
  });

  it('open() is a no-op when the room is not found', () => {
    const { svc } = setup({ noRoom: true, pinned: ['$a'] });

    svc.open('!r:hs');

    expect(svc.pinnedEventIds()).toEqual([]);
  });

  it('open() is idempotent for the same room id (guard short-circuits)', () => {
    const { svc, setPinned } = setup({ pinned: ['$a'] });
    svc.open('!r:hs');
    expect(svc.pinnedEventIds()).toEqual(['$a']);

    // A second open() for the same room must not re-run readRoomState — a stale
    // read here would silently pick up this change, which it must not.
    setPinned(['$a', '$b']);
    svc.open('!r:hs');

    expect(svc.pinnedEventIds()).toEqual(['$a']);
  });

  it('unpin and pin are no-ops without an open room', () => {
    const { svc, sendStateEvent } = setup({ pinned: ['$a'] });
    // svc.open() was never called.

    svc.pin('$b');
    svc.unpin('$a');

    expect(sendStateEvent).not.toHaveBeenCalled();
  });
});
