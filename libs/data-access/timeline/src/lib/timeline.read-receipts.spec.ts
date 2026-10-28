import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { RoomEvent } from 'matrix-js-sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONVERSATION_ATTENTION } from './conversation-attention.port';
import { TimelineService } from './timeline.service';
import {
  clientFor,
  fakeClient,
  fakeEvent,
  fakeRoom,
  matrixProvider,
  mediaProvider,
  openTimeline,
  privacyProvider,
  setup,
} from './timeline.spec-harness';

// The fake clients here model one page of history as `client.scrollback`. The real paging
// (and its race with gappy syncs) is covered against the SDK in live-scrollback.spec.
vi.mock('./js-sdk/live-scrollback', () => ({
  scrollbackLive: async (
    client: { scrollback: (room: unknown, limit: number) => Promise<unknown> },
    room: unknown,
    limit: number,
  ) => {
    await client.scrollback(room, limit);
  },
}));

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [privacyProvider(true)] });
});

beforeEach(() => {
  // Viewing a room = the window is focused (the normal case). markRead only acks
  // while focused; the unfocused / refocus paths are exercised explicitly below.
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});
afterEach(() => vi.restoreAllMocks());

it('keeps a blurred timeline warm while suppressing foreground-only effects', async () => {
  const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
  const room = fakeRoom(events);
  const sendReadReceipt = vi.fn((_event: ReturnType<typeof fakeEvent>) =>
    Promise.resolve({}),
  );
  const scrollback = vi.fn(() => Promise.resolve(room));
  const client = { ...fakeClient(room, []), sendReadReceipt, scrollback };
  TestBed.configureTestingModule({
    providers: [TimelineService, matrixProvider(client), mediaProvider()],
  });
  const svc = TestBed.inject(TimelineService);
  svc.open('!r:hs');
  sendReadReceipt.mockClear();
  const loadOlder$ = svc.loadOlder();

  svc.setVisible(false);
  await firstValueFrom(loadOlder$);
  events.push(fakeEvent({ id: '$b', sender: '@a:hs', body: 'still warm' }));
  window.dispatchEvent(new Event('focus'));

  expect(svc.openRoomId).toBe('!r:hs');
  expect(svc.openContext()).toBeNull();
  expect(scrollback).not.toHaveBeenCalled();
  expect(sendReadReceipt).not.toHaveBeenCalled();

  svc.setVisible(true);

  expect(svc.openContext()?.room).toBe(room);
  expect(sendReadReceipt).toHaveBeenCalledTimes(1);
  expect(sendReadReceipt.mock.calls[0][0].getId()).toBe('$b');
});

it('reports deterministic retained resources and returns them to zero on release', () => {
  const svc = setup([
    fakeEvent({ id: '$a', sender: '@a:hs', body: 'one' }),
    fakeEvent({ id: '$b', sender: '@b:hs', body: 'two' }),
  ]);

  expect(svc.resources()).toEqual({
    listenerCount: 12,
    retainedBytes: 160,
  });

  svc.close();

  expect(svc.resources()).toEqual({ listenerCount: 0, retainedBytes: 0 });
});

it('bounds the application projection retained by a blurred conversation', () => {
  const events = Array.from({ length: 150 }, (_, index) =>
    fakeEvent({
      id: `$${index}`,
      sender: `@user-${index}:hs`,
      body: `message ${index}`,
    }),
  );
  const svc = setup(events);

  svc.setVisible(false);

  expect(svc.messages()).toHaveLength(100);
  expect(svc.resources().retainedBytes).toBeLessThanOrEqual(11_200);

  svc.setVisible(true);

  expect(svc.messages()).toHaveLength(150);
});

it('re-acks with the latest live event on refocus, not a stale snapshot', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false); // start unfocused
  const received: { getId: () => string }[] = [];
  const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
  const room = fakeRoom(events);
  const client = clientFor(room, {
    sendReadReceipt: (e: { getId: () => string }) => {
      received.push(e);
      return Promise.resolve({});
    },
  });
  openTimeline(client);
  expect(received).toHaveLength(0); // unfocused: not acked yet

  // The live timeline gains a newer event while still unfocused (no refresh
  // is triggered for it in this scenario — e.g. it arrived just before focus).
  events.push(fakeEvent({ id: '$b', sender: '@a:hs', body: 'yo' }));

  vi.spyOn(document, 'hasFocus').mockReturnValue(true); // user returns
  window.dispatchEvent(new Event('focus')); // → onFocus → markRead(live timeline)

  expect(received.map((e) => e.getId())).toEqual(['$b']); // targets the newer event
});

it('holds the read receipt while locked and sends it after unlock', () => {
  const attentive = signal(false);
  const received: { getId: () => string }[] = [];
  const events = [fakeEvent({ id: '$a', sender: '@a:hs', body: 'hi' })];
  const room = fakeRoom(events);
  const client = clientFor(room, {
    sendReadReceipt: (e: { getId: () => string }) => {
      received.push(e);
      return Promise.resolve({});
    },
  });
  openTimeline(client, [
    {
      provide: CONVERSATION_ATTENTION,
      useValue: { attentive: attentive.asReadonly() },
    },
  ]);
  TestBed.tick();
  expect(received).toHaveLength(0); // focused, but locked: nobody is looking

  attentive.set(true); // unlocked
  TestBed.tick();
  expect(received.map((e) => e.getId())).toEqual(['$a']);
});

describe('while App lock covers the app', () => {
  /**
   * Rooms (id → first event id) whose live timelines grow on demand, a client that
   * records every receipt it is asked to send, and the attention port App lock drives.
   * With `hold`, each receipt stays in flight until the test releases it.
   */
  function covered(
    rooms: Record<string, string>,
    options: { attentive: boolean; hold?: boolean },
  ) {
    const attentive = signal(options.attentive);
    const received: string[] = [];
    const releases: (() => void)[] = [];
    const live = new Map(
      Object.entries(rooms).map(([roomId, firstId]) => {
        const events = [
          fakeEvent({ id: firstId, sender: '@a:hs', body: 'hi' }),
        ];
        const listeners = new Map<string, () => void>();
        const room = {
          ...fakeRoom(events),
          roomId,
          on: (name: string, listener: () => void) =>
            listeners.set(name, listener),
        };
        return [roomId, { room, events, listeners }] as const;
      }),
    );
    const client = clientFor(fakeRoom([]), {
      getRoom: (roomId: string) => live.get(roomId)?.room ?? null,
      sendReadReceipt: (e: { getId: () => string }) => {
        received.push(e.getId());
        return options.hold
          ? new Promise((resolve) => releases.push(() => resolve({})))
          : Promise.resolve({});
      },
      scrollback: (room: unknown) => Promise.resolve(room),
    });
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        matrixProvider(client),
        {
          provide: CONVERSATION_ATTENTION,
          useValue: { attentive: attentive.asReadonly() },
        },
      ],
    });
    const svc = TestBed.inject(TimelineService);
    /** A message arrives live in an open room; the SDK's Timeline event re-projects it. */
    const arrive = async (roomId: string, id: string): Promise<void> => {
      const entry = live.get(roomId);
      entry?.events.push(fakeEvent({ id, sender: '@a:hs', body: 'new' }));
      entry?.listeners.get(RoomEvent.Timeline)?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const settle = (): Promise<void> =>
      new Promise((resolve) => setTimeout(resolve, 0));
    return { svc, attentive, received, releases, arrive, settle };
  }

  it('keeps messages that arrive behind the cover unread, and acks the newest on unlock', async () => {
    const { svc, attentive, received, arrive } = covered(
      { '!r:hs': '$a1' },
      { attentive: true },
    );
    svc.open('!r:hs');
    TestBed.tick();
    expect(received).toEqual(['$a1']); // looking: read as it opens

    attentive.set(false); // locked, with the room still open behind the cover
    TestBed.tick();
    await arrive('!r:hs', '$a2');
    await arrive('!r:hs', '$a3');
    expect(received).toEqual(['$a1']);

    attentive.set(true);
    TestBed.tick();
    expect(received).toEqual(['$a1', '$a3']);
  });

  it('waits for window focus after an unlock in the background', () => {
    vi.spyOn(document, 'hasFocus').mockReturnValue(false);
    const { svc, attentive, received } = covered(
      { '!r:hs': '$a1' },
      { attentive: false },
    );
    svc.open('!r:hs');
    TestBed.tick();

    // Focus alone is not enough: the cover still hides the room.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    expect(received).toEqual([]);

    vi.spyOn(document, 'hasFocus').mockReturnValue(false); // the person switches away
    attentive.set(true); // unlocked, but the window is behind another app
    TestBed.tick();
    expect(received).toEqual([]);

    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    window.dispatchEvent(new Event('focus'));
    expect(received).toEqual(['$a1']);
  });

  it('waits for the conversation to be visible after an unlock', () => {
    const { svc, attentive, received } = covered(
      { '!r:hs': '$a1' },
      { attentive: false },
    );
    svc.open('!r:hs');
    svc.setVisible(false);
    TestBed.tick();

    attentive.set(true);
    TestBed.tick();
    expect(received).toEqual([]);

    svc.setVisible(true);
    expect(received).toEqual(['$a1']);
  });

  it('lets a receipt sent before the lock finish, but holds what arrives after it', async () => {
    const { svc, attentive, received, releases, arrive, settle } = covered(
      { '!r:hs': '$a1' },
      { attentive: true, hold: true },
    );
    svc.open('!r:hs');
    TestBed.tick();
    expect(received).toEqual(['$a1']); // in flight

    attentive.set(false);
    TestBed.tick();
    await arrive('!r:hs', '$a2');
    releases.shift()?.(); // the earlier receipt lands while locked
    await settle();
    await arrive('!r:hs', '$a3');
    expect(received).toEqual(['$a1']);

    attentive.set(true);
    TestBed.tick();
    expect(received).toEqual(['$a1', '$a3']);
  });

  it('does not mark a room selected while locked read until unlock', () => {
    const { svc, attentive, received } = covered(
      { '!a:hs': '$a1', '!b:hs': '$b1' },
      { attentive: true },
    );
    svc.open('!a:hs');
    TestBed.tick();
    expect(received).toEqual(['$a1']);

    attentive.set(false);
    TestBed.tick();
    svc.open('!b:hs');
    TestBed.tick();
    expect(received).toEqual(['$a1']);

    attentive.set(true);
    TestBed.tick();
    expect(received).toEqual(['$a1', '$b1']);
  });
});
