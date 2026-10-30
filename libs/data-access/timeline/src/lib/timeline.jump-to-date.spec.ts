import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { Direction } from 'matrix-js-sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fakeClient,
  fakeEvent,
  fakeRoom,
  mediaProvider,
  openTimeline,
  privacyProvider,
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

/**
 * Jump to date. The interesting half is not `timestampToEvent` — it is that the server
 * answers for the whole room and happily names an event this client has never loaded, so
 * scrolling to it would silently do nothing without the bounded backfill.
 */
describe('TimelineService.jumpToDate', () => {
  /**
   * A room whose live timeline starts with `loaded` events and grows by `pageSize` each
   * time `scrollback` is called, until `total` events exist. `target` is only findable
   * once it has actually been paged in — which is what makes the loop observable.
   */
  function pagingSetup(opts: {
    loaded: number;
    total: number;
    targetIndex: number;
    timestampToEvent?: () => Promise<{ event_id: string }>;
    pageSize?: number;
  }) {
    const pageSize = opts.pageSize ?? 30;
    // Increasing timestamps: event i sits at (i + 1) * 1000, so a "day start" of
    // (targetIndex + 1) * 1000 selects exactly that event and everything after it.
    const all = Array.from({ length: opts.total }, (_, i) =>
      fakeEvent({
        id: `$e${i}`,
        sender: '@alice:hs',
        body: `m${i}`,
        ts: (i + 1) * 1000,
      }),
    );
    // The live timeline holds the NEWEST `loaded` events; scrollback prepends older ones.
    let shown = all.slice(opts.total - opts.loaded);
    // One live timeline object, as the SDK keeps until a reset.
    const live = {
      getEvents: () => shown,
      getPaginationToken: () => 'tok',
      getState: () => ({ hasSufficientPowerLevelFor: () => false }),
    };
    const room = {
      ...fakeRoom([]),
      getLiveTimeline: () => live,
      findEventById: (id: string) => shown.find((e) => e.getId() === id),
    };
    let scrollbacks = 0;
    const asked: { roomId: string; timestamp: number; dir: Direction }[] = [];
    const client = {
      ...fakeClient(room as never, []),
      getRoom: () => room,
      scrollback: () => {
        scrollbacks++;
        const next = Math.min(shown.length + pageSize, all.length);
        shown = all.slice(all.length - next);
        return Promise.resolve(room);
      },
      timestampToEvent: (roomId: string, timestamp: number, dir: Direction) => {
        asked.push({ roomId, timestamp, dir });
        return (
          opts.timestampToEvent?.() ??
          Promise.resolve({ event_id: `$e${opts.targetIndex}` })
        );
      },
    };
    const svc = openTimeline(client, [mediaProvider()]);
    return { svc, scrollbacks: () => scrollbacks, asked };
  }

  it('returns the event straight away when it is already loaded', async () => {
    const { svc, scrollbacks } = pagingSetup({
      loaded: 50,
      total: 50,
      targetIndex: 40,
    });

    const result = await firstValueFrom(svc.jumpToDate(41_000));

    expect(result).toEqual({ kind: 'found', eventId: '$e40' });
    // No paging at all: the common case (a recent date) must not cost a round trip.
    expect(scrollbacks()).toBe(0);
  });

  it('pages history back until the target is loaded', async () => {
    const { svc, scrollbacks } = pagingSetup({
      loaded: 10,
      total: 100,
      targetIndex: 5, // 95 events older than the loaded window
    });

    const result = await firstValueFrom(svc.jumpToDate(6_000));

    expect(result).toEqual({ kind: 'found', eventId: '$e5' });
    // Without the loop this is where "jump to date" silently does nothing: the id is
    // real, the DOM has never seen it, and scrollIntoView finds no element.
    expect(scrollbacks()).toBeGreaterThan(0);
  });

  it('loadEvent pages history back until a pinned or searched event is loaded', async () => {
    const { svc, scrollbacks } = pagingSetup({
      loaded: 10,
      total: 100,
      targetIndex: 5,
    });

    expect(await firstValueFrom(svc.loadEvent('$e5'))).toBe(true);
    expect(scrollbacks()).toBeGreaterThan(0);
  });

  it('loadEvent costs no request when the event is already loaded', async () => {
    const { svc, scrollbacks } = pagingSetup({
      loaded: 50,
      total: 50,
      targetIndex: 40,
    });

    expect(await firstValueFrom(svc.loadEvent('$e40'))).toBe(true);
    expect(scrollbacks()).toBe(0);
  });

  it('loadEvent reports false when the event is beyond the bounded scrollback', async () => {
    const { svc, scrollbacks } = pagingSetup({
      loaded: 10,
      total: 5000,
      targetIndex: 0,
    });

    expect(await firstValueFrom(svc.loadEvent('$e0'))).toBe(false);
    expect(scrollbacks()).toBe(20);
  });

  it('asks for the first event AFTER midnight, not the last one before it', async () => {
    const { svc, asked } = pagingSetup({
      loaded: 50,
      total: 50,
      targetIndex: 40,
    });
    const midnight = 1_700_000_000_000;

    await firstValueFrom(svc.jumpToDate(midnight));

    // Direction decides which day you land on. Backward returns the last event BEFORE the
    // timestamp — i.e. the tail of the previous day — for any date whose own messages all
    // sit later than midnight, which is every date.
    expect(asked).toEqual([
      { roomId: '!r:hs', timestamp: midnight, dir: Direction.Forward },
    ]);
  });

  it('gives up rather than paging a huge room to its start', async () => {
    // 20 pages x 30 = 600; the target sits beyond that.
    const { svc, scrollbacks } = pagingSetup({
      loaded: 10,
      total: 5000,
      targetIndex: 0,
    });

    const result = await firstValueFrom(svc.jumpToDate(1_000));

    expect(result).toEqual({ kind: 'too-far' });
    expect(scrollbacks()).toBe(20);
  });

  it('stops early when the room has no more history', async () => {
    // The target id is not in the room at all, and the room is shorter than the bound —
    // without the "did the timeline actually grow?" check this burns all 20 pages on
    // requests that return nothing.
    const { svc, scrollbacks } = pagingSetup({
      loaded: 10,
      total: 40,
      targetIndex: 0,
      timestampToEvent: () => Promise.resolve({ event_id: '$missing' }),
    });

    const result = await firstValueFrom(svc.jumpToDate(1000));

    expect(result).toEqual({ kind: 'too-far' });
    expect(scrollbacks()).toBeLessThan(20);
  });

  it('reports a server that does not implement the endpoint', async () => {
    const { svc } = pagingSetup({
      loaded: 10,
      total: 10,
      targetIndex: 0,
      timestampToEvent: () =>
        Promise.reject(
          Object.assign(new Error('nope'), {
            errcode: 'M_UNRECOGNIZED',
          }),
        ),
    });

    // Distinguished from "no event": there is nothing the user can do about this one, and
    // telling them the date is empty would be a lie.
    expect(await firstValueFrom(svc.jumpToDate(1000))).toEqual({
      kind: 'unsupported',
    });
  });

  it('does not call a network failure "no messages that day"', async () => {
    const { svc } = pagingSetup({
      loaded: 10,
      total: 10,
      targetIndex: 0,
      timestampToEvent: () => Promise.reject(new Error('offline')),
    });

    // A ConnectionError carries no errcode. Saying "no messages on or after that date"
    // here tells someone on a captive portal that a day they spent chatting was empty —
    // a claim about the room, made from a failure to ask.
    expect(await firstValueFrom(svc.jumpToDate(1000))).toEqual({
      kind: 'failed',
    });
  });

  it('does not call a rate limit "no messages that day" either', async () => {
    // Plausible precisely because of this feature: up to 20 scrollbacks in a burst.
    const { svc } = pagingSetup({
      loaded: 10,
      total: 10,
      targetIndex: 0,
      timestampToEvent: () =>
        Promise.reject(
          Object.assign(new Error('slow down'), {
            errcode: 'M_LIMIT_EXCEEDED',
          }),
        ),
    });

    expect(await firstValueFrom(svc.jumpToDate(1000))).toEqual({
      kind: 'failed',
    });
  });

  it('stops paginating when the user leaves the room mid-backfill', async () => {
    const { svc, scrollbacks } = pagingSetup({
      loaded: 10,
      total: 5000,
      targetIndex: 0,
    });

    const result = firstValueFrom(svc.jumpToDate(1000));
    svc.close(); // the user clicks another room while the loop is in flight

    expect(await result).toEqual({ kind: 'too-far' });
    // It must not keep paging a room nobody is looking at, and it must not leave the flag
    // set — the next room's viewport-fill loop bails while it is true.
    expect(scrollbacks()).toBeLessThan(20);
    expect(svc.loadingOlder()).toBe(false);
  });

  it('reports a date the room has nothing at or after', async () => {
    const { svc } = pagingSetup({
      loaded: 10,
      total: 10,
      targetIndex: 0,
      timestampToEvent: () =>
        Promise.reject(
          Object.assign(new Error('none'), {
            errcode: 'M_NOT_FOUND',
          }),
        ),
    });

    expect(await firstValueFrom(svc.jumpToDate(1000))).toEqual({
      kind: 'no-event',
    });
  });

  it('does not claim success for an event the timeline will never render', async () => {
    // `findEventById` answers for the RAW event, but the projection only keeps
    // m.room.message (and displayable state). If the first event on the chosen day is a
    // reaction, an edit, or a hidden system line, the raw id is findable and the message
    // list has nothing carrying it — so reporting `found` produces a jump to an id that is
    // not in `messages()`: the dialog closes, nothing scrolls, and no toast explains why.
    const reaction = fakeEvent({ id: '$react', sender: '@alice:hs', body: '' });
    reaction.getType = () => 'm.reaction';
    const shown = [
      reaction,
      fakeEvent({
        id: '$real',
        sender: '@alice:hs',
        body: 'the actual message',
      }),
    ];
    const room = {
      ...fakeRoom([]),
      getLiveTimeline: () => ({
        getEvents: () => shown,
        getPaginationToken: () => null,
        getState: () => ({ hasSufficientPowerLevelFor: () => false }),
      }),
      findEventById: (id: string) => shown.find((e) => e.getId() === id),
    };
    const client = {
      ...fakeClient(room as never, []),
      getRoom: () => room,
      scrollback: () => Promise.resolve(room),
      timestampToEvent: () => Promise.resolve({ event_id: '$react' }),
    };
    const svc = openTimeline(client, [mediaProvider()]);

    const result = await firstValueFrom(svc.jumpToDate(0));

    // Whatever it answers, it must name something the list can actually scroll to.
    if (result.kind === 'found') {
      expect(svc.messages().map((m) => m.id)).toContain(result.eventId);
    }
  });

  it('clears the loading flag whether it succeeds or fails', async () => {
    const { svc } = pagingSetup({ loaded: 10, total: 100, targetIndex: 5 });

    await firstValueFrom(svc.jumpToDate(1000));

    // Shared with loadOlder: a stuck flag disables pagination for the room's lifetime.
    expect(svc.loadingOlder()).toBe(false);
  });
});
