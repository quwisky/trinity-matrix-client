import {
  BehaviorSubject,
  type Observable,
  filter,
  firstValueFrom,
  tap,
  timeout,
  toArray,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EngineResult, assertPlainData } from '@trinity/util/matrix';
import type {
  ConversationContentEngine,
  PinnedEvents,
} from '../lib/conversation-content-engine';

export interface ConversationContentContractSetup {
  readonly engine: ConversationContentEngine;
  /** A live account in `engine`. */
  readonly alice: string;
  /** A registered user on the same server, driven only through `asBob`. */
  readonly bob: string;
  /** A page the homeserver can fetch and preview. */
  readonly previewableUrl: string;
  readonly asAlice: {
    /** Joins outside the engine. */
    join(roomId: string): Promise<void>;
    /** Sends a text message outside the engine and returns its event id. */
    send(roomId: string, body: string): Promise<string>;
    /** Sends an `m.replace` edit and returns its event id. */
    edit(roomId: string, eventId: string, body: string): Promise<string>;
  };
  readonly asBob: {
    /** A private room whose history alice sees once she joins; unencrypted unless asked. */
    createRoom(
      name: string,
      options?: { readonly encrypted?: boolean },
    ): Promise<string>;
    invite(roomId: string, userId: string): Promise<void>;
    /** Gives `userId` power level 100. */
    promote(roomId: string, userId: string): Promise<void>;
    /** Sends a text message and returns its event id. */
    send(roomId: string, body: string): Promise<string>;
    /** Sends an `m.replace` edit and returns its event id. */
    edit(roomId: string, eventId: string, body: string): Promise<string>;
    /** Replaces the room's `m.room.pinned_events` list. */
    setPinned(roomId: string, eventIds: readonly unknown[]): Promise<void>;
    /** The room's `m.room.pinned_events` list exactly as the server holds it. */
    pinnedList(roomId: string): Promise<readonly unknown[]>;
  };
  dispose(): Promise<void>;
}

export interface ConversationContentContractTiming {
  /** How long a change may take to reach the engine, and a search index. */
  readonly settleTimeoutMs: number;
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

interface PinsWatch {
  latest(): PinnedEvents | null;
  until(predicate: (state: PinnedEvents) => boolean): Promise<PinnedEvents>;
  close(): void;
}

const NOBODY = '@nobody:invalid';
/** Never fetched: answering for it at all means a request was made. */
const UNREACHABLE_URL = 'https://unreachable.invalid/page';

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function defineConversationContentEngineContract(
  setup: () => Promise<ConversationContentContractSetup>,
  { settleTimeoutMs, testTimeoutMs }: ConversationContentContractTiming,
): void {
  describe('ConversationContentEngine contract', () => {
    let context: ConversationContentContractSetup;
    let engine: ConversationContentEngine;
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

    /** Repeats `command` until its value satisfies `done`: sync and search indexing lag. */
    async function eventually<T>(
      command: () => Observable<EngineResult<T>>,
      done: (value: T) => boolean,
    ): Promise<T> {
      const deadline = Date.now() + settleTimeoutMs;
      for (;;) {
        const result = await once(command());
        if (result.ok && done(result.value)) return result.value;
        if (Date.now() > deadline) {
          throw new Error(`Never settled: ${JSON.stringify(result)}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }

    function watchPins(roomId: string): PinsWatch {
      const state$ = new BehaviorSubject<PinnedEvents | null>(null);
      const subscription = engine
        .pinnedEvents(alice, roomId)
        .pipe(
          tap((state) => expect(() => assertPlainData(state)).not.toThrow()),
        )
        .subscribe(state$);
      return {
        latest: () => state$.value,
        until: (predicate) =>
          firstValueFrom(
            state$.pipe(
              filter((state): state is PinnedEvents => state !== null),
              filter(predicate),
              timeout(settleTimeoutMs),
            ),
          ),
        close: () => subscription.unsubscribe(),
      };
    }

    /** Bob's room with `bodies` sent before alice joins; returns their event ids in order. */
    async function roomWith(
      bodies: readonly string[],
      options: { readonly encrypted?: boolean; readonly admin?: boolean } = {},
    ): Promise<{ readonly roomId: string; readonly eventIds: string[] }> {
      const roomId = await context.asBob.createRoom(`content ${unique()}`, {
        encrypted: options.encrypted,
      });
      const eventIds: string[] = [];
      for (const body of bodies) {
        eventIds.push(await context.asBob.send(roomId, body));
      }
      if (options.admin) await context.asBob.promote(roomId, alice);
      await context.asBob.invite(roomId, alice);
      await context.asAlice.join(roomId);
      return { roomId, eventIds };
    }

    it(
      'pinnedEvents lists a pinned event as loaded',
      async () => {
        const {
          roomId,
          eventIds: [eventId],
        } = await roomWith(['pin me']);
        await context.asBob.setPinned(roomId, [eventId]);
        const pins = watchPins(roomId);
        try {
          const state = await pins.until((s) =>
            s.entries.some(
              (e) => e.eventId === eventId && e.status === 'loaded',
            ),
          );

          expect(state.eventIds).toEqual([eventId]);
          expect(state.entries[0]).toMatchObject({
            eventId,
            status: 'loaded',
            sender: bob,
            body: 'pin me',
            shield: null,
            unencryptedMark: null,
          });
          expect(state.entries[0].ts).toBeGreaterThan(0);
        } finally {
          pins.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'pin then unpin round-trips',
      async () => {
        const {
          roomId,
          eventIds: [first, second],
        } = await roomWith(['first', 'second'], { admin: true });
        await context.asBob.setPinned(roomId, [first]);
        const pins = watchPins(roomId);
        try {
          await pins.until((s) => s.eventIds.includes(first));

          await ok(engine.pin(alice, roomId, second));
          // The reply follows the change into every open subscription.
          expect(pins.latest()?.eventIds).toEqual([first, second]);

          await ok(engine.unpin(alice, roomId, second));
          expect(pins.latest()?.eventIds).toEqual([first]);
        } finally {
          pins.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G9 — a bad pin id is unavailable beside a loaded one, and retryFailedPins keeps it so',
      async () => {
        const {
          roomId,
          eventIds: [real],
        } = await roomWith(['real']);
        const missing = 'not-an-event-id';
        await context.asBob.setPinned(roomId, [missing, real]);
        const pins = watchPins(roomId);
        try {
          const state = await pins.until(
            (s) =>
              s.entries.length === 2 &&
              s.entries.every((e) => e.status !== 'loading'),
          );
          const entry = state.entries.find((e) => e.eventId === missing);
          expect(entry).toBeDefined();
          expect(entry?.status).toBe('unavailable');
          expect(entry).toMatchObject({ sender: '', body: '', ts: 0 });

          await ok(engine.retryFailedPins(alice, roomId));

          const after = await pins.until(
            (s) =>
              s.entries.length === 2 &&
              s.entries.every((e) => e.status !== 'loading'),
          );
          expect(after.eventIds).toEqual([missing, real]);
          expect(after.entries.find((e) => e.eventId === real)?.status).toBe(
            'loaded',
          );
          expect(after.entries.find((e) => e.eventId === missing)?.status).toBe(
            'unavailable',
          );
        } finally {
          pins.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G9 — non-string pins stay in the list and are written back by pin and unpin',
      async () => {
        const {
          roomId,
          eventIds: [first, second],
        } = await roomWith(['first', 'second'], { admin: true });
        await context.asBob.setPinned(roomId, [42, first, null]);
        const pins = watchPins(roomId);
        try {
          const state = await pins.until((s) => s.eventIds.includes(first));
          expect(state.eventIds).toEqual([first]);
          expect(state.allEventIds).toEqual([first]);
          expect(state.entries.map((e) => e.eventId)).toEqual([first]);

          await ok(engine.pin(alice, roomId, second));
          expect(await context.asBob.pinnedList(roomId)).toEqual([
            42,
            first,
            null,
            second,
          ]);

          await ok(engine.unpin(alice, roomId, first));
          expect(await context.asBob.pinnedList(roomId)).toEqual([
            42,
            null,
            second,
          ]);
        } finally {
          pins.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'G9 — allEventIds lists every pin beyond the newest 100',
      async () => {
        const { roomId } = await roomWith([]);
        const ids = Array.from({ length: 105 }, (_, i) => `$p${i}${unique()}`);
        await context.asBob.setPinned(roomId, ids);
        const pins = watchPins(roomId);
        try {
          const state = await pins.until((s) => s.allEventIds.length > 0);

          expect(state.allEventIds).toEqual(ids);
          expect(state.eventIds).toEqual(ids.slice(5));
        } finally {
          pins.close();
        }
      },
      testTimeoutMs,
    );

    it(
      "searchMessages finds bob's message",
      async () => {
        const term = `needle${unique()}`;
        const {
          roomId,
          eventIds: [eventId],
        } = await roomWith([`a ${term} here`, 'something else']);

        const found = await eventually(
          () => engine.searchMessages(alice, roomId, term, null),
          (value) => 'hits' in value && value.hits.length > 0,
        );

        expect(found).toMatchObject({ count: 1, nextBatch: null });
        if (!('hits' in found)) return;
        expect(found.hits).toEqual([
          expect.objectContaining({
            eventId,
            sender: bob,
            body: `a ${term} here`,
          }),
        ]);
      },
      testTimeoutMs,
    );

    it(
      'G10 — searchMessages pages with nextBatch, newest first',
      async () => {
        const term = `pager${unique()}`;
        const bodies = Array.from({ length: 12 }, (_, i) => `${term} ${i}`);
        const { roomId, eventIds } = await roomWith(bodies);

        const first = await eventually(
          () => engine.searchMessages(alice, roomId, term, null),
          (value) => 'hits' in value && value.count === 12,
        );
        if (!('hits' in first)) throw new Error('room reported as encrypted');
        expect(first.nextBatch).toEqual(expect.any(String));
        expect(first.hits.length).toBeGreaterThan(0);
        expect(first.hits.length).toBeLessThan(12);

        const second = await ok(
          engine.searchMessages(alice, roomId, term, first.nextBatch),
        );
        if (!('hits' in second)) throw new Error('room reported as encrypted');

        expect(second.nextBatch).toBeNull();
        expect(
          [...first.hits, ...second.hits].map((hit) => hit.eventId),
        ).toEqual([...eventIds].reverse());
      },
      testTimeoutMs,
    );

    it(
      'G10 — searchMessages with an empty term replies with no hits',
      async () => {
        const { roomId } = await roomWith(['something']);

        const result = await once(
          engine.searchMessages(alice, roomId, '  ', null),
        );

        expect(result).toEqual({
          ok: true,
          value: { hits: [], count: 0, nextBatch: null },
        });
      },
      testTimeoutMs,
    );

    it(
      'G10 — searchMessages in an unknown room is message-unavailable',
      async () => {
        const result = await once(
          engine.searchMessages(
            alice,
            `!unknown${unique()}:invalid`,
            'x',
            null,
          ),
        );

        expect(!result.ok && result.failure.code).toBe('message-unavailable');
      },
      testTimeoutMs,
    );

    it(
      "editHistory lists bob's revisions oldest first",
      async () => {
        const {
          roomId,
          eventIds: [eventId],
        } = await roomWith(['draft']);
        const firstEdit = await context.asBob.edit(roomId, eventId, 'better');
        const secondEdit = await context.asBob.edit(roomId, eventId, 'best');

        const history = await eventually(
          () => engine.editHistory(alice, roomId, eventId, { maxPages: 10 }),
          (value) => value.revisions.length === 3,
        );

        expect(history.truncated).toBe(false);
        expect(
          history.revisions.map(({ eventId, sender, kind, body }) => ({
            eventId,
            sender,
            kind,
            body,
          })),
        ).toEqual([
          { eventId, sender: bob, kind: 'text', body: 'draft' },
          { eventId: firstEdit, sender: bob, kind: 'text', body: 'better' },
          { eventId: secondEdit, sender: bob, kind: 'text', body: 'best' },
        ]);
      },
      testTimeoutMs,
    );

    it(
      'removeRevision redacts a revision',
      async () => {
        const { roomId } = await roomWith([]);
        const eventId = await context.asAlice.send(roomId, 'mine');
        const editId = await context.asAlice.edit(
          roomId,
          eventId,
          'mine, fixed',
        );
        await eventually(
          () => engine.editHistory(alice, roomId, eventId, { maxPages: 10 }),
          (value) => value.revisions.length === 2,
        );

        await ok(engine.removeRevision(alice, roomId, editId));

        const history = await ok(
          engine.editHistory(alice, roomId, eventId, { maxPages: 10 }),
        );
        expect(history.revisions.map((r) => r.eventId)).toEqual([eventId]);
      },
      testTimeoutMs,
    );

    it(
      'linkPreview of a page the homeserver can fetch replies with its title',
      async () => {
        const preview = await ok(
          engine.linkPreview(alice, context.previewableUrl, {
            onlyIfUnencrypted: null,
          }),
        );

        expect(preview?.title).toEqual(expect.any(String));
      },
      testTimeoutMs,
    );

    it(
      'linkPreview onlyIfUnencrypted refuses an encrypted room without a request',
      async () => {
        const { roomId } = await roomWith([], { encrypted: true });
        // Until alice's client knows the room, an unknown room would refuse just the same.
        await eventually(
          () => engine.searchMessages(alice, roomId, 'x', null),
          (value) => 'encrypted' in value,
        );

        const result = await once(
          engine.linkPreview(alice, UNREACHABLE_URL, {
            onlyIfUnencrypted: roomId,
          }),
        );

        expect(result).toEqual({ ok: true, value: null });
      },
      testTimeoutMs,
    );

    it(
      'linkPreview onlyIfUnencrypted previews in an unencrypted room',
      async () => {
        const { roomId } = await roomWith([]);
        await eventually(
          () => engine.searchMessages(alice, roomId, 'x', null),
          (value) => 'hits' in value,
        );

        const preview = await ok(
          engine.linkPreview(alice, context.previewableUrl, {
            onlyIfUnencrypted: roomId,
          }),
        );

        expect(preview?.title).toEqual(expect.any(String));
      },
      testTimeoutMs,
    );

    it(
      'commands for an unknown account are account-not-live',
      async () => {
        const roomId = '!unknown:invalid';
        const commands: Observable<EngineResult<unknown>>[] = [
          engine.pin(NOBODY, roomId, '$e'),
          engine.unpin(NOBODY, roomId, '$e'),
          engine.retryFailedPins(NOBODY, roomId),
          engine.searchMessages(NOBODY, roomId, 'x', null),
          engine.editHistory(NOBODY, roomId, '$e', { maxPages: 1 }),
          engine.removeRevision(NOBODY, roomId, '$e'),
          engine.linkPreview(NOBODY, context.previewableUrl, {
            onlyIfUnencrypted: null,
          }),
        ];

        for (const command of commands) {
          const result = await once(command);
          expect(!result.ok && result.failure.code).toBe('account-not-live');
        }
      },
      testTimeoutMs,
    );
  });
}
