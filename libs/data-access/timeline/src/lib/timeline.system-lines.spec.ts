import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelineService } from './timeline.service';
import {
  fakeClient,
  fakeEvent,
  fakeRoom,
  matrixProvider,
  mediaProvider,
  privacyProvider,
  systemLinesProvider,
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

// Issue #21: system lines can be hidden per category from Settings → Appearance. The filter
// runs in the projection, so a hidden line leaves no row at all.
describe('TimelineService system-line filtering', () => {
  /** join, a display-name change, a topic change, and two real messages around them. */
  const churn = () => [
    fakeEvent({ id: '$1', sender: '@alice:hs', body: 'first' }),
    fakeEvent({
      id: '$join',
      sender: '@bob:hs',
      type: 'm.room.member',
      stateKey: '@bob:hs',
      content: { membership: 'join' },
    }),
    fakeEvent({
      id: '$rename',
      sender: '@bob:hs',
      type: 'm.room.member',
      stateKey: '@bob:hs',
      content: { membership: 'join', displayname: 'Bobby' },
      prevContent: { membership: 'join', displayname: 'Bob' },
    }),
    fakeEvent({
      id: '$topic',
      sender: '@mod:hs',
      type: 'm.room.topic',
      stateKey: '',
      content: { topic: 'new topic' },
    }),
    fakeEvent({ id: '$2', sender: '@alice:hs', body: 'second' }),
  ];

  function setupFiltered(shown: Parameters<typeof systemLinesProvider>[0]) {
    const lines = systemLinesProvider(shown);
    const room = fakeRoom(churn(), {}, false, [], null);
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        matrixProvider(fakeClient(room, [])),
        mediaProvider(),
        lines.provider,
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');
    return { svc, lines };
  }

  it('shows every category by default', () => {
    const { svc } = setupFiltered({});
    expect(svc.messages().map((m) => m.id)).toEqual([
      '$1',
      '$join',
      '$rename',
      '$topic',
      '$2',
    ]);
  });

  // Membership and profile are both m.room.member events, so hiding one must not take the
  // other with it — that is the whole point of the granularity.
  it('hides membership lines without hiding profile changes', () => {
    const { svc } = setupFiltered({ membership: false });
    expect(svc.messages().map((m) => m.id)).toEqual([
      '$1',
      '$rename',
      '$topic',
      '$2',
    ]);
  });

  it('hides profile changes without hiding joins', () => {
    const { svc } = setupFiltered({ profile: false });
    expect(svc.messages().map((m) => m.id)).toEqual([
      '$1',
      '$join',
      '$topic',
      '$2',
    ]);
  });

  it('hides room-state changes on their own', () => {
    const { svc } = setupFiltered({ room: false });
    expect(svc.messages().map((m) => m.id)).toEqual([
      '$1',
      '$join',
      '$rename',
      '$2',
    ]);
  });

  it('leaves only real messages when every category is off', () => {
    const { svc } = setupFiltered({
      membership: false,
      profile: false,
      room: false,
    });
    expect(svc.messages().map((m) => m.id)).toEqual(['$1', '$2']);
  });

  it('re-projects the open room when a category is toggled', async () => {
    const { svc, lines } = setupFiltered({});
    expect(svc.messages().map((m) => m.id)).toContain('$join');

    // The effect schedules the refresh onto a microtask (coalescing bursts), so the
    // assertion has to wait for that flush — not just the effect run.
    const flush = async () => {
      TestBed.tick();
      await Promise.resolve();
      await Promise.resolve();
    };
    // Let the effect take its baseline read first: its very first run is the initial read of
    // the preferences, not a change, so it deliberately doesn't re-project.
    await flush();

    lines.membership.set(false);
    await flush();
    expect(svc.messages().map((m) => m.id)).not.toContain('$join');

    lines.membership.set(true);
    await flush();
    expect(svc.messages().map((m) => m.id)).toContain('$join');
  });

  // The oldest RAW event drives the lists' backfill loop: the oldest RENDERED row can't,
  // because a page of purely-hidden lines would leave it unchanged and the loop would stop
  // with history still to load (or never start, for an all-hidden window).
  it('reports the oldest raw event even when every row is filtered out', async () => {
    const lines = systemLinesProvider({ membership: false, profile: false });
    const onlyChurn = [
      fakeEvent({
        id: '$join',
        sender: '@bob:hs',
        type: 'm.room.member',
        stateKey: '@bob:hs',
        content: { membership: 'join' },
      }),
      fakeEvent({
        id: '$rename',
        sender: '@bob:hs',
        type: 'm.room.member',
        stateKey: '@bob:hs',
        content: { membership: 'join', displayname: 'Bobby' },
        prevContent: { membership: 'join', displayname: 'Bob' },
      }),
    ];
    const room = fakeRoom(onlyChurn, {}, false, [], null);
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        matrixProvider(fakeClient(room, [])),
        mediaProvider(),
        lines.provider,
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    expect(svc.messages()).toEqual([]); // nothing survives the filter…
    expect(svc.oldestEventId()).toBe('$join'); // …but history is still paginable
  });

  // markRead acks the newest RAW timeline event, so m.fully_read can point at an event the
  // projection never renders — a hidden membership line, but equally a reaction or an edit.
  // Resolving the divider from the projected list would find nothing and drop it silently.
  it('still anchors the unread divider when the read marker is a hidden line', () => {
    const lines = systemLinesProvider({ membership: false });
    const room = fakeRoom(churn(), {}, false, [], '$join');
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        matrixProvider(fakeClient(room, [])),
        mediaProvider(),
        lines.provider,
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    expect(svc.messages().map((m) => m.id)).not.toContain('$join');
    // '$rename' is a system line and '$2' is the next real message from someone else.
    expect(svc.firstUnreadId()).toBe('$2');
  });

  // The same hole for an event the projection drops for reasons unrelated to this feature:
  // markRead acks reactions and edits too, so the marker can name one of those.
  it('still anchors the divider when the read marker is a reaction', () => {
    const events = [
      fakeEvent({ id: '$1', sender: '@alice:hs', body: 'a' }),
      fakeEvent({
        id: '$react',
        sender: '@me:hs',
        type: 'm.reaction',
        relatesTo: { rel_type: 'm.annotation', event_id: '$1', key: '👍' },
      }),
      fakeEvent({ id: '$2', sender: '@alice:hs', body: 'b' }),
    ];
    const room = fakeRoom(events, {}, false, [], '$react');
    TestBed.configureTestingModule({
      providers: [
        TimelineService,
        matrixProvider(fakeClient(room, [])),
        mediaProvider(),
      ],
    });
    const svc = TestBed.inject(TimelineService);
    svc.open('!r:hs');

    // The reaction is never rendered, but it still positions the divider.
    expect(svc.messages().map((m) => m.id)).toEqual(['$1', '$2']);
    expect(svc.firstUnreadId()).toBe('$2');
  });
});
