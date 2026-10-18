import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineService } from './timeline.service';
import {
  fakeClient,
  fakeEvent,
  fakeRoom,
  matrixProvider,
  mediaProvider,
  privacyProvider,
} from './timeline.spec-harness';

// The fake clients here model one page of history as `client.scrollback`. The real paging
// (and its race with gappy syncs) is covered against the SDK in live-scrollback.spec.
vi.mock('./live-scrollback', () => ({
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

describe('unread divider', () => {
  /** Open a room whose fully-read marker sits at `fullyReadEventId`. */
  function setupUnread(
    events: ReturnType<typeof fakeEvent>[],
    fullyReadEventId: string | null,
  ) {
    const room = fakeRoom(events, {}, false, [], fullyReadEventId);
    const client = fakeClient(room, []);
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client), mediaProvider()],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    return { svc, client };
  }

  const msgs = [
    fakeEvent({ id: '$1', sender: '@alice:hs', body: 'a' }),
    fakeEvent({ id: '$2', sender: '@alice:hs', body: 'b' }),
    fakeEvent({ id: '$3', sender: '@alice:hs', body: 'c' }),
  ];

  it('points at the first message after the read marker', () => {
    const { svc } = setupUnread(msgs, '$1');
    expect(svc.firstUnreadId()).toBe('$2');
  });

  it('is null when the marker is the newest message', () => {
    const { svc } = setupUnread(msgs, '$3');
    expect(svc.firstUnreadId()).toBeNull();
  });

  it('is null when there is no read marker', () => {
    const { svc } = setupUnread(msgs, null);
    expect(svc.firstUnreadId()).toBeNull();
  });

  it('is null when the marker is not among the loaded messages', () => {
    const { svc } = setupUnread(msgs, '$missing');
    expect(svc.firstUnreadId()).toBeNull();
  });

  it('skips the user’s own messages after the marker', () => {
    const { svc } = setupUnread(
      [
        fakeEvent({ id: '$1', sender: '@alice:hs', body: 'a' }),
        fakeEvent({ id: '$2', sender: '@me:hs', body: 'mine' }),
        fakeEvent({ id: '$3', sender: '@alice:hs', body: 'theirs' }),
      ],
      '$1',
    );
    expect(svc.firstUnreadId()).toBe('$3');
  });

  const joinEvent = () =>
    fakeEvent({
      id: '$e',
      sender: '@alice:hs',
      type: 'm.room.member',
      stateKey: '@bob:hs',
      content: { membership: 'join' },
    });

  it('anchors on the next message, skipping a system line after the marker', () => {
    const { svc } = setupUnread(
      [
        fakeEvent({ id: '$1', sender: '@alice:hs', body: 'a' }),
        joinEvent(),
        fakeEvent({ id: '$3', sender: '@alice:hs', body: 'theirs' }),
      ],
      '$1',
    );
    expect(svc.firstUnreadId()).toBe('$3');
  });

  it('is null when only system (membership) churn followed the marker', () => {
    const { svc } = setupUnread(
      [fakeEvent({ id: '$1', sender: '@alice:hs', body: 'a' }), joinEvent()],
      '$1',
    );
    expect(svc.firstUnreadId()).toBeNull();
  });

  it('stays put as the room is read (marker captured on open)', () => {
    const { svc } = setupUnread(msgs, '$1');
    // markRead ran on open and advanced the server marker, but the divider anchor
    // was captured beforehand, so it still points at $2.
    expect(svc.firstUnreadId()).toBe('$2');
  });

  it('advances the persisted fully-read marker when marking read', () => {
    const { client } = setupUnread(msgs, '$1');
    expect(client.setRoomReadMarkers).toHaveBeenCalledWith('!r:hs', '$3');
  });

  it('clears the divider when the room closes', () => {
    const { svc } = setupUnread(msgs, '$1');
    svc.close();
    expect(svc.firstUnreadId()).toBeNull();
  });
});

describe('trimming the open room (#1366)', () => {
  function open(fullyReadEventId: string | null = '$1') {
    const room = fakeRoom(
      [
        fakeEvent({ id: '$1', sender: '@alice:hs', body: 'a' }),
        fakeEvent({
          id: '$2',
          sender: '@alice:hs',
          body: 'b',
          replyTo: '$old',
        }),
        fakeEvent({
          id: '$3',
          sender: '@alice:hs',
          body: 'c',
          replyTo: '$1',
        }),
      ],
      {},
      false,
      [],
      fullyReadEventId,
    );
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        matrixProvider(fakeClient(room, [])),
        mediaProvider(),
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    return svc;
  }

  it('keeps what a view at the newest message shows, the messages it quotes, and where its divider was drawn', () => {
    const svc = open();

    svc.setLiveView('$2');

    // Quoted messages and the divider's place are kept like the read receipt: below the
    // ceiling only.
    expect(svc.liveTrimGuard()).toEqual({
      marked: ['$1', '$old', '$1'],
      kept: ['$2'],
    });
  });

  it('allows no trim while older history is being paged in', async () => {
    const svc = open();
    svc.setLiveView('$2');

    const paging = firstValueFrom(svc.loadOlder());
    expect(svc.liveTrimGuard()).toBeNull();

    await paging;
    expect(svc.liveTrimGuard()).not.toBeNull();
  });

  it('allows no trim while the view is scrolled back or has not reported', () => {
    const svc = open();
    expect(svc.liveTrimGuard()).toBeNull();

    svc.setLiveView('$2');
    svc.setLiveView(null);

    expect(svc.liveTrimGuard()).toBeNull();
  });

  it('allows no trim when what the view shows is not in the live timeline', () => {
    const svc = open();

    svc.setLiveView('$other-room');

    expect(svc.liveTrimGuard()).toBeNull();
  });

  it('forgets the view when the Conversation is hidden, shown again or closed', () => {
    const svc = open();
    svc.setLiveView('$2');
    svc.setVisible(false);
    expect(svc.liveTrimGuard()).toBeNull();

    svc.setLiveView('$2');
    expect(svc.liveTrimGuard()).toBeNull();
    svc.setVisible(true);
    expect(svc.liveTrimGuard()).toBeNull();

    svc.setLiveView('$2');
    svc.close();
    expect(svc.liveTrimGuard()).toBeNull();
  });
});

describe('paging a rewound room back in', () => {
  /** A room with `history` messages whose live timeline was rewound to empty after opening. */
  function rewound(history: number) {
    const all = Array.from({ length: history }, (_, i) =>
      fakeEvent({ id: `$${i + 1}`, sender: '@alice:hs', body: `${i + 1}` }),
    );
    const events = all.slice(-5);
    const room = fakeRoom(events);
    const client = fakeClient(room, []);
    const scrollback = vi.fn(async () => {
      const end = history - events.length;
      events.unshift(...all.slice(Math.max(0, end - 30), end));
      return room;
    });
    client.scrollback = scrollback;
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client), mediaProvider()],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    events.length = 0;
    return { svc, scrollback };
  }

  it('shows the open room rewound at once, then pages it back to about its depth', async () => {
    const { svc, scrollback } = rewound(100);

    const refilled = firstValueFrom(svc.refill(50));
    expect(svc.messages()).toEqual([]);
    expect(svc.loadingOlder()).toBe(true);
    await refilled;

    expect(scrollback).toHaveBeenCalledTimes(2);
    expect(svc.messages().map((message) => message.id)).toEqual(
      Array.from({ length: 60 }, (_, i) => `$${i + 41}`),
    );
    expect(svc.loadingOlder()).toBe(false);
  });

  it('pages one page back in while the Conversation is retained', async () => {
    const { svc, scrollback } = rewound(100);
    svc.setVisible(false);

    await firstValueFrom(svc.refill(50));

    expect(scrollback).toHaveBeenCalledOnce();
    expect(svc.messages()).toHaveLength(30);
  });
});
