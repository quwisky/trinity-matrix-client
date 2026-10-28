import {
  Direction,
  MatrixEvent,
  Room,
  createClient,
  type MatrixClient,
  type IRoomEvent,
} from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { scrollbackLive } from './live-scrollback';

type IMessagesResponse = Awaited<
  ReturnType<MatrixClient['createMessagesRequest']>
>;

// A real SDK client and Room: the bug lives in how the SDK's timelines move under a page
// in flight, which a hand-rolled fake would only restate.
function setup() {
  const client = createClient({
    baseUrl: 'https://hs',
    userId: '@me:hs',
    fetchFn: () => Promise.reject(new Error('no network in unit tests')),
  });
  const room = new Room('!r:hs', client, '@me:hs');
  let respond: (res: IMessagesResponse) => void = () => undefined;
  const request = vi
    .spyOn(client, 'createMessagesRequest')
    .mockImplementation(
      () => new Promise<IMessagesResponse>((resolve) => (respond = resolve)),
    );
  // The request goes out asynchronously; answer it only once it has been sent.
  const sent = () => vi.waitFor(() => expect(request).toHaveBeenCalled());
  return {
    client,
    room,
    request,
    sent,
    respond: async (res: IMessagesResponse) => {
      await sent();
      respond(res);
    },
  };
}

function event(id: string): IRoomEvent {
  return {
    event_id: id,
    room_id: '!r:hs',
    type: 'm.room.message',
    sender: '@a:hs',
    origin_server_ts: 1,
    content: { msgtype: 'm.text', body: id },
    unsigned: {},
  };
}

const ids = (room: Room) =>
  room
    .getLiveTimeline()
    .getEvents()
    .map((e) => e.getId());

describe('scrollbackLive', () => {
  it('prepends a page to the live timeline and moves its back token on', async () => {
    const { client, room, request, respond } = setup();
    room.getLiveTimeline().setPaginationToken('t3', Direction.Backward);
    await room.addLiveEvents([new MatrixEvent(event('$3'))], {
      addToState: false,
    });

    const paged = scrollbackLive(client, room, 30);
    await respond({
      chunk: [event('$2'), event('$1')],
      start: 't3',
      end: 't1',
    });
    await paged;

    expect(request).toHaveBeenCalledWith('!r:hs', 't3', 30, Direction.Backward);
    expect(ids(room)).toEqual(['$1', '$2', '$3']);
    expect(room.getLiveTimeline().getPaginationToken(Direction.Backward)).toBe(
      't1',
    );
  });

  it('marks the start of the room when a page comes back empty', async () => {
    const { client, room, respond } = setup();
    room.getLiveTimeline().setPaginationToken('t1', Direction.Backward);

    const paged = scrollbackLive(client, room, 30);
    await respond({ chunk: [], start: 't1' });
    await paged;

    expect(
      room.getLiveTimeline().getPaginationToken(Direction.Backward),
    ).toBeNull();
  });

  it('does not ask for more once the start of the room is reached', async () => {
    const { client, room, request } = setup();
    room.getLiveTimeline().setPaginationToken(null, Direction.Backward);

    await scrollbackLive(client, room, 30);

    expect(request).not.toHaveBeenCalled();
  });

  // A gappy (`limited`) sync while the page is in flight replaces the live timeline. The
  // page belongs before the OLD timeline's first event, not before the new one's: splicing
  // it in would hide the gap's messages for good and hand the new timeline a back token
  // that skips them.
  it('drops a page that lands after a gappy sync replaced the live timeline', async () => {
    const { client, room, sent, respond } = setup();
    room.getLiveTimeline().setPaginationToken('tOld', Direction.Backward);
    await room.addLiveEvents([new MatrixEvent(event('$5'))], {
      addToState: false,
    });

    const paged = scrollbackLive(client, room, 30);
    await sent();
    room.resetLiveTimeline('tGap');
    await room.addLiveEvents([new MatrixEvent(event('$20'))], {
      addToState: false,
    });
    await respond({
      chunk: [event('$4'), event('$3')],
      start: 'tOld',
      end: 't2',
    });
    await paged;

    expect(ids(room)).toEqual(['$20']);
    expect(room.getLiveTimeline().getPaginationToken(Direction.Backward)).toBe(
      'tGap',
    );
    expect(room.findEventById('$4')).toBeUndefined();
  });
});
