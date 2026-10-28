import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineService } from './timeline.service';
import { TYPING_REFRESH_MS, TYPING_TIMEOUT_MS } from '@trinity/util/matrix';
import {
  fakeClient,
  fakeMember,
  fakeRoom,
  matrixProvider,
  mediaProvider,
  privacyProvider,
  switchableMatrixProvider,
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

describe('typing', () => {
  /** Open a room with the given members and return handles for typing assertions. */
  function setupTyping(members: ReturnType<typeof fakeMember>[] = []) {
    const sent: unknown[][] = [];
    const room = fakeRoom([], {}, false, members);
    const client = fakeClient(room, sent);
    TestBed.configureTestingModule({
      providers: [TimelineService, matrixProvider(client), mediaProvider()],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    return { svc, client, sent };
  }

  /** Only the typing calls the client recorded, in order. */
  const typingCalls = (sent: unknown[][]) =>
    sent.filter((call) => call[0] === 'typing');

  it('broadcasts a typing notification when the composer reports typing', () => {
    const { svc, sent } = setupTyping();
    svc.setTyping(true);
    expect(typingCalls(sent)).toEqual([['typing', true, TYPING_TIMEOUT_MS]]);
  });

  it('throttles repeated starts, then refreshes once the interval elapses', () => {
    let now = 1000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const { svc, sent } = setupTyping();

    svc.setTyping(true);
    svc.setTyping(true); // still within the refresh window → no second request
    expect(typingCalls(sent)).toEqual([['typing', true, TYPING_TIMEOUT_MS]]);

    now += TYPING_REFRESH_MS + 1; // window elapsed → one refresh allowed
    svc.setTyping(true);
    expect(typingCalls(sent)).toEqual([
      ['typing', true, TYPING_TIMEOUT_MS],
      ['typing', true, TYPING_TIMEOUT_MS],
    ]);
  });

  it('stops typing only when currently marked as typing', () => {
    const { svc, sent } = setupTyping();

    svc.setTyping(false); // never started → nothing to clear
    expect(typingCalls(sent)).toEqual([]);

    svc.setTyping(true);
    svc.setTyping(false);
    expect(typingCalls(sent)).toEqual([
      ['typing', true, TYPING_TIMEOUT_MS],
      ['typing', false, 0],
    ]);
  });

  it('stops typing when the room closes', () => {
    const { svc, sent } = setupTyping();
    svc.setTyping(true);
    svc.close();
    expect(typingCalls(sent)).toContainEqual(['typing', false, 0]);
  });

  // Both halves of the bookkeeping `stopTypingOnConnectedClient` shares with `setTyping`.
  // Without the first, a close sends a stop we never started; without the second, the flag
  // survives into the next room and its first real keystroke is swallowed as a duplicate.
  it('sends nothing when the room closes without anyone having typed', () => {
    const { svc, sent } = setupTyping();

    svc.close();

    expect(typingCalls(sent)).toEqual([]);
  });

  it('clears the typing flag on close, so the next room can start again', () => {
    const { svc, sent } = setupTyping();
    svc.setTyping(true);
    svc.close();

    svc.open('!other:hs');
    svc.setTyping(true);

    expect(typingCalls(sent)).toEqual([
      ['typing', true, TYPING_TIMEOUT_MS],
      ['typing', false, 0],
      ['typing', true, TYPING_TIMEOUT_MS],
    ]);
  });

  // Closing is DEFERRED now: it follows the URL through the shell's projection effect,
  // so an account switch has already flipped the active client by the time close() runs.
  // The stop has to go to the account that started typing — the outgoing one — or that
  // account stays marked typing for the server's whole timeout while the incoming one
  // PUTs typing into a room it may not even be in.
  it('keeps the room marked typing while another composer still holds a draft', () => {
    // One flag per room, two composers feeding it. Sending in the thread used to clear it
    // while the main composer still had text, and nothing re-announced until the next
    // keystroke — an unbounded window, not TYPING_TIMEOUT_MS.
    const { svc, sent } = setupTyping();
    svc.setTyping(true, 'room');
    svc.setTyping(true, 'thread');

    svc.setTyping(false, 'thread');

    expect(typingCalls(sent)).toEqual([['typing', true, TYPING_TIMEOUT_MS]]);
  });

  it('stops once the last composer goes quiet', () => {
    // The other half: owner-keying must not swallow the stop altogether.
    const { svc, sent } = setupTyping();
    svc.setTyping(true, 'room');
    svc.setTyping(true, 'thread');

    svc.setTyping(false, 'thread');
    svc.setTyping(false, 'room');

    expect(typingCalls(sent)).toEqual([
      ['typing', true, TYPING_TIMEOUT_MS],
      ['typing', false, 0],
    ]);
  });

  it('defaults an untagged report to the room composer', () => {
    // MessageActionsService calls setTyping(boolean) with no owner; that has to keep
    // behaving exactly as it did.
    const { svc, sent } = setupTyping();
    svc.setTyping(true);
    svc.setTyping(false);

    expect(typingCalls(sent)).toEqual([
      ['typing', true, TYPING_TIMEOUT_MS],
      ['typing', false, 0],
    ]);
  });

  it('sends the closing typing-stop to the account that was typing', () => {
    const outgoingSent: unknown[][] = [];
    const incomingSent: unknown[][] = [];
    const room = fakeRoom([], {}, false, []);
    const outgoing = fakeClient(room, outgoingSent);
    const incoming = fakeClient(room, incomingSent);
    const active = { client: outgoing as unknown };
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        switchableMatrixProvider(active),
        mediaProvider(),
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    svc.setTyping(true);

    active.client = incoming; // the switch lands before the deferred close
    svc.close();

    expect(typingCalls(outgoingSent)).toContainEqual(['typing', false, 0]);
    expect(typingCalls(incomingSent)).toEqual([]);
  });

  it('clears local typing ownership when the final account signs out', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000);
    const outgoingSent: unknown[][] = [];
    const incomingSent: unknown[][] = [];
    const room = fakeRoom([], {}, false, []);
    const outgoing = fakeClient(room, outgoingSent);
    const incoming = fakeClient(room, incomingSent);
    const active = {
      client: outgoing as unknown,
      isInitialized: true,
    };
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        switchableMatrixProvider(active),
        mediaProvider(),
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    svc.setTyping(true, 'thread');

    active.isInitialized = false;
    svc.close();

    active.client = incoming;
    active.isInitialized = true;
    svc.open('!r:hs');
    svc.setTyping(true, 'room');
    svc.setTyping(false, 'room');

    expect(typingCalls(outgoingSent)).toEqual([
      ['typing', true, TYPING_TIMEOUT_MS],
    ]);
    expect(typingCalls(incomingSent)).toEqual([
      ['typing', true, TYPING_TIMEOUT_MS],
      ['typing', false, 0],
    ]);
  });

  it('projects other typing members into typingNames, excluding self', () => {
    const { svc, client } = setupTyping([
      fakeMember('@alice:hs', true, 'Alice'),
      fakeMember('@me:hs', true, 'Me'), // the local user never lists themselves
      fakeMember('@bob:hs', false, 'Bob'), // present but not typing
    ]);

    // Fire the RoomMember.typing listener the service registered in open().
    client.handlers.get('RoomMember.typing')?.(
      {},
      fakeMember('@alice:hs', true, 'Alice'),
    );

    expect(svc.typingNames()).toEqual(['Alice']);
  });

  it('ignores typing changes from other rooms', () => {
    const { svc, client } = setupTyping([fakeMember('@alice:hs', true)]);
    client.handlers.get('RoomMember.typing')?.(
      {},
      { userId: '@x:hs', typing: true, name: 'X', roomId: '!other:hs' },
    );
    expect(svc.typingNames()).toEqual([]);
  });
});
