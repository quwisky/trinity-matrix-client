import {
  ConnectionError,
  EventStatus,
  MatrixError,
  MatrixEvent,
  type MatrixClient,
} from 'matrix-js-sdk';
import { describe, expect, it, vi } from 'vitest';
import { resendWaitingEchoes } from './outgoing-work';

function waiting(body: string): MatrixEvent {
  const event = new MatrixEvent({
    type: 'm.room.message',
    content: { msgtype: 'm.text', body },
  });
  event.status = EventStatus.NOT_SENT;
  event.error = new ConnectionError('offline') as never;
  return event;
}

/** A room; `inFlight` stands in for the SDK's `txnToEvent`, the only list of a thread echo. */
function room(
  roomId: string,
  events: MatrixEvent[],
  inFlight: MatrixEvent[] = [],
) {
  return {
    roomId,
    txnToEvent: new Map(inFlight.map((event, i) => [`txn${i}`, event])),
    getLiveTimeline: () => ({ getEvents: () => events }),
    getThreads: () => [],
  };
}

function client(
  rooms: ReturnType<typeof room>[],
  resendEvent: (event: MatrixEvent) => Promise<unknown>,
) {
  return {
    getRooms: () => rooms,
    resendEvent: vi.fn(resendEvent),
  };
}

const run = (fake: ReturnType<typeof client>, live = () => true) =>
  resendWaitingEchoes(fake as unknown as MatrixClient, live);

describe('resendWaitingEchoes', () => {
  it('skips a cancelled echo', async () => {
    const echo = waiting('gone');
    const fake = client([room('!r:hs', [echo])], () => Promise.resolve());
    echo.status = EventStatus.CANCELLED;

    await run(fake);

    expect(fake.resendEvent).not.toHaveBeenCalled();
  });

  it("resends a room's echoes in timeline order, one at a time", async () => {
    const first = waiting('one');
    const second = waiting('two');
    let release!: () => void;
    const fake = client([room('!r:hs', [first, second])], (event) =>
      event === first
        ? new Promise<void>((resolve) => (release = resolve))
        : Promise.resolve(),
    );

    const done = run(fake);
    await Promise.resolve();
    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
    ]);

    release();
    await done;
    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
      second,
    ]);
  });

  it('skips an echo whose status changed before its turn', async () => {
    const first = waiting('one');
    const second = waiting('two');
    const fake = client([room('!r:hs', [first, second])], async (event) => {
      // A manual Retry of the second one won the race while the first was sending.
      if (event === first) second.status = EventStatus.SENDING;
    });

    await run(fake);

    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
    ]);
  });

  it('an echo that fails again with ConnectionError stays waiting for the next reconnect', async () => {
    const [first, second, third] = ['one', 'two', 'three'].map(waiting);
    const other = waiting('elsewhere');
    const fake = client(
      [room('!r:hs', [first, second, third]), room('!o:hs', [other])],
      async (event) => {
        if (event === first) throw new ConnectionError('offline again');
      },
    );

    await expect(run(fake)).resolves.toBeUndefined();

    // The rest of the room waits behind it, so its order holds.
    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
      other,
    ]);
    expect(first.status).toBe(EventStatus.NOT_SENT);
  });

  it("ends a room's pass at a rate limit, leaving other rooms going", async () => {
    const [first, second] = ['one', 'two'].map(waiting);
    const other = waiting('elsewhere');
    const fake = client(
      [room('!r:hs', [first, second]), room('!o:hs', [other])],
      async (event) => {
        if (event === first) {
          throw new MatrixError({ errcode: 'M_LIMIT_EXCEEDED' }, 429);
        }
      },
    );

    await expect(run(fake)).resolves.toBeUndefined();

    // The next sync tick picks the room up again, in order.
    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
      other,
    ]);
  });

  it('carries on past an echo the server refuses', async () => {
    const first = waiting('one');
    const second = waiting('two');
    const fake = client([room('!r:hs', [first, second])], async (event) => {
      if (event === first)
        throw new MatrixError({ errcode: 'M_FORBIDDEN' }, 403);
    });

    await run(fake);

    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
      second,
    ]);
  });

  it('stops once the account is no longer live', async () => {
    const first = waiting('one');
    const second = waiting('two');
    let live = true;
    const fake = client([room('!r:hs', [first, second])], async () => {
      live = false;
    });

    await run(fake, () => live);

    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
    ]);
  });

  it('resends a thread echo that only the in-flight map lists, in send order', async () => {
    const main = waiting('main');
    const reply = waiting('in a thread');
    const fake = client(
      [room('!r:hs', [main], [main, reply])],
      async () => undefined,
    );

    await run(fake);

    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      main,
      reply,
    ]);
  });

  it('resends each room independently', async () => {
    const a = waiting('a');
    const b = waiting('b');
    const fake = client(
      [room('!a:hs', [a]), room('!b:hs', [b])],
      () => new Promise<void>(() => undefined),
    );

    void run(fake);
    await Promise.resolve();

    expect(fake.resendEvent).toHaveBeenCalledTimes(2);
  });
});
