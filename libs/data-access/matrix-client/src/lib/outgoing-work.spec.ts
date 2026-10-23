import {
  ConnectionError,
  EventStatus,
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

function room(roomId: string, events: MatrixEvent[]) {
  return {
    roomId,
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

const run = (fake: ReturnType<typeof client>) =>
  resendWaitingEchoes(fake as unknown as MatrixClient);

describe('resendWaitingEchoes', () => {
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
    const first = waiting('one');
    const second = waiting('two');
    const fake = client([room('!r:hs', [first, second])], async (event) => {
      if (event === first) throw new ConnectionError('offline again');
    });

    await expect(run(fake)).resolves.toBeUndefined();

    expect(fake.resendEvent.mock.calls.map(([event]) => event)).toEqual([
      first,
      second,
    ]);
    expect(first.status).toBe(EventStatus.NOT_SENT);
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
