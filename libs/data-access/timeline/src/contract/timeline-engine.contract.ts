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
  TimelineRoomState,
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
    /** Sets a state event as bob and returns its event id. */
    sendState(
      roomId: string,
      type: string,
      stateKey: string,
      content: object,
    ): Promise<string>;
    /** Moves bob's public `m.read` receipt to `eventId`. */
    markRead(roomId: string, eventId: string): Promise<void>;
    /** The ids of the events that relate to `eventId` by `relType`, as the server holds them. */
    relations(
      roomId: string,
      eventId: string,
      relType: string,
    ): Promise<readonly string[]>;
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

function threadRelation(rootId: string) {
  return {
    'm.relates_to': {
      rel_type: 'm.thread',
      event_id: rootId,
      is_falling_back: true,
      'm.in_reply_to': { event_id: rootId },
    },
  };
}

const POLL_START = 'org.matrix.msc3381.poll.start';
const POLL_RESPONSE = 'org.matrix.msc3381.poll.response';
const POLL_END = 'org.matrix.msc3381.poll.end';
const POLL_TEXT = 'org.matrix.msc1767.text';

function pollStartContent(
  question: string,
  answers: readonly string[],
  maxSelections: number,
): object {
  return {
    [POLL_START]: {
      question: { [POLL_TEXT]: question, body: question },
      kind: 'org.matrix.msc3381.poll.undisclosed',
      max_selections: maxSelections,
      answers: answers.map((answer) => ({
        id: answer.toLowerCase(),
        [POLL_TEXT]: answer,
      })),
    },
    [POLL_TEXT]: question,
  };
}

function pollResponseContent(pollId: string, answerIds: readonly string[]) {
  return {
    [POLL_RESPONSE]: { answers: answerIds },
    'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
  };
}

function pollEndContent(pollId: string) {
  return {
    [POLL_END]: {},
    [POLL_TEXT]: 'The poll has ended.',
    'm.relates_to': { rel_type: 'm.reference', event_id: pollId },
  };
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

    /** Bob's poll with answers a, b and c in a room alice has joined, watched by alice. */
    async function pollRoom(maxSelections = 1) {
      const { roomId } = await roomWith();
      const timeline = watch(roomId);
      await timeline.until(() => true);
      const pollId = await context.asBob.sendEvent(
        roomId,
        POLL_START,
        pollStartContent('Lunch?', ['A', 'B', 'C'], maxSelections),
      );
      const poll = (v: TimelineView) => {
        const content = byId(v, pollId)?.content;
        return content?.kind === 'poll' ? content.poll : null;
      };
      await timeline.until((v) => poll(v) !== null);
      const vote = (answerIds: readonly string[]) =>
        context.asBob.sendEvent(
          roomId,
          POLL_RESPONSE,
          pollResponseContent(pollId, answerIds),
        );
      const votes = (v: TimelineView) =>
        poll(v)?.options.map((option) => option.votes);
      return { roomId, timeline, pollId, poll, vote, votes };
    }

    it(
      'G13 — a poll end from a member who may not redact does not end it',
      async () => {
        const { roomId, timeline, pollId, poll } = await pollRoom();
        try {
          await ok(
            engine.send(alice, roomId, { kind: 'poll-end', pollId }, MAIN),
          );
          // Bob's marker follows alice's end in sync, so the end has been applied by now.
          const marker = await context.asBob.send(roomId, 'after the end');
          const seen = await timeline.until((v) => !!byId(v, marker));
          expect(poll(seen)?.ended).toBe(false);

          await context.asBob.setPowerLevels(roomId, {
            users: { [alice]: 50 },
          });
          await timeline.until((v) => poll(v)?.ended === true);

          await context.asBob.setPowerLevels(roomId, {
            users: { [alice]: 0 },
          });
          await timeline.until((v) => poll(v)?.ended === false);

          await context.asBob.sendEvent(
            roomId,
            POLL_END,
            pollEndContent(pollId),
          );
          await timeline.until((v) => poll(v)?.ended === true);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      "G13 — the poll's sender can end it at any power level",
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          const started = await ok(
            engine.send(
              alice,
              roomId,
              {
                kind: 'poll-start',
                question: 'Lunch?',
                answers: ['A', 'B'],
                maxSelections: 1,
              },
              MAIN,
            ),
          );
          const pollId = started.eventId;
          expect(pollId).toBeTruthy();
          if (!pollId) return;

          await ok(
            engine.send(alice, roomId, { kind: 'poll-end', pollId }, MAIN),
          );

          await timeline.until((v) => {
            const content = byId(v, pollId)?.content;
            return content?.kind === 'poll' && content.poll.ended;
          });
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      "G13 — a voter's latest response counts",
      async () => {
        const { timeline, poll, vote, votes } = await pollRoom();
        try {
          await vote(['a']);
          await timeline.until((v) => poll(v)?.totalVotes === 1);

          await vote(['b']);
          const view = await timeline.until((v) => votes(v)?.[1] === 1);

          expect(votes(view)).toEqual([0, 1, 0]);
          expect(poll(view)?.totalVotes).toBe(1);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G13 — a spoiled or empty latest response withdraws the vote',
      async () => {
        const { timeline, poll, vote, votes } = await pollRoom();
        try {
          await vote(['a']);
          await timeline.until((v) => poll(v)?.totalVotes === 1);
          await vote(['nope']);
          const spoiled = await timeline.until(
            (v) => poll(v)?.totalVotes === 0,
          );
          expect(votes(spoiled)).toEqual([0, 0, 0]);

          await vote(['a']);
          await timeline.until((v) => poll(v)?.totalVotes === 1);
          await vote([]);
          const empty = await timeline.until((v) => poll(v)?.totalVotes === 0);
          expect(votes(empty)).toEqual([0, 0, 0]);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G13 — a vote after the end does not count',
      async () => {
        const { roomId, timeline, pollId, poll, vote, votes } =
          await pollRoom();
        try {
          await vote(['a']);
          await context.asBob.sendEvent(
            roomId,
            POLL_END,
            pollEndContent(pollId),
          );
          await timeline.until((v) => poll(v)?.ended === true);

          await vote(['b']);
          const marker = await context.asBob.send(roomId, 'after the vote');
          const view = await timeline.until((v) => !!byId(v, marker));

          expect(votes(view)).toEqual([1, 0, 0]);
          expect(poll(view)?.totalVotes).toBe(1);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G13 — a response is cut to max_selections and de-duplicated',
      async () => {
        const { timeline, poll, vote, votes } = await pollRoom(2);
        try {
          await vote(['a', 'a', 'b', 'c']);

          const view = await timeline.until((v) => poll(v)?.totalVotes === 1);

          expect(poll(view)?.maxSelections).toBe(2);
          expect(votes(view)).toEqual([1, 1, 0]);
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
        const {
          roomId,
          eventIds: [joinedId],
        } = await roomWith(['joined']);
        const timeline = watch(roomId);
        try {
          // Bob's message shows once alice's join has synced, so no join resets the timeline.
          await timeline.until((v) => !!byId(v, joinedId));
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
        const {
          roomId,
          eventIds: [joinedId],
        } = await roomWith(['joined']);
        const timeline = watch(roomId);
        try {
          await timeline.until((v) => !!byId(v, joinedId));
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
          const item = byId(view, eventId);
          expect(item).toBeDefined();
          unchanged(item);

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

    /** The `room` of the newest `items` update. */
    function roomOf(timeline: Watch): TimelineRoomState | undefined {
      const last = timeline.updates.filter((u) => u.kind === 'items').at(-1);
      return last?.kind === 'items' ? last.room : undefined;
    }

    const stateChanges = (view: TimelineView | null) =>
      events(view).flatMap((item) =>
        item.content.kind === 'state' ? [item.content.change] : [],
      );

    /** The wire content of the event `eventId`, as `eventSource` returns it. */
    async function contentOf(
      roomId: string,
      eventId: string | null | undefined,
    ): Promise<Record<string, unknown>> {
      expect(eventId).toBeTruthy();
      const source = await ok(
        engine.eventSource(alice, roomId, eventId as string),
      );
      return (source?.['content'] ?? {}) as Record<string, unknown>;
    }

    it(
      'G4 — a thread of 40 replies opens with its root, pages to the start and has no timelineStart item',
      async () => {
        const {
          roomId,
          eventIds: [rootId],
        } = await roomWith(['root']);
        const replyIds: string[] = [];
        for (let n = 1; n <= 40; n++)
          replyIds.push(
            await context.asBob.sendInThread(roomId, rootId, `reply ${n}`),
          );
        const focus: TimelineFocus = { kind: 'thread', rootEventId: rootId };
        const thread = watch(roomId, focus);
        try {
          const opened = await thread.until((v) => !!byId(v, rootId));
          expect(events(opened)[0].eventId).toBe(rootId);

          let startReached = false;
          for (let page = 0; page < 10 && !startReached; page++)
            ({ startReached } = await ok(
              engine.paginateBackwards(alice, roomId, focus, 20),
            ));
          expect(startReached).toBe(true);

          const view = await thread.until(
            (v) => !!byId(v, replyIds[0]) && !!byId(v, replyIds[39]),
          );
          expect(events(view).map((item) => item.eventId)).toEqual([
            rootId,
            ...replyIds,
          ]);
          expect(view.items.some((item) => item.kind === 'timelineStart')).toBe(
            false,
          );
          expect(view.backPagination).toBe('start-reached');
        } finally {
          thread.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G5 — threadSummaries counts unread replies, clears on a thread receipt and highlights a mention',
      async () => {
        const {
          roomId,
          eventIds: [rootId],
        } = await roomWith(['root']);
        const replyId = await context.asBob.sendInThread(
          roomId,
          rootId,
          'unread reply',
        );
        const summaries = watchSummaries(roomId);
        try {
          const unread = await summaries.until(
            rootId,
            (s) => s.unreadCount > 0,
          );
          expect(unread.highlight).toBe(false);

          await ok(
            engine.sendReceipt(alice, roomId, replyId, {
              threadRootId: rootId,
              visibility: 'public',
              fullyRead: false,
            }),
          );
          await summaries.until(rootId, (s) => s.unreadCount === 0);

          await context.asBob.sendEvent(roomId, 'm.room.message', {
            msgtype: 'm.text',
            body: 'look at this, alice',
            'm.mentions': { user_ids: [alice] },
            ...threadRelation(rootId),
          });
          await summaries.until(
            rootId,
            (s) => s.highlight && s.unreadCount > 0,
          );
        } finally {
          summaries.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G6 — a formatted body keeps data-mx-emoticon, names its linked users and flags a mention of alice',
      async () => {
        const { roomId } = await roomWith();
        const formattedBody =
          'hi <img data-mx-emoticon src="mxc://localhost/smile" alt=":smile:" height="32"> ' +
          `<a href="https://matrix.to/#/${alice}">alice</a>`;
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          const mentioned = await context.asBob.sendEvent(
            roomId,
            'm.room.message',
            {
              msgtype: 'm.text',
              body: 'hi :smile: alice',
              format: 'org.matrix.custom.html',
              formatted_body: formattedBody,
              'm.mentions': { user_ids: [alice] },
            },
          );
          const linked = await context.asBob.sendEvent(
            roomId,
            'm.room.message',
            {
              msgtype: 'm.text',
              body: 'hi alice',
              format: 'org.matrix.custom.html',
              formatted_body: `hi <a href="https://matrix.to/#/${alice}">alice</a>`,
            },
          );

          const view = await timeline.until((v) => !!byId(v, linked));

          expect(byId(view, mentioned)?.content).toMatchObject({
            kind: 'message',
            formattedBody,
            mentions: [alice],
            mentionsMe: true,
          });
          expect(byId(view, linked)?.content).toMatchObject({
            kind: 'message',
            mentions: [alice],
            mentionsMe: false,
          });
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G6 — a reply fallback is flagged, not stripped',
      async () => {
        const {
          roomId,
          eventIds: [questionId],
        } = await roomWith(['question']);
        const timeline = watch(roomId);
        try {
          await timeline.until((v) => !!byId(v, questionId));
          const answerId = await context.asBob.sendEvent(
            roomId,
            'm.room.message',
            {
              msgtype: 'm.text',
              body: `> <${bob}> question\n\nanswer`,
              'm.relates_to': { 'm.in_reply_to': { event_id: questionId } },
            },
          );

          const view = await timeline.until((v) => !!byId(v, answerId));

          expect(byId(view, answerId)?.content).toMatchObject({
            kind: 'message',
            body: `> <${bob}> question\n\nanswer`,
            replyFallback: true,
          });
          expect(byId(view, questionId)?.content).toMatchObject({
            replyFallback: false,
          });
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G6 — an emote and a notice keep their msgtype',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          const emoteId = await context.asBob.sendEvent(
            roomId,
            'm.room.message',
            { msgtype: 'm.emote', body: 'waves' },
          );
          const noticeId = await context.asBob.sendEvent(
            roomId,
            'm.room.message',
            { msgtype: 'm.notice', body: 'beep' },
          );

          const view = await timeline.until((v) => !!byId(v, noticeId));

          expect(byId(view, emoteId)?.content).toMatchObject({
            kind: 'message',
            msgtype: 'emote',
            body: 'waves',
          });
          expect(byId(view, noticeId)?.content).toMatchObject({
            kind: 'message',
            msgtype: 'notice',
            body: 'beep',
          });
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G6 — a sticker and an image carry their media source',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          const info = { mimetype: 'image/png', size: 1024, w: 64, h: 48 };
          const stickerId = await context.asBob.sendEvent(roomId, 'm.sticker', {
            body: 'a sticker',
            url: 'mxc://localhost/sticker',
            info,
          });
          const imageId = await context.asBob.sendEvent(
            roomId,
            'm.room.message',
            {
              msgtype: 'm.image',
              body: 'photo.png',
              url: 'mxc://localhost/photo',
              info,
            },
          );

          const view = await timeline.until((v) => !!byId(v, imageId));

          expect(byId(view, stickerId)?.content).toMatchObject({
            kind: 'sticker',
            body: 'a sticker',
            url: 'mxc://localhost/sticker',
            info,
            source: { kind: 'image', mxc: 'mxc://localhost/sticker' },
          });
          expect(byId(view, imageId)?.content).toMatchObject({
            kind: 'media',
            msgtype: 'image',
            body: 'photo.png',
            caption: null,
            source: {
              kind: 'image',
              mxc: 'mxc://localhost/photo',
              mimeType: 'image/png',
            },
          });
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G6 — a rename and a leave are state items with their actor',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          await context.asBob.sendState(roomId, 'm.room.name', '', {
            name: 'Renamed room',
          });
          await context.asBob.sendState(roomId, 'm.room.member', bob, {
            membership: 'leave',
          });

          const view = await timeline.until((v) =>
            stateChanges(v).some(
              (change) =>
                change.kind === 'membership' && change.membership === 'leave',
            ),
          );
          const changes = stateChanges(view);

          expect(changes).toContainEqual(
            expect.objectContaining({
              kind: 'room-name',
              actorId: bob,
              name: 'Renamed room',
            }),
          );
          expect(changes).toContainEqual(
            expect.objectContaining({
              kind: 'membership',
              actorId: bob,
              targetId: bob,
              membership: 'leave',
              previousMembership: 'join',
            }),
          );
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G7 — a message bob has read lists him in readBy, and he is not listed on his own',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          const bobsId = await context.asBob.send(roomId, 'bob wrote this');
          await timeline.until((v) => !!byId(v, bobsId));
          const ownId = await ownMessage(roomId, timeline, 'read by bob');

          await context.asBob.markRead(roomId, ownId);

          const view = await timeline.until(
            (v) => byId(v, ownId)?.readBy.includes(bob) ?? false,
          );
          expect(byId(view, ownId)?.readBy).toEqual([bob]);
          expect(byId(view, ownId)?.profiles[bob]).toBeDefined();
          expect(byId(view, bobsId)?.readBy).toEqual([]);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G7 — the read marker sits between the fully-read event and the next one',
      async () => {
        const {
          roomId,
          eventIds: [readId],
        } = await roomWith(['read']);
        let unreadId = '';
        const reading = watch(roomId);
        try {
          await reading.until((v) => !!byId(v, readId));
          await ok(
            engine.sendReceipt(alice, roomId, readId, {
              threadRootId: null,
              visibility: 'public',
              fullyRead: true,
            }),
          );
          await expect(context.asAlice.fullyRead(roomId)).resolves.toBe(readId);
          unreadId = await context.asBob.send(roomId, 'unread');
          // The marker is captured at subscribe, so reopen only once the open timeline has it.
          await reading.until((v) => !!byId(v, unreadId));
        } finally {
          reading.close();
        }
        const timeline = watch(roomId);
        try {
          const view = await timeline.until((v) => !!byId(v, unreadId));

          const order = view.items.map((item) =>
            item.kind === 'event' ? item.eventId : item.kind,
          );
          const marker = order.indexOf('readMarker');
          expect(marker).toBeGreaterThan(order.indexOf(readId));
          expect(order[marker + 1]).toBe(unreadId);
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G7 — room state reports the encryption state event and a tombstone',
      async () => {
        const { roomId } = await roomWith();
        const timeline = watch(roomId);
        try {
          await timeline.until(() => true);
          expect(roomOf(timeline)).toMatchObject({
            hasEncryptionStateEvent: false,
            tombstone: null,
          });

          await context.asBob.sendState(roomId, 'm.room.encryption', '', {
            algorithm: 'm.megolm.v1.aes-sha2',
          });
          await timeline.until(
            () => roomOf(timeline)?.hasEncryptionStateEvent === true,
          );
          expect(roomOf(timeline)?.encryption).toBe('encrypted');

          const replacementRoomId = `!replacement:${context.serverName}`;
          await context.asBob.sendState(roomId, 'm.room.tombstone', '', {
            body: 'This room has been replaced',
            replacement_room: replacementRoomId,
          });
          await timeline.until(() => roomOf(timeline)?.tombstone != null);
          expect(roomOf(timeline)?.tombstone).toEqual({
            replacementRoomId,
            body: 'This room has been replaced',
          });
        } finally {
          timeline.close();
        }
      },
      testTimeoutMs,
    );

    it.each([
      {
        command: 'reply',
        run: async () => {
          const {
            roomId,
            eventIds: [questionId],
          } = await roomWith(['question']);
          const timeline = watch(roomId);
          try {
            await timeline.until((v) => !!byId(v, questionId));
            const { eventId } = await ok(
              engine.send(alice, roomId, text('answer'), {
                threadRootId: null,
                replyTo: questionId,
              }),
            );

            const content = await contentOf(roomId, eventId);

            expect(content).toMatchObject({
              msgtype: 'm.text',
              body: `> <${bob}> question\n\nanswer`,
              format: 'org.matrix.custom.html',
              'm.relates_to': { 'm.in_reply_to': { event_id: questionId } },
              'm.mentions': { user_ids: [bob] },
            });
            expect(content['formatted_body']).toEqual(
              expect.stringContaining('<mx-reply>'),
            );
          } finally {
            timeline.close();
          }
        },
      },
      {
        command: 'edit',
        run: async () => {
          const { roomId } = await roomWith();
          const timeline = watch(roomId);
          try {
            const originalId = await ownMessage(roomId, timeline, 'tpyo');
            await ok(
              engine.edit(
                alice,
                roomId,
                eventKey(originalId),
                {
                  ...plain('typo'),
                  mentions: { userIds: [bob], room: false },
                },
                NO_THREAD,
              ),
            );

            const [editId] = await context.asBob.relations(
              roomId,
              originalId,
              'm.replace',
            );
            const content = await contentOf(roomId, editId);

            expect(content).toMatchObject({
              msgtype: 'm.text',
              body: '* typo',
              'm.mentions': { user_ids: [bob] },
              'm.new_content': {
                msgtype: 'm.text',
                body: 'typo',
                'm.mentions': { user_ids: [bob] },
              },
              'm.relates_to': { rel_type: 'm.replace', event_id: originalId },
            });
          } finally {
            timeline.close();
          }
        },
      },
      {
        command: 'forward',
        run: async () => {
          const {
            roomId: sourceId,
            eventIds: [questionId],
          } = await roomWith(['question']);
          const { roomId: targetId } = await roomWith();
          const replyId = await context.asBob.sendEvent(
            sourceId,
            'm.room.message',
            {
              msgtype: 'm.text',
              body: `> <${bob}> question\n\nanswer`,
              format: 'org.matrix.custom.html',
              formatted_body:
                '<mx-reply><blockquote>question</blockquote></mx-reply>answer',
              'm.relates_to': { 'm.in_reply_to': { event_id: questionId } },
              'm.mentions': { user_ids: [alice], room: true },
              'x.private': 'not for the next room',
            },
          );
          const source = watch(sourceId);
          const target = watch(targetId);
          try {
            await source.until((v) => !!byId(v, replyId));
            await target.until(() => true);
            await ok(engine.forward(alice, sourceId, replyId, targetId));
            const ownCopy = (v: TimelineView) =>
              events(v).find(
                (item) =>
                  item.isOwn &&
                  item.content.kind === 'message' &&
                  item.eventId !== null,
              );
            const forwardedId = ownCopy(
              await target.until((v) => !!ownCopy(v)),
            )?.eventId;

            const content = await contentOf(targetId, forwardedId);

            expect(content).toMatchObject({
              msgtype: 'm.text',
              body: 'answer',
              formatted_body: 'answer',
            });
            expect(content['m.mentions']).toEqual({});
            expect(content).not.toHaveProperty('m.relates_to');
            expect(content).not.toHaveProperty('x.private');
          } finally {
            target.close();
            source.close();
          }
        },
      },
      {
        command: 'voice',
        run: async () => {
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
                (item) =>
                  item.isOwn &&
                  item.content.kind === 'media' &&
                  item.eventId !== null,
              ),
            );
            const voiceId = events(view).find(
              (item) => item.isOwn && item.content.kind === 'media',
            )?.eventId;

            const content = await contentOf(roomId, voiceId);

            expect(content).toMatchObject({
              msgtype: 'm.audio',
              body: 'Voice message',
              info: { mimetype: 'audio/webm', duration: 1200 },
              'org.matrix.msc3245.voice': {},
              'org.matrix.msc1767.audio': {
                duration: 1200,
                waveform: [0, 512, 1024],
              },
            });
          } finally {
            restore?.();
            timeline.close();
          }
        },
      },
    ])(
      'G8 — $command writes the wire format',
      async ({ run }) => {
        await run();
      },
      testTimeoutMs,
    );

    it(
      'G11 — reactionDetails on an unknown event is message-unavailable',
      async () => {
        const { roomId } = await roomWith();

        const result = await once(
          engine.reactionDetails(alice, roomId, `$unknown-${unique()}`),
        );

        expect(!result.ok && result.failure.code).toBe('message-unavailable');
      },
      testTimeoutMs,
    );

    it(
      'G11 — sendReceipt on an unknown event is message-unavailable',
      async () => {
        const { roomId } = await roomWith();

        const result = await once(
          engine.sendReceipt(alice, roomId, `$unknown-${unique()}`, {
            threadRootId: null,
            visibility: 'public',
            fullyRead: false,
          }),
        );

        expect(!result.ok && result.failure.code).toBe('message-unavailable');
      },
      testTimeoutMs,
    );

    it(
      'G12 — timeline on an invited room emits items, then the join continues',
      async () => {
        const roomId = await context.asBob.createRoom(`timeline ${unique()}`);
        const timeline = watch(roomId);
        try {
          await context.asBob.invite(roomId, alice);
          await timeline.until(() => true);
          const beforeJoin = timeline.updates.filter(
            (update) => update.kind === 'items',
          );
          expect(beforeJoin.length).toBeGreaterThan(0);

          await context.asAlice.join(roomId);
          const eventId = await context.asBob.send(roomId, 'after the join');

          await timeline.until((v) => !!byId(v, eventId));
        } finally {
          timeline.close();
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
