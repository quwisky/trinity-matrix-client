import {
  FeatureSupport,
  MatrixEvent,
  Room,
  RoomEvent,
  THREAD_RELATION_TYPE,
  Thread,
  createClient,
  type IRoomEvent,
} from 'matrix-js-sdk';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A real SDK client, Room and Thread: the reply count is the SDK's own bookkeeping, and the
// bug is an ordering race inside it that a hand-rolled fake would only restate. The
// thread summary renders `thread.length`, so this count is what users see.

const ROOT = '$root';
const REPLY = '$reply';

function rootEvent(threadCount?: number): IRoomEvent {
  return {
    event_id: ROOT,
    room_id: '!r:hs',
    type: 'm.room.message',
    sender: '@me:hs',
    origin_server_ts: 1,
    content: { msgtype: 'm.text', body: 'root' },
    unsigned:
      threadCount === undefined
        ? {}
        : {
            'm.relations': {
              [THREAD_RELATION_TYPE.name]: {
                count: threadCount,
                current_user_participated: true,
                latest_event: replyEvent(),
              },
            },
          },
  };
}

function replyEvent(id = REPLY): IRoomEvent {
  return {
    event_id: id,
    room_id: '!r:hs',
    type: 'm.room.message',
    sender: '@me:hs',
    origin_server_ts: 2,
    content: {
      msgtype: 'm.text',
      body: 'reply',
      'm.relates_to': {
        rel_type: THREAD_RELATION_TYPE.name,
        event_id: ROOT,
        is_falling_back: true,
        'm.in_reply_to': { event_id: ROOT },
      },
    },
    unsigned: {},
  };
}

afterEach(() => Thread.setServerSideSupport(FeatureSupport.None));

describe('SDK thread reply count', () => {
  it('counts a reply once when the root refetch already includes it', async () => {
    Thread.setServerSideSupport(FeatureSupport.Stable);
    const client = createClient({
      baseUrl: 'https://hs',
      userId: '@me:hs',
      fetchFn: () => Promise.reject(new Error('no network in unit tests')),
    });
    // `threadSupport` is a startClient option; the client is never started here.
    vi.spyOn(client, 'supportsThreads').mockReturnValue(true);
    const room = new Room('!r:hs', client, '@me:hs');
    const root = new MatrixEvent(rootEvent());
    await room.addLiveEvents([root], { addToState: false });

    // The thread is created just before the first send: the root has no replies yet.
    const fetchRoot = vi
      .spyOn(client, 'fetchRoomEvent')
      .mockResolvedValue(rootEvent());
    const thread = room.createThread(ROOT, root, [], false);
    await vi.waitFor(() => expect(thread.initialEventsFetched).toBe(true));

    // The send succeeds and the echo turns "sent". The thread refetches its root, and a
    // fast server already aggregates the reply (count 1) before /sync delivers it.
    fetchRoot.mockResolvedValue(rootEvent(1));
    const echo = new MatrixEvent(replyEvent());
    room.emit(RoomEvent.LocalEchoUpdated, echo, room);
    await vi.waitFor(() => expect(fetchRoot).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(thread.length).toBe(1));

    // /sync then delivers the same reply to the thread timeline.
    await room.addLiveEvents([new MatrixEvent(replyEvent())], {
      addToState: false,
    });

    expect(thread.timeline.map((e) => e.getId())).toEqual([ROOT, REPLY]);
    expect(thread.length).toBe(1);

    // A later reply is still counted.
    await room.addLiveEvents([new MatrixEvent(replyEvent('$next'))], {
      addToState: false,
    });
    expect(thread.length).toBe(2);
  });
});
