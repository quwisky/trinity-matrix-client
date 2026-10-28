import { EventEmitter } from 'events';
import { TestBed } from '@angular/core/testing';
import { MatrixEvent, RoomEvent, ThreadEvent } from 'matrix-js-sdk';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyVectorDiffs,
  assertPlainData,
  type VectorDiff,
} from '@trinity/util/matrix';
import type {
  EventTimelineItem,
  ThreadSummaryInfo,
  TimelineFocus,
  TimelineItem,
  TimelineUpdate,
} from '../timeline-engine';
import {
  ME,
  ROOM,
  engineFor,
  liveTimeline,
  msg,
  sendingWorld,
  tick,
  world,
  type FakeEvent,
} from './js-sdk-timeline-engine.spec-harness';
import type { JsSdkTimelineEngine } from './js-sdk-timeline-engine';

const ROOT = '$root';
const THREAD: TimelineFocus = { kind: 'thread', rootEventId: ROOT };

function reply(id: string, sender = '@alice:hs'): FakeEvent {
  return msg(id, sender, { threadRootId: ROOT, isThreadRoot: false });
}

const ownReply = (id: string) => reply(id, ME);

/** A js-sdk `Thread` as the adapter reads it, emitting through a real EventEmitter. */
function fakeThread(
  root: FakeEvent,
  events: FakeEvent[],
  options: { length?: number; token?: string | null } = {},
) {
  const thread = Object.assign(new EventEmitter(), {
    id: root.getId(),
    rootEvent: root,
    events,
    replyToEvent: null as FakeEvent | null,
    length: options.length ?? events.length,
    liveTimeline: liveTimeline(events, options.token ?? null),
  });
  // Read live, as the SDK's getter is: Object.assign would copy it once.
  Object.defineProperty(thread, 'replyToEvent', {
    get: () => events[events.length - 1] ?? null,
  });
  return thread;
}

/** A room holding `root` and, when given, its thread. */
function threadWorld(
  thread: ReturnType<typeof fakeThread> | null,
  main: FakeEvent[] = [thread?.rootEvent ?? msg(ROOT)],
) {
  const w = world(main);
  const threads = thread ? [thread] : [];
  const room = Object.assign(w.room, {
    getThreads: () => threads,
    getThreadUnreadNotificationCount: () => 0,
  });
  room.getThread.mockImplementation(
    ((id: string) => threads.find((t) => t.id === id) ?? null) as () => unknown,
  );
  const client = Object.assign(w.client, { paginateEventTimeline: vi.fn() });
  return { room, client, threads };
}

function watchFocus(engine: JsSdkTimelineEngine, focus: TimelineFocus) {
  const updates: TimelineUpdate[] = [];
  let items: readonly TimelineItem[] = [];
  const subscription = engine.timeline(ME, ROOM, focus).subscribe((update) => {
    expect(() => assertPlainData(update)).not.toThrow();
    updates.push(update);
    items =
      update.kind === 'items' ? applyVectorDiffs(items, update.diffs) : [];
  });
  return {
    updates,
    ids: () =>
      items
        .filter((item): item is EventTimelineItem => item.kind === 'event')
        .map((item) => item.eventId),
    last: () => updates[updates.length - 1],
    subscription,
  };
}

function watchSummaries(engine: JsSdkTimelineEngine) {
  const emissions: (readonly VectorDiff<ThreadSummaryInfo>[])[] = [];
  let summaries: readonly ThreadSummaryInfo[] = [];
  const subscription = engine.threadSummaries(ME, ROOM).subscribe((diffs) => {
    expect(() => assertPlainData(diffs)).not.toThrow();
    emissions.push(diffs);
    summaries = applyVectorDiffs(summaries, diffs);
  });
  return { emissions, summaries: () => summaries, subscription };
}

const count = (emitter: EventEmitter) =>
  emitter
    .eventNames()
    .reduce((sum, name) => sum + emitter.listenerCount(name), 0);

describe('JsSdkTimelineEngine threads', () => {
  afterEach(() => TestBed.resetTestingModule());

  it('thread focus emits the root and its replies synchronously on subscribe', () => {
    const root = msg(ROOT, '@alice:hs', { isThreadRoot: true });
    const thread = fakeThread(root, [reply('$r1'), reply('$r2', ME)]);
    const { client } = threadWorld(thread, [root, msg('$main')]);

    const timeline = watchFocus(engineFor(client), THREAD);

    expect(timeline.updates).toHaveLength(1);
    expect(timeline.ids()).toEqual([ROOT, '$r1', '$r2']);
    expect(timeline.last()).toMatchObject({
      backPagination: 'start-reached',
      room: { latestConfirmedEventId: '$r2' },
    });
    timeline.subscription.unsubscribe();
  });

  it('thread focus shows the root alone until a reply forms the thread', async () => {
    const root = msg(ROOT);
    const { client, room, threads } = threadWorld(null, [root]);
    const timeline = watchFocus(engineFor(client), THREAD);
    expect(timeline.ids()).toEqual([ROOT]);

    const thread = fakeThread(root, [reply('$r1')]);
    threads.push(thread);
    room.emit(ThreadEvent.New, thread, false);
    await tick();

    expect(timeline.ids()).toEqual([ROOT, '$r1']);
    thread.events.push(reply('$r2'));
    thread.emit(ThreadEvent.NewReply, thread, thread.events[1]);
    await tick();
    expect(timeline.ids()).toEqual([ROOT, '$r1', '$r2']);
    timeline.subscription.unsubscribe();
  });

  it('paginateBackwards in thread focus stops at thread.length', async () => {
    const root = msg(ROOT);
    const thread = fakeThread(root, [reply('$r2')], { length: 2, token: 't1' });
    const { client } = threadWorld(thread);
    client.paginateEventTimeline.mockImplementation(async () => {
      thread.events.unshift(reply('$r1'));
      thread.emit(RoomEvent.Timeline, thread.events[0], undefined, true);
      return true;
    });
    const engine = engineFor(client);
    const timeline = watchFocus(engine, THREAD);
    expect(timeline.last()).toMatchObject({ backPagination: 'idle' });
    const order: string[] = [];
    timeline.subscription.add(
      engine.timeline(ME, ROOM, THREAD).subscribe((update) => {
        if (update.kind === 'items') order.push(update.backPagination);
      }),
    );
    order.length = 0;

    const first = await firstValueFrom(
      engine.paginateBackwards(ME, ROOM, THREAD, 30),
    );

    expect(first).toEqual({ ok: true, value: { startReached: true } });
    expect(order).toEqual(['paginating', 'start-reached']);
    expect(client.paginateEventTimeline).toHaveBeenCalledWith(
      thread.liveTimeline,
      { backwards: true, limit: 30 },
    );
    expect(timeline.ids()).toEqual([ROOT, '$r1', '$r2']);

    // The token remains, but every reply the server counts is loaded.
    const second = await firstValueFrom(
      engine.paginateBackwards(ME, ROOM, THREAD, 30),
    );
    expect(second).toEqual({ ok: true, value: { startReached: true } });
    expect(client.paginateEventTimeline).toHaveBeenCalledTimes(1);
    timeline.subscription.unsubscribe();
  });

  it('a thread page that brings nothing ends paging', async () => {
    const thread = fakeThread(msg(ROOT), [reply('$r2')], {
      length: 5,
      token: 't1',
    });
    const { client } = threadWorld(thread);
    client.paginateEventTimeline.mockResolvedValue(true);
    const engine = engineFor(client);
    const timeline = watchFocus(engine, THREAD);

    const result = await firstValueFrom(
      engine.paginateBackwards(ME, ROOM, THREAD, 30),
    );

    expect(result).toEqual({ ok: true, value: { startReached: true } });
    expect(timeline.last()).toMatchObject({ backPagination: 'start-reached' });
    timeline.subscription.unsubscribe();
  });

  it('re-emits summaries on a main timeline change only when a fingerprint changed', () => {
    const root = msg(ROOT, '@bob:hs');
    const thread = fakeThread(root, [reply('$r1')]);
    const { client, room } = threadWorld(thread, [root]);
    const summaries = watchSummaries(engineFor(client));

    expect(summaries.emissions).toHaveLength(1);
    expect(summaries.summaries()).toEqual([
      {
        rootEventId: ROOT,
        replyCount: 1,
        latestActivityTs: expect.any(Number),
        root: { sender: '@bob:hs', preview: ROOT, unencryptedMark: null },
        latestReply: {
          sender: '@alice:hs',
          preview: '$r1',
          ts: expect.any(Number),
          unencryptedMark: null,
        },
        participants: ['@bob:hs', '@alice:hs'],
        profiles: {
          '@bob:hs': expect.objectContaining({ displayName: 'Alice' }),
          '@alice:hs': expect.objectContaining({ displayName: 'Alice' }),
        },
        unreadCount: 0,
        highlight: false,
      },
    ]);
    const before = summaries.summaries()[0];

    room.emit(RoomEvent.Timeline, msg('$main'), room, false, false);
    expect(summaries.emissions).toHaveLength(1);

    thread.events.push(reply('$r2', ME));
    thread.length = 2;
    room.emit(RoomEvent.Timeline, msg('$main2'), room, false, false);

    expect(summaries.emissions).toHaveLength(2);
    expect(summaries.summaries()[0]).not.toBe(before);
    expect(summaries.summaries()[0]).toMatchObject({
      replyCount: 2,
      latestReply: { sender: ME, preview: '$r2' },
      participants: ['@bob:hs', '@alice:hs', ME],
    });
    summaries.subscription.unsubscribe();
  });

  it('the first threaded send creates the thread from the fetched root', async () => {
    const w = sendingWorld([msg('$a')]);
    const room = Object.assign(w.room, { createThread: vi.fn() });
    const raw = {
      event_id: ROOT,
      room_id: ROOM,
      sender: '@alice:hs',
      type: 'm.room.message',
      content: { msgtype: 'm.text', body: 'root' },
      origin_server_ts: 1,
    };
    w.client.fetchRoomEvent.mockResolvedValue(raw);
    const engine = engineFor(w.client);

    const reply = firstValueFrom(
      engine.send(
        ME,
        ROOM,
        {
          kind: 'text',
          msgtype: 'text',
          body: 'hi',
          formattedBody: null,
          mentions: { userIds: [], room: false },
        },
        { threadRootId: ROOT, replyTo: null },
      ),
    );
    await vi.waitFor(() => expect(w.sends).toHaveLength(1));
    w.confirm(0, '$e');
    await reply;

    expect(w.client.fetchRoomEvent).toHaveBeenCalledWith(ROOM, ROOT);
    const [id, event, events, toStart] = room.createThread.mock.calls[0];
    expect([id, events, toStart]).toEqual([ROOT, [], false]);
    expect(event).toBeInstanceOf(MatrixEvent);
    expect((event as MatrixEvent).getId()).toBe(ROOT);
    expect(room.createThread.mock.invocationCallOrder[0]).toBeLessThan(
      w.client.sendMessage.mock.invocationCallOrder[0],
    );
  });

  it("a threaded send's echo is in thread focus before send replies, until its reply syncs", async () => {
    const root = msg(ROOT);
    const w = sendingWorld([root]);
    const thread = fakeThread(root, []);
    w.room.getThread.mockReturnValue(thread);
    const engine = engineFor(w.client);
    const timeline = watchFocus(engine, THREAD);
    const transactionId = 'txn-thread';

    const reply = firstValueFrom(
      engine.send(
        ME,
        ROOM,
        {
          kind: 'text',
          msgtype: 'text',
          body: 'hi',
          formattedBody: null,
          mentions: { userIds: [], room: false },
        },
        { threadRootId: ROOT, replyTo: null, transactionId },
      ),
    );
    w.confirm(0, '$e');
    await reply;
    expect(timeline.ids()).toEqual([ROOT, '$e']);

    // The synced reply takes the echo's place.
    thread.events.push(ownReply('$e'));
    thread.emit(ThreadEvent.NewReply, thread, thread.events[0]);
    await tick();
    expect(timeline.ids()).toEqual([ROOT, '$e']);
    timeline.subscription.unsubscribe();
  });

  it('a threaded send fails without sending when the root cannot be fetched', async () => {
    const w = sendingWorld([msg('$a')]);
    const room = Object.assign(w.room, { createThread: vi.fn() });
    w.client.fetchRoomEvent.mockRejectedValue(new Error('gone'));
    const engine = engineFor(w.client);

    const result = await firstValueFrom(
      engine.send(
        ME,
        ROOM,
        {
          kind: 'text',
          msgtype: 'text',
          body: 'hi',
          formattedBody: null,
          mentions: { userIds: [], room: false },
        },
        { threadRootId: ROOT, replyTo: null },
      ),
    );

    expect(result.ok).toBe(false);
    expect(room.createThread).not.toHaveBeenCalled();
    expect(w.client.sendMessage).not.toHaveBeenCalled();
  });

  it('unsubscribe removes every thread and summary listener', async () => {
    const root = msg(ROOT);
    const thread = fakeThread(root, [reply('$r1')]);
    const { client, room } = threadWorld(thread, [root]);
    const engine = engineFor(client);

    const timeline = watchFocus(engine, THREAD);
    const summaries = watchSummaries(engine);
    await tick();
    expect(count(thread)).toBeGreaterThan(0);
    expect(count(room)).toBeGreaterThan(0);

    timeline.subscription.unsubscribe();
    summaries.subscription.unsubscribe();

    expect(count(thread)).toBe(0);
    expect(count(room)).toBe(0);
    expect(count(client)).toBe(0);
  });
});
