import {
  BehaviorSubject,
  type Observable,
  filter,
  firstValueFrom,
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
    react(roomId: string, eventId: string, key: string): Promise<void>;
    redact(roomId: string, eventId: string): Promise<void>;
    edit(roomId: string, eventId: string, body: string): Promise<void>;
  };
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

    /** Alice's live timeline of the room, folded and checked for plain data on every update. */
    function watch(roomId: string): Watch {
      const updates: TimelineUpdate[] = [];
      const view$ = new BehaviorSubject<TimelineView | null>(null);
      const subscription = engine
        .timeline(alice, roomId, LIVE)
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
          const page = timeline.updates.slice(mark);
          expect(page[0]).toMatchObject({
            kind: 'items',
            diffs: [],
            backPagination: 'paginating',
          });
          const loaded = page.findIndex(
            (u) => u.kind === 'items' && u.diffs.length > 0,
          );
          expect(loaded).toBeGreaterThan(0);
          expect(page[loaded]).toMatchObject({ backPagination: 'idle' });
          for (const update of page.slice(0, loaded))
            expect(update).toMatchObject({ backPagination: 'paginating' });
          const after = events(timeline.view()).map((item) => item.eventId);
          expect(after.length).toBeGreaterThan(loadedBefore.length);
          expect(after.slice(-loadedBefore.length)).toEqual(loadedBefore);
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
      "sendReceipt with fullyRead moves alice's m.fully_read",
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
        ];

        for (const command of commands) {
          const result = await once(command);
          expect(!result.ok && result.failure.code).toBe('account-not-live');
        }
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
