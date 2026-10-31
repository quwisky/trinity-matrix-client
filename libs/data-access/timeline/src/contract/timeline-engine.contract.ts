import {
  BehaviorSubject,
  type Observable,
  filter,
  firstValueFrom,
  map,
  scan,
  tap,
  timeout,
  toArray,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EngineResult,
  applyVectorDiffs,
  assertPlainData,
} from '@trinity/util/matrix';
import type {
  EventTimelineItem,
  OutgoingMessage,
  OutgoingText,
  ThreadSummaryInfo,
  TimelineEngine,
  TimelineFocus,
  TimelineItem,
  TimelineUpdate,
} from '../lib/timeline-engine';

export interface TimelineContractSetup {
  readonly engine: TimelineEngine;
  /** A live account in `engine`. */
  readonly alice: string;
  /** A registered user on the same server, driven only through `asBob`. */
  readonly bob: string;
  readonly serverName: string;
  readonly asAlice: {
    /** Joins outside the engine. */
    join(roomId: string): Promise<void>;
    /** Alice's `m.fully_read` event id, read from the server. */
    fullyRead(roomId: string): Promise<string | null>;
  };
  readonly asBob: {
    /** An unencrypted private room whose history alice sees once she joins. */
    createRoom(name: string): Promise<string>;
    invite(roomId: string, userId: string): Promise<void>;
    /** Sends a text message and returns its event id. */
    send(roomId: string, body: string): Promise<string>;
    /** Sends a text reply in the thread of `rootId` and returns its event id. */
    sendInThread(roomId: string, rootId: string, body: string): Promise<string>;
    react(roomId: string, eventId: string, key: string): Promise<void>;
    redact(roomId: string, eventId: string): Promise<void>;
    edit(roomId: string, eventId: string, body: string): Promise<void>;
    /** The event `userId`'s public `m.read` receipt names, as bob's sync reports it. */
    readReceipt(roomId: string, userId: string): Promise<string | null>;
    /** Merges `patch` into the room's `m.room.power_levels`; `events` and `users` merge per key. */
    setPowerLevels(
      roomId: string,
      patch: {
        readonly events_default?: number;
        readonly events?: Readonly<Record<string, number>>;
        readonly users?: Readonly<Record<string, number>>;
        readonly redact?: number;
      },
    ): Promise<void>;
    /** Sends an event of any type and returns its event id. */
    sendEvent(roomId: string, type: string, content: object): Promise<string>;
  };
  /**
   * Makes alice's crypto answer that rooms are unencrypted until the returned restore runs, for
   * an engine whose crypto is stubbed out; a voice clip is refused while that is unknown.
   */
  readonly knownUnencrypted?: () => () => void;
  dispose(): Promise<void>;
}

export interface TimelineContractTiming {
  /** How long a change may take to reach a `timeline()` emission. */
  readonly settleTimeoutMs: number;
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

interface TimelineView {
  readonly items: readonly TimelineItem[];
  readonly backPagination: 'idle' | 'paginating' | 'start-reached';
}

interface Watch {
  readonly updates: readonly TimelineUpdate[];
  /** The folded items, or `null` while the room is unavailable. */
  view(): TimelineView | null;
  until(predicate: (view: TimelineView) => boolean): Promise<TimelineView>;
  close(): void;
}

const NOBODY = '@nobody:invalid';
const LIVE: TimelineFocus = { kind: 'live' };
const MAIN = { threadRootId: null, replyTo: null } as const;
const NO_THREAD = { threadRootId: null } as const;

function plain(body: string): OutgoingText {
  return {
    msgtype: 'text',
    body,
    formattedBody: null,
    mentions: { userIds: [], room: false },
  };
}

function text(body: string): OutgoingMessage {
  return { kind: 'text', ...plain(body) };
}

function byTxn(
  view: TimelineView | null,
  transactionId: string,
): EventTimelineItem | undefined {
  return events(view).find((item) => item.transactionId === transactionId);
}

function eventKey(eventId: string) {
  return { eventId, transactionId: null } as const;
}

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

function events(view: TimelineView | null): readonly EventTimelineItem[] {
  return (view?.items ?? []).filter(
    (item): item is EventTimelineItem => item.kind === 'event',
  );
}

function byId(
  view: TimelineView | null,
  eventId: string,
): EventTimelineItem | undefined {
  return events(view).find((item) => item.eventId === eventId);
}

function bodyOf(item: EventTimelineItem | undefined): string | null {
  return item?.content.kind === 'message' ? item.content.body : null;
}

export function defineTimelineEngineContract(
  setup: () => Promise<TimelineContractSetup>,
  { settleTimeoutMs, testTimeoutMs }: TimelineContractTiming,
): void {
  describe('TimelineEngine contract', () => {
    let context: TimelineContractSetup;
    let engine: TimelineEngine;
    let alice: string;
    let bob: string;

    beforeEach(async () => {
      context = await setup();
      ({ engine, alice, bob } = context);
    }, testTimeoutMs);

    afterEach(async () => {
      await context.dispose();
    }, testTimeoutMs);

    /** Asserts the command emits exactly once with plain data, and returns that value. */
    async function once<T>(source: Observable<T>): Promise<T> {
      const emitted = await firstValueFrom(source.pipe(toArray()));
      expect(emitted).toHaveLength(1);
      expect(() => assertPlainData(emitted[0])).not.toThrow();
      return emitted[0];
    }

    async function ok<T>(source: Observable<EngineResult<T>>): Promise<T> {
      const result = await once(source);
      if (!result.ok) throw new Error(`Command failed: ${result.failure.code}`);
      return result.value;
    }

    /** Alice's timeline of the room, folded and checked for plain data on every update. */
    function watch(roomId: string, focus: TimelineFocus = LIVE): Watch {
      const updates: TimelineUpdate[] = [];
      const view$ = new BehaviorSubject<TimelineView | null>(null);
      const subscription = engine
        .timeline(alice, roomId, focus)
        .pipe(
          tap((update) => {
            expect(() => assertPlainData(update)).not.toThrow();
            updates.push(update);
          }),
          scan(
            (view: TimelineView | null, update: TimelineUpdate) =>
              update.kind === 'room-unavailable'
                ? null
                : {
                    items: applyVectorDiffs(view?.items ?? [], update.diffs),
                    backPagination: update.backPagination,
                  },
            null,
          ),
        )
        .subscribe(view$);
      return {
        updates,
        view: () => view$.value,
        until: (predicate) =>
          firstValueFrom(
            view$.pipe(
              filter((view): view is TimelineView => view !== null),
              filter(predicate),
              timeout(settleTimeoutMs),
            ),
          ),
        close: () => subscription.unsubscribe(),
      };
    }

    /** Alice's thread summaries of the room, folded and checked for plain data. */
    function watchSummaries(roomId: string) {
      const summaries$ = new BehaviorSubject<readonly ThreadSummaryInfo[]>([]);
      const subscription = engine
        .threadSummaries(alice, roomId)
        .pipe(
          tap((diffs) => expect(() => assertPlainData(diffs)).not.toThrow()),
          scan(
            (summaries: readonly ThreadSummaryInfo[], diffs) =>
              applyVectorDiffs(summaries, diffs),
            [],
          ),
        )
        .subscribe(summaries$);
      return {
        until: (rootId: string, predicate: (s: ThreadSummaryInfo) => boolean) =>
          firstValueFrom(
            summaries$.pipe(
              map((all) => all.find((s) => s.rootEventId === rootId)),
              filter((s): s is ThreadSummaryInfo => !!s && predicate(s)),
              timeout(settleTimeoutMs),
            ),
          ),
        close: () => subscription.unsubscribe(),
      };
    }

    /** Bob's room with `bodies` sent before alice joins; returns their event ids in order. */
    async function roomWith(bodies: readonly string[] = []): Promise<{
      readonly roomId: string;
      readonly eventIds: readonly string[];
    }> {
      const roomId = await context.asBob.createRoom(`timeline ${unique()}`);
      const eventIds: string[] = [];
      for (const body of bodies)
        eventIds.push(await context.asBob.send(roomId, body));
      await context.asBob.invite(roomId, alice);
      await context.asAlice.join(roomId);
      const joined = watch(roomId);
      try {
        await joined.until(() => true);
      } finally {
        joined.close();
      }
      return { roomId, eventIds };
    }

    it(
      'timeline emits a snapshot first and every emission is plain data',
      async () => {
        const { roomId } = await roomWith(['hello']);

        const first = await firstValueFrom(
          engine.timeline(alice, roomId, LIVE).pipe(timeout(settleTimeoutMs)),
        );

        expect(() => assertPlainData(first)).not.toThrow();
        expect(first.kind).toBe('items');
        if (first.kind !== 'items') return;
        expect(first.diffs).toHaveLength(1);
        expect(first.diffs[0].op).toBe('reset');
      },
      testTimeoutMs,
    );

    it(
      'a room alice is not in is room-unavailable, then items once she joins',
      async () => {
        const roomId = await context.asBob.createRoom(`timeline ${unique()}`);

        const first = await firstValueFrom(
          engine.timeline(alice, roomId, LIVE).pipe(timeout(settleTimeoutMs)),
        );
        expect(first).toEqual({ kind: 'room-unavailable' });

        const timeline = watch(roomId);
        try {
          await context.asBob.invite(roomId, alice);
          await context.asAlice.join(roomId);
          await timeline.until(() => true);
          expect(timeline.updates[0]).toEqual({ kind: 'room-unavailable' });
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      "bob's message is an event item with his profile",
      async () => {
        const {
          roomId,
          eventIds: [eventId],
        } = await roomWith(['hello alice']);
        const timeline = watch(roomId);
        try {
          const view = await timeline.until((v) => !!byId(v, eventId));

          const item = byId(view, eventId);
          expect(item).toMatchObject({
            sender: bob,
            isOwn: false,
            sendState: null,
            content: { kind: 'message', msgtype: 'text', body: 'hello alice' },
          });
          expect(item?.profiles[bob]?.displayName).toEqual(expect.any(String));
          expect(item?.profiles[bob]?.displayName).not.toBe('');
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'paginateBackwards prepends older items with idle in the same update, then replies',
      async () => {
        const bodies = Array.from({ length: 60 }, (_, i) => `message ${i}`);
        const { roomId, eventIds } = await roomWith(bodies);
        const timeline = watch(roomId);
        try {
          const before = await timeline.until(
            (v) => !!byId(v, eventIds[eventIds.length - 1]),
          );
          const loadedBefore = events(before).map((item) => item.eventId);
          expect(loadedBefore).not.toContain(eventIds[0]);
          const mark = timeline.updates.length;

          const reply = await ok(
            engine.paginateBackwards(alice, roomId, LIVE, 10),
          );

          expect(reply.startReached).toBe(false);
          // Unrelated sync updates may land in between; only the pagination states are pinned.
          const page = timeline.updates.slice(mark);
          const started = page.findIndex(
            (u) => u.kind === 'items' && u.backPagination === 'paginating',
          );
          expect(started).toBeGreaterThanOrEqual(0);
          expect(page[started]).toMatchObject({ diffs: [] });
          const settled = page.findIndex(
            (u, i) =>
              i > started &&
              u.kind === 'items' &&
              u.backPagination !== 'paginating',
          );
          expect(settled).toBeGreaterThan(started);
          const pageUpdate = page[settled];
          expect(pageUpdate).toMatchObject({ backPagination: 'idle' });
          expect(
            pageUpdate.kind === 'items' && pageUpdate.diffs.length,
          ).toBeGreaterThan(0);
          const atSettled = page
            .slice(0, settled + 1)
            .reduce(
              (items: readonly TimelineItem[], u) =>
                u.kind === 'items' ? applyVectorDiffs(items, u.diffs) : [],
              before.items,
            );

          const after = events(timeline.view()).map((item) => item.eventId);
          expect(new Set(after).size).toBe(after.length);
          expect(after.slice(-loadedBefore.length)).toEqual(loadedBefore);
          const prepended = after.slice(0, after.length - loadedBefore.length);
          expect(prepended.length).toBeGreaterThan(0);
          const firstLoaded = eventIds.findIndex((id) =>
            loadedBefore.includes(id),
          );
          expect(prepended).toEqual(
            eventIds.slice(firstLoaded - prepended.length, firstLoaded),
          );
          expect(
            events({ items: atSettled, backPagination: 'idle' }).map(
              (item) => item.eventId,
            ),
          ).toEqual(after);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      "paginateBackwards reaches start-reached at the room's creation",
      async () => {
        const { roomId } = await roomWith(['first']);
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);

          let startReached = false;
          for (let page = 0; page < 20 && !startReached; page++) {
            ({ startReached } = await ok(
              engine.paginateBackwards(alice, roomId, LIVE, 50),
            ));
          }

          expect(startReached).toBe(true);
          expect(timeline.view()?.backPagination).toBe('start-reached');
          expect(timeline.view()?.items[0]?.kind).toBe('timelineStart');
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'paginateUntil loads a far-back event',
      async () => {
        const bodies = ['far back', ...Array.from({ length: 60 }, String)];
        const {
          roomId,
          eventIds: [farId, ...rest],
        } = await roomWith(bodies);
        const timeline = watch(roomId);
        try {
          await timeline.until((v) => !!byId(v, rest[rest.length - 1]));

          const reply = await ok(
            engine.paginateUntil(alice, roomId, farId, 20),
          );

          expect(reply).toEqual({ found: true });
          expect(bodyOf(byId(timeline.view(), farId))).toBe('far back');
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'paginateUntil returns found false within maxPages',
      async () => {
        const { roomId } = await roomWith(['only']);
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);

          await expect(
            ok(engine.paginateUntil(alice, roomId, `$missing-${unique()}`, 2)),
          ).resolves.toEqual({ found: false });
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'eventAt finds the first event at or after a timestamp',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          await context.asBob.send(roomId, 'earlier');
          // Distinct server timestamps, so "at or after" names one event.
          await new Promise((resolve) => setTimeout(resolve, 20));
          const laterId = await context.asBob.send(roomId, 'later');
          const view = await timeline.until((v) => !!byId(v, laterId));
          const timestamp = byId(view, laterId)?.timestamp ?? 0;

          await expect(
            ok(engine.eventAt(alice, roomId, timestamp)),
          ).resolves.toEqual({ eventId: laterId });
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      "eventSource returns the event's JSON",
      async () => {
        const {
          roomId,
          eventIds: [eventId],
        } = await roomWith(['view my source']);

        const source = await ok(engine.eventSource(alice, roomId, eventId));

        expect(source).toMatchObject({
          event_id: eventId,
          room_id: roomId,
          sender: bob,
          type: 'm.room.message',
          content: { msgtype: 'm.text', body: 'view my source' },
        });
      },
      testTimeoutMs,
    );

    it(
      'eventSource for an unknown event is message-unavailable',
      async () => {
        const { roomId } = await roomWith();

        const result = await once(
          engine.eventSource(alice, roomId, `$unknown-${unique()}`),
        );

        expect(!result.ok && result.failure.code).toBe('message-unavailable');
      },
      testTimeoutMs,
    );

    it(
      "reactionDetails lists bob's reaction with his profile",
      async () => {
        const {
          roomId,
          eventIds: [eventId],
        } = await roomWith(['react to me']);
        const timeline = watch(roomId);
        try {
          await timeline.until((v) => !!byId(v, eventId));
          await context.asBob.react(roomId, eventId, '👍');
          const view = await timeline.until(
            (v) => (byId(v, eventId)?.reactions.length ?? 0) > 0,
          );
          expect(byId(view, eventId)?.reactions).toEqual([
            { key: '👍', count: 1, reactedByMe: false, senders: [bob] },
          ]);

          const details = await ok(
            engine.reactionDetails(alice, roomId, eventId),
          );

          expect(details).toEqual([
            {
              key: '👍',
              senders: [bob],
              profiles: {
                [bob]: expect.objectContaining({
                  displayName: expect.any(String),
                }),
              },
            },
          ]);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      "bob's redaction turns the item redacted",
      async () => {
        const {
          roomId,
          eventIds: [eventId],
        } = await roomWith(['regret']);
        const timeline = watch(roomId);
        try {
          await timeline.until((v) => !!byId(v, eventId));

          await context.asBob.redact(roomId, eventId);

          await timeline.until(
            (v) => byId(v, eventId)?.content.kind === 'redacted',
          );
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      "bob's edit replaces the body and sets edited",
      async () => {
        const {
          roomId,
          eventIds: [eventId],
        } = await roomWith(['tpyo']);
        const timeline = watch(roomId);
        try {
          await timeline.until((v) => !!byId(v, eventId));

          await context.asBob.edit(roomId, eventId, 'typo');

          const view = await timeline.until(
            (v) => bodyOf(byId(v, eventId)) === 'typo',
          );
          expect(byId(view, eventId)?.edited).toBe(true);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      "sendReceipt with fullyRead moves alice's m.fully_read and m.read",
      async () => {
        const {
          roomId,
          eventIds: [eventId],
        } = await roomWith(['read me']);
        const timeline = watch(roomId);
        try {
          await timeline.until((v) => !!byId(v, eventId));

          await ok(
            engine.sendReceipt(alice, roomId, eventId, {
              threadRootId: null,
              visibility: 'public',
              fullyRead: true,
            }),
          );

          await expect(context.asAlice.fullyRead(roomId)).resolves.toBe(
            eventId,
          );
          await expect(context.asBob.readReceipt(roomId, alice)).resolves.toBe(
            eventId,
          );
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'setTyping true then false replies ok',
      async () => {
        const { roomId } = await roomWith();

        await expect(ok(engine.setTyping(alice, roomId, true))).resolves.toBe(
          null,
        );
        await expect(ok(engine.setTyping(alice, roomId, false))).resolves.toBe(
          null,
        );
      },
      testTimeoutMs,
    );

    it(
      'setRetention replies for a held and a released room',
      async () => {
        const { roomId } = await roomWith(['kept']);
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);

          await expect(
            once(
              engine.setRetention(alice, roomId, {
                shown: true,
                followingLive: true,
                windowHidden: true,
                kept: [],
                marked: [],
              }),
            ),
          ).resolves.toBeNull();
          await expect(
            once(engine.setRetention(alice, roomId, null)),
          ).resolves.toBeNull();

          const eventId = await context.asBob.send(roomId, 'after');
          await timeline.until((v) => !!byId(v, eventId));
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'send shows the local echo before it replies',
      async () => {
        const {
          roomId,
          eventIds: [greetingId],
        } = await roomWith(['hello alice']);
        const timeline = watch(roomId);
        try {
          // Bob's message shows once alice's join has synced, so no join resets the timeline.
          await timeline.until((v) => !!byId(v, greetingId));

          const sent = await ok(
            engine.send(alice, roomId, text('hi bob'), MAIN),
          );

          const echo = byTxn(timeline.view(), sent.transactionId);
          expect(echo).toMatchObject({
            sender: alice,
            isOwn: true,
            content: { kind: 'message', msgtype: 'text', body: 'hi bob' },
          });
          expect(sent.eventId).toEqual(expect.any(String));
          const view = await timeline.until(
            (v) =>
              byId(v, sent.eventId ?? '')?.sendState === null &&
              !!byTxn(v, sent.transactionId),
          );
          expect(byId(view, sent.eventId ?? '')?.uniqueId).toBe(echo?.uniqueId);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'send with a caller transaction id gives its echo that id',
      async () => {
        const {
          roomId,
          eventIds: [greetingId],
        } = await roomWith(['hello alice']);
        const timeline = watch(roomId);
        try {
          // As above: once alice's join has synced, no join resets the timeline.
          await timeline.until((v) => !!byId(v, greetingId));
          const transactionId = `contract-${Date.now()}`;

          const sent = await ok(
            engine.send(alice, roomId, text('mine'), {
              ...MAIN,
              transactionId,
            }),
          );

          expect(sent.transactionId).toBe(transactionId);
          expect(byTxn(timeline.view(), transactionId)).toMatchObject({
            isOwn: true,
            content: { kind: 'message', body: 'mine' },
          });
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'send with replyTo has inReplyTo ready',
      async () => {
        const {
          roomId,
          eventIds: [questionId],
        } = await roomWith(['question']);
        const timeline = watch(roomId);
        try {
          await timeline.until((v) => !!byId(v, questionId));

          const sent = await ok(
            engine.send(alice, roomId, text('answer'), {
              threadRootId: null,
              replyTo: questionId,
            }),
          );

          const view = await timeline.until(
            (v) =>
              byTxn(v, sent.transactionId)?.inReplyTo?.details.kind === 'ready',
          );
          expect(byTxn(view, sent.transactionId)?.inReplyTo).toMatchObject({
            eventId: questionId,
            details: { kind: 'ready', sender: bob, body: 'question' },
          });
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'edit replaces the body and sets edited',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          const { eventId } = await ok(
            engine.send(alice, roomId, text('tpyo'), MAIN),
          );

          await ok(
            engine.edit(
              alice,
              roomId,
              eventKey(eventId ?? ''),
              {
                msgtype: 'text',
                body: 'typo',
                formattedBody: null,
                mentions: { userIds: [], room: false },
              },
              NO_THREAD,
            ),
          );

          const view = await timeline.until(
            (v) => bodyOf(byId(v, eventId ?? '')) === 'typo',
          );
          expect(byId(view, eventId ?? '')?.edited).toBe(true);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'redact own message turns it redacted',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          const { eventId } = await ok(
            engine.send(alice, roomId, text('oops'), MAIN),
          );

          await ok(
            engine.redact(alice, roomId, eventKey(eventId ?? ''), NO_THREAD),
          );

          await timeline.until(
            (v) => byId(v, eventId ?? '')?.content.kind === 'redacted',
          );
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'toggleReaction on then off',
      async () => {
        const {
          roomId,
          eventIds: [eventId],
        } = await roomWith(['like me']);
        const timeline = watch(roomId);
        try {
          await timeline.until((v) => !!byId(v, eventId));

          await ok(
            engine.toggleReaction(
              alice,
              roomId,
              eventKey(eventId),
              '👍',
              NO_THREAD,
            ),
          );
          const on = await timeline.until(
            (v) => byId(v, eventId)?.reactions[0]?.reactedByMe === true,
          );
          expect(byId(on, eventId)?.reactions).toEqual([
            { key: '👍', count: 1, reactedByMe: true, senders: [alice] },
          ]);

          await ok(
            engine.toggleReaction(
              alice,
              roomId,
              eventKey(eventId),
              '👍',
              NO_THREAD,
            ),
          );
          await timeline.until((v) => byId(v, eventId)?.reactions.length === 0);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'poll-start, poll-response and poll-end show in the poll item',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          const poll = (v: TimelineView) => {
            const content = byId(v, pollId)?.content;
            return content?.kind === 'poll' ? content.poll : null;
          };

          const started = await ok(
            engine.send(
              alice,
              roomId,
              {
                kind: 'poll-start',
                question: 'Lunch?',
                answers: ['Pizza', 'Soup'],
                maxSelections: 1,
              },
              MAIN,
            ),
          );
          const pollId = started.eventId ?? '';
          const shown = await timeline.until((v) => poll(v) !== null);
          expect(poll(shown)).toMatchObject({
            question: 'Lunch?',
            options: [{ text: 'Pizza' }, { text: 'Soup' }],
            maxSelections: 1,
            ended: false,
          });

          const answerId = poll(shown)?.options[1]?.id ?? '';
          await ok(
            engine.send(
              alice,
              roomId,
              { kind: 'poll-response', pollId, answerIds: [answerId] },
              MAIN,
            ),
          );
          await timeline.until(
            (v) =>
              poll(v)?.options[1]?.chosen === true && poll(v)?.totalVotes === 1,
          );

          await ok(
            engine.send(alice, roomId, { kind: 'poll-end', pollId }, MAIN),
          );
          await timeline.until((v) => poll(v)?.ended === true);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'send location shows a location item',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);

          const sent = await ok(
            engine.send(
              alice,
              roomId,
              { kind: 'location', lat: 51.5, lng: -0.125, label: null },
              MAIN,
            ),
          );

          const view = await timeline.until(
            (v) => byTxn(v, sent.transactionId)?.content.kind === 'location',
          );
          expect(byTxn(view, sent.transactionId)?.content).toEqual({
            kind: 'location',
            lat: 51.5,
            lng: -0.125,
            label: 'Shared location',
          });
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'forward copies a message to another room',
      async () => {
        const {
          roomId: sourceId,
          eventIds: [eventId],
        } = await roomWith(['pass it on']);
        const { roomId: targetId } = await roomWith();
        const source = watch(sourceId);
        const target = watch(targetId);
        try {
          await source.until((v) => !!byId(v, eventId));
          await target.until(() => true);

          await ok(engine.forward(alice, sourceId, eventId, targetId));

          const view = await target.until((v) =>
            events(v).some(
              (item) => item.isOwn && bodyOf(item) === 'pass it on',
            ),
          );
          const copy = events(view).find((item) => item.isOwn);
          expect(copy).toMatchObject({ sender: alice, inReplyTo: null });
        } finally {
          source.close();
          target.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'forward a redacted message is not-forwardable',
      async () => {
        const {
          roomId: sourceId,
          eventIds: [eventId],
        } = await roomWith(['gone soon']);
        const { roomId: targetId } = await roomWith();
        const source = watch(sourceId);
        try {
          await source.until((v) => !!byId(v, eventId));
          await context.asBob.redact(sourceId, eventId);
          await source.until(
            (v) => byId(v, eventId)?.content.kind === 'redacted',
          );

          const result = await once(
            engine.forward(alice, sourceId, eventId, targetId),
          );

          expect(!result.ok && result.failure.code).toBe('not-forwardable');
        } finally {
          source.close();
        }
      },
      testTimeoutMs,
    );

    /** Alice's own message in the open timeline, confirmed by the server. */
    async function ownMessage(
      roomId: string,
      timeline: Watch,
      body: string,
    ): Promise<string> {
      await timeline.until(() => true);
      const { eventId } = await ok(
        engine.send(alice, roomId, text(body), MAIN),
      );
      await timeline.until((v) => byId(v, eventId ?? '')?.sendState === null);
      return eventId ?? '';
    }

    /** The command's single reply and the folded view read the moment it arrives. */
    async function atReply<T>(
      timeline: Watch,
      command: Observable<EngineResult<T>>,
    ) {
      let view: TimelineView | null = null;
      const result = await once(
        command.pipe(tap(() => (view = timeline.view()))),
      );
      if (!result.ok) throw new Error(`Command failed: ${result.failure.code}`);
      return view;
    }

    const reaction = (view: TimelineView | null, eventId: string) =>
      byId(view, eventId)?.reactions.find((group) => group.key === '👍');

    it.each([
      {
        command: 'edit',
        run: async (roomId: string, timeline: Watch) => {
          const eventId = await ownMessage(roomId, timeline, 'tpyo');
          const view = await atReply(
            timeline,
            engine.edit(
              alice,
              roomId,
              eventKey(eventId),
              plain('typo'),
              NO_THREAD,
            ),
          );
          const item = byId(view, eventId);
          expect(bodyOf(item)).toBe('typo');
          expect(item?.edited).toBe(true);
        },
      },
      {
        command: 'toggleReaction on',
        run: async (roomId: string, timeline: Watch) => {
          const eventId = await ownMessage(roomId, timeline, 'like me');
          const view = await atReply(
            timeline,
            engine.toggleReaction(
              alice,
              roomId,
              eventKey(eventId),
              '👍',
              NO_THREAD,
            ),
          );
          expect(reaction(view, eventId)?.reactedByMe).toBe(true);
        },
      },
      {
        command: 'toggleReaction off',
        run: async (roomId: string, timeline: Watch) => {
          const eventId = await ownMessage(roomId, timeline, 'like me');
          const toggle = () =>
            atReply(
              timeline,
              engine.toggleReaction(
                alice,
                roomId,
                eventKey(eventId),
                '👍',
                NO_THREAD,
              ),
            );
          await toggle();
          expect(reaction(await toggle(), eventId)).toBeUndefined();
        },
      },
      {
        command: 'redact',
        run: async (roomId: string, timeline: Watch) => {
          const eventId = await ownMessage(roomId, timeline, 'oops');
          const view = await atReply(
            timeline,
            engine.redact(alice, roomId, eventKey(eventId), NO_THREAD),
          );
          expect(byId(view, eventId)?.content.kind).toBe('redacted');
        },
      },
    ])(
      'G1 — $command shows its effect in an open timeline before it replies',
      async ({ run }) => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await run(roomId, timeline);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G2 — a refused send keeps a failed echo; cancel removes it, retry sends it, and later sends go',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          await context.asBob.setPowerLevels(roomId, { events_default: 50 });

          const refused = await ok(
            engine.send(alice, roomId, text('refused'), MAIN),
          );
          expect(refused.eventId).toBeNull();
          expect(
            byTxn(timeline.view(), refused.transactionId)?.sendState?.kind,
          ).toBe('failed');

          await ok(engine.cancelSend(alice, roomId, refused.transactionId));
          expect(byTxn(timeline.view(), refused.transactionId)).toBeUndefined();

          const again = await ok(
            engine.send(alice, roomId, text('again'), MAIN),
          );
          expect(again.eventId).toBeNull();
          expect(
            byTxn(timeline.view(), again.transactionId)?.sendState?.kind,
          ).toBe('failed');

          await context.asBob.setPowerLevels(roomId, { events_default: 0 });
          await ok(engine.retrySend(alice, roomId, again.transactionId));
          const view = await timeline.until(
            (v) => !!byTxn(v, again.transactionId)?.eventId,
          );
          expect(byTxn(view, again.transactionId)?.eventId).toEqual(
            expect.any(String),
          );

          const third = await ok(
            engine.send(alice, roomId, text('third'), MAIN),
          );
          expect(third.eventId).toEqual(expect.any(String));
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G3 — a caller can cancel a send before it returns',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          const transactionId = `contract-cancel-${unique()}`;
          const first = ok(engine.send(alice, roomId, text('first'), MAIN));
          const second = firstValueFrom(
            engine.send(alice, roomId, text('second'), {
              ...MAIN,
              transactionId,
            }),
          );

          const cancelled = await once(
            engine.cancelSend(alice, roomId, transactionId),
          );
          const [sent] = await Promise.all([second, first]);

          if (cancelled.ok) {
            await timeline.until((v) => !byTxn(v, transactionId));
          } else {
            expect(cancelled.failure.code).toBe('not-cancellable');
            expect(sent.ok && sent.value.eventId).toEqual(expect.any(String));
            await timeline.until(
              (v) => byTxn(v, transactionId)?.sendState === null,
            );
          }
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it.each([
      {
        command: 'edit',
        run: (roomId: string, eventId: string) =>
          engine.edit(
            alice,
            roomId,
            eventKey(eventId),
            plain('changed'),
            NO_THREAD,
          ),
        unchanged: (item: EventTimelineItem | undefined) =>
          expect(bodyOf(item)).toBe('original'),
      },
      {
        command: 'toggleReaction',
        run: (roomId: string, eventId: string) =>
          engine.toggleReaction(
            alice,
            roomId,
            eventKey(eventId),
            '👍',
            NO_THREAD,
          ),
        unchanged: (item: EventTimelineItem | undefined) =>
          expect(item?.reactions.some((group) => group.reactedByMe)).toBe(
            false,
          ),
      },
      {
        command: 'redact',
        run: (roomId: string, eventId: string) =>
          engine.redact(alice, roomId, eventKey(eventId), NO_THREAD),
        unchanged: (item: EventTimelineItem | undefined) =>
          expect(item?.content.kind).not.toBe('redacted'),
      },
    ])(
      'G16 — $command is refused alone, and the room keeps sending',
      async ({ run, unchanged }) => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          const eventId = await ownMessage(roomId, timeline, 'original');
          const levels = {
            events_default: 50,
            events: { 'm.reaction': 50, 'm.room.redaction': 50 },
          };
          await context.asBob.setPowerLevels(roomId, levels);

          let view: TimelineView | null = null;
          const result = await once(
            run(roomId, eventId).pipe(tap(() => (view = timeline.view()))),
          );

          expect(!result.ok && result.failure.code).toBe('request-failed');
          unchanged(byId(view, eventId));

          await context.asBob.setPowerLevels(roomId, {
            events_default: 0,
            events: { 'm.reaction': 0, 'm.room.redaction': 0 },
          });
          const sent = await ok(
            engine.send(alice, roomId, text('after'), MAIN),
          );
          expect(sent.eventId).toEqual(expect.any(String));
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'cancelSend of a sent message is not-cancellable',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          const { transactionId } = await ok(
            engine.send(alice, roomId, text('too late'), MAIN),
          );

          const result = await once(
            engine.cancelSend(alice, roomId, transactionId),
          );

          expect(!result.ok && result.failure.code).toBe('not-cancellable');
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'retrySend of an unknown transaction is message-unavailable',
      async () => {
        const { roomId } = await roomWith();

        const result = await once(
          engine.retrySend(alice, roomId, `unknown-${unique()}`),
        );

        expect(!result.ok && result.failure.code).toBe('message-unavailable');
      },
      testTimeoutMs,
    );

    it(
      'sendVoice sends an m.audio voice item',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        const restore = context.knownUnencrypted?.();
        try {
          await timeline.until(() => true);

          await ok(
            engine.sendVoice(alice, roomId, {
              blob: new Blob([new Uint8Array([26, 69, 223, 163])], {
                type: 'audio/webm',
              }),
              mimeType: 'audio/webm',
              durationMs: 1200,
              waveform: [0, 512, 1024],
            }),
          );

          const view = await timeline.until((v) =>
            events(v).some(
              (item) => item.isOwn && item.content.kind === 'media',
            ),
          );
          const voice = events(view).find(
            (item) => item.isOwn && item.content.kind === 'media',
          )?.content;
          expect(voice).toMatchObject({
            kind: 'media',
            msgtype: 'audio',
            body: 'Voice message',
            source: { isVoice: true, waveform: [0, 512, 1024] },
          });
        } finally {
          restore?.();
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      "thread focus shows only the root's replies",
      async () => {
        const {
          roomId,
          eventIds: [rootId, otherRootId],
        } = await roomWith(['root', 'other root']);
        const first = await context.asBob.sendInThread(roomId, rootId, 'one');
        await context.asBob.sendInThread(roomId, otherRootId, 'elsewhere');
        const second = await context.asBob.sendInThread(roomId, rootId, 'two');
        await context.asBob.send(roomId, 'main');
        const thread = watch(roomId, { kind: 'thread', rootEventId: rootId });
        try {
          const view = await thread.until((v) => !!byId(v, second));

          expect(events(view).map((item) => item.eventId)).toEqual([
            rootId,
            first,
            second,
          ]);
          expect(bodyOf(byId(view, first))).toBe('one');
          const last = thread.updates.at(-1);
          expect(last?.kind === 'items' && last.room).toMatchObject({
            latestConfirmedEventId: second,
            oldestEventId: rootId,
          });
        } finally {
          thread.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'live focus hides thread replies',
      async () => {
        const {
          roomId,
          eventIds: [rootId],
        } = await roomWith(['root']);
        const timeline = watch(roomId);
        try {
          await timeline.until((v) => !!byId(v, rootId));
          const replyId = await context.asBob.sendInThread(
            roomId,
            rootId,
            'in the thread',
          );
          const mainId = await context.asBob.send(roomId, 'in the room');

          const view = await timeline.until((v) => !!byId(v, mainId));

          expect(byId(view, rootId)).toBeDefined();
          expect(byId(view, replyId)).toBeUndefined();
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'the first threaded send creates the thread',
      async () => {
        const {
          roomId,
          eventIds: [rootId],
        } = await roomWith(['start a thread here']);
        const thread = watch(roomId, { kind: 'thread', rootEventId: rootId });
        const summaries = watchSummaries(roomId);
        try {
          await thread.until((v) => !!byId(v, rootId));

          const sent = await ok(
            engine.send(alice, roomId, text('first reply'), {
              threadRootId: rootId,
              replyTo: null,
            }),
          );

          expect(byTxn(thread.view(), sent.transactionId)).toMatchObject({
            isOwn: true,
            content: { kind: 'message', body: 'first reply' },
          });
          await summaries.until(rootId, (s) => s.replyCount === 1);
          // The relation clients without thread support read too.
          const source = await ok(
            engine.eventSource(alice, roomId, sent.eventId ?? ''),
          );
          expect(source?.['content']).toMatchObject({
            body: 'first reply',
            'm.relates_to': {
              rel_type: 'm.thread',
              event_id: rootId,
              is_falling_back: true,
              'm.in_reply_to': { event_id: rootId },
            },
          });
        } finally {
          summaries.close();
          thread.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'threadSummaries counts replies and participants',
      async () => {
        const {
          roomId,
          eventIds: [rootId],
        } = await roomWith(['root']);
        await context.asBob.sendInThread(roomId, rootId, 'bob replies');
        const summaries = watchSummaries(roomId);
        try {
          await summaries.until(rootId, (s) => s.replyCount === 1);

          await ok(
            engine.send(alice, roomId, text('alice replies'), {
              threadRootId: rootId,
              replyTo: null,
            }),
          );

          const summary = await summaries.until(
            rootId,
            (s) => s.replyCount === 2 && s.participants.length === 2,
          );
          expect(summary.participants).toEqual([bob, alice]);
          expect(summary.root).toMatchObject({ sender: bob, preview: 'root' });
          expect(summary.latestReply).toMatchObject({
            sender: alice,
            preview: 'alice replies',
          });
          expect(summary.profiles[bob]?.displayName).toEqual(
            expect.any(String),
          );
        } finally {
          summaries.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'sendReceipt in a thread replies ok',
      async () => {
        const {
          roomId,
          eventIds: [rootId],
        } = await roomWith(['root']);
        const replyId = await context.asBob.sendInThread(
          roomId,
          rootId,
          'read me in the thread',
        );
        const thread = watch(roomId, { kind: 'thread', rootEventId: rootId });
        try {
          await thread.until((v) => !!byId(v, replyId));
          const fullyReadBefore = await context.asAlice.fullyRead(roomId);

          await expect(
            ok(
              engine.sendReceipt(alice, roomId, replyId, {
                threadRootId: rootId,
                visibility: 'public',
                fullyRead: false,
              }),
            ),
          ).resolves.toBe(null);

          await expect(context.asBob.readReceipt(roomId, alice)).resolves.toBe(
            replyId,
          );
          // A thread has no read marker of its own.
          await expect(context.asAlice.fullyRead(roomId)).resolves.toBe(
            fullyReadBefore,
          );
        } finally {
          thread.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'commands for an unknown account are account-not-live',
      async () => {
        const roomId = '!r:invalid';
        const eventId = '$e:invalid';
        const commands: Observable<EngineResult<unknown>>[] = [
          engine.paginateBackwards(NOBODY, roomId, LIVE, 10),
          engine.paginateUntil(NOBODY, roomId, eventId, 1),
          engine.eventAt(NOBODY, roomId, 0),
          engine.eventSource(NOBODY, roomId, eventId),
          engine.reactionDetails(NOBODY, roomId, eventId),
          engine.sendReceipt(NOBODY, roomId, eventId, {
            threadRootId: null,
            visibility: 'private',
            fullyRead: false,
          }),
          engine.setTyping(NOBODY, roomId, true),
          engine.send(NOBODY, roomId, text('x'), MAIN),
          engine.edit(
            NOBODY,
            roomId,
            eventKey(eventId),
            {
              msgtype: 'text',
              body: 'x',
              formattedBody: null,
              mentions: { userIds: [], room: false },
            },
            NO_THREAD,
          ),
          engine.redact(NOBODY, roomId, eventKey(eventId), NO_THREAD),
          engine.toggleReaction(
            NOBODY,
            roomId,
            eventKey(eventId),
            'x',
            NO_THREAD,
          ),
          engine.retrySend(NOBODY, roomId, 'txn'),
          engine.cancelSend(NOBODY, roomId, 'txn'),
          engine.forward(NOBODY, roomId, eventId, roomId),
          engine.sendVoice(NOBODY, roomId, {
            blob: new Blob([]),
            mimeType: 'audio/webm',
            durationMs: 0,
            waveform: [],
          }),
        ];

        for (const command of commands) {
          const result = await once(command);
          expect(!result.ok && result.failure.code).toBe('account-not-live');
        }
      },
      testTimeoutMs,
    );

    it(
      'timeline for an unknown account is room-unavailable',
      async () => {
        const { roomId } = await roomWith();

        const first = await firstValueFrom(
          engine.timeline(NOBODY, roomId, LIVE).pipe(timeout(settleTimeoutMs)),
        );

        expect(first).toEqual({ kind: 'room-unavailable' });
      },
      testTimeoutMs,
    );

    it(
      'unsubscribing stops emissions',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
        } finally {
          timeline.close();
        }
        const before = timeline.updates.length;

        const eventId = await context.asBob.send(roomId, 'after');
        const after = watch(roomId);
        try {
          await after.until((v) => !!byId(v, eventId));
        } finally {
          after.close();
        }

        expect(timeline.updates).toHaveLength(before);
      },
      testTimeoutMs,
    );
  });
}
