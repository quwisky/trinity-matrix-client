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
  RoomWidgetEngine,
  RoomWidgetSnapshot,
  RoomWidgetStateContent,
} from '../lib/room-widget-engine';

export interface RoomWidgetContractSetup {
  readonly engine: RoomWidgetEngine;
  /** A live account in `engine`. */
  readonly alice: string;
  /** A registered user on the same server, driven only through `asBob`. */
  readonly bob: string;
  readonly asAlice: {
    /** Joins outside the engine. */
    join(roomId: string): Promise<void>;
  };
  readonly asBob: {
    /** A private room where bob has power level 100 and widget state needs 50. */
    createRoom(name: string): Promise<string>;
    invite(roomId: string, userId: string): Promise<void>;
    setPowerLevel(roomId: string, userId: string, level: number): Promise<void>;
    /** Writes widget state under `stateKey` and returns its event id. */
    putWidget(
      roomId: string,
      stateKey: string,
      content: Readonly<Record<string, unknown>>,
    ): Promise<string>;
  };
  dispose(): Promise<void>;
}

export interface RoomWidgetContractTiming {
  /** How long a change may take to reach a `roomWidgets()` emission. */
  readonly settleTimeoutMs: number;
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

interface WidgetsWatch {
  latest(): RoomWidgetSnapshot | null;
  until(
    predicate: (snapshot: RoomWidgetSnapshot) => boolean,
  ): Promise<RoomWidgetSnapshot>;
  close(): void;
}

const NOBODY = '@nobody:invalid';

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function defineRoomWidgetEngineContract(
  setup: () => Promise<RoomWidgetContractSetup>,
  { settleTimeoutMs, testTimeoutMs }: RoomWidgetContractTiming,
): void {
  describe('RoomWidgetEngine contract', () => {
    let context: RoomWidgetContractSetup;
    let engine: RoomWidgetEngine;
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

    async function failureOf(
      source: Observable<EngineResult<null>>,
    ): Promise<string | null> {
      const result = await once(source);
      return result.ok ? null : result.failure.code;
    }

    function watch(roomId: string, accountId = alice): WidgetsWatch {
      const snapshot$ = new BehaviorSubject<RoomWidgetSnapshot | null>(null);
      const subscription = engine
        .roomWidgets(accountId, roomId)
        .pipe(
          tap((snapshot) =>
            expect(() => assertPlainData(snapshot)).not.toThrow(),
          ),
        )
        .subscribe(snapshot$);
      return {
        latest: () => snapshot$.value,
        until: (predicate) =>
          firstValueFrom(
            snapshot$.pipe(
              filter((s): s is RoomWidgetSnapshot => s !== null),
              filter(predicate),
              timeout(settleTimeoutMs),
            ),
          ),
        close: () => subscription.unsubscribe(),
      };
    }

    /** Bob's room with alice joined; `admin` gives her power to manage widgets. */
    async function sharedRoom(admin: boolean): Promise<string> {
      const roomId = await context.asBob.createRoom(`widgets ${unique()}`);
      if (admin) await context.asBob.setPowerLevel(roomId, alice, 100);
      await context.asBob.invite(roomId, alice);
      await context.asAlice.join(roomId);
      return roomId;
    }

    function content(id: string, type = 'm.custom'): RoomWidgetStateContent {
      return {
        id,
        name: `Widget ${id}`,
        type,
        url: `https://widgets.example/${id}`,
        creatorUserId: alice,
        data: {},
        waitForIframeLoad: true,
      };
    }

    it(
      'roomWidgets emits the empty snapshot at once for an account that is not live',
      () => {
        const seen: RoomWidgetSnapshot[] = [];
        const subscription = engine
          .roomWidgets(NOBODY, '!unknown:invalid')
          .subscribe((s) => seen.push(s));
        subscription.unsubscribe();

        expect(seen).toEqual([
          { widgets: [], canManage: false, identity: null },
        ]);
      },
      testTimeoutMs,
    );

    it(
      "roomWidgets lists bob's widget with the account's identity",
      async () => {
        const roomId = await sharedRoom(false);
        const eventId = await context.asBob.putWidget(roomId, 'board', {
          type: 'm.custom',
          url: 'https://widgets.example/$matrix_room_id',
          name: 'Board',
          data: { title: 'Ignored', board: 'roadmap' },
          waitForIframeLoad: false,
        });
        const widgets = watch(roomId);
        try {
          const snapshot = await widgets.until((s) =>
            s.widgets.some((w) => w.sourceEventId === eventId),
          );

          expect(snapshot.widgets).toEqual([
            {
              id: 'board',
              name: 'Board',
              type: 'm.custom',
              rawUrl: 'https://widgets.example/$matrix_room_id',
              data: { title: 'Ignored', board: 'roadmap' },
              creatorUserId: bob,
              waitForIframeLoad: false,
              sourceEventId: eventId,
            },
          ]);
          expect(snapshot.canManage).toBe(false);
          expect(snapshot.identity).toMatchObject({ userId: alice });
        } finally {
          widgets.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'roomWidgets emits its current snapshot synchronously on subscribe',
      async () => {
        const roomId = await sharedRoom(true);
        const widgets = watch(roomId);
        try {
          await widgets.until((s) => s.canManage);
        } finally {
          widgets.close();
        }

        const seen: RoomWidgetSnapshot[] = [];
        engine
          .roomWidgets(alice, roomId)
          .subscribe((s) => seen.push(s))
          .unsubscribe();

        expect(seen).toHaveLength(1);
        expect(seen[0].canManage).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      'a power level change flips canManage',
      async () => {
        const roomId = await sharedRoom(false);
        const widgets = watch(roomId);
        try {
          await widgets.until((s) => s.identity !== null && !s.canManage);

          await context.asBob.setPowerLevel(roomId, alice, 100);

          await widgets.until((s) => s.canManage);
        } finally {
          widgets.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'putRoomWidget then removeRoomWidget round-trips',
      async () => {
        const roomId = await sharedRoom(true);
        const widgets = watch(roomId);
        try {
          await widgets.until((s) => s.canManage);
          const put = engine.putRoomWidget(alice, roomId, content('mine'));
          // Cold: nothing is written before subscribing.
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(widgets.latest()?.widgets).toEqual([]);

          expect(await failureOf(put)).toBeNull();
          const added = await widgets.until((s) =>
            s.widgets.some((w) => w.id === 'mine'),
          );
          expect(added.widgets).toEqual([
            {
              id: 'mine',
              name: 'Widget mine',
              type: 'm.custom',
              rawUrl: 'https://widgets.example/mine',
              data: {},
              creatorUserId: alice,
              waitForIframeLoad: true,
              sourceEventId: expect.any(String),
            },
          ]);

          const eventId = added.widgets[0].sourceEventId as string;
          expect(
            await failureOf(
              engine.removeRoomWidget(alice, roomId, 'mine', eventId),
            ),
          ).toBeNull();
          await widgets.until((s) => s.widgets.length === 0);
        } finally {
          widgets.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'putRoomWidget over an existing state key is state-key-taken',
      async () => {
        const roomId = await sharedRoom(true);
        await context.asBob.putWidget(roomId, 'taken', {});
        const widgets = watch(roomId);
        try {
          await widgets.until((s) => s.canManage);
          // The tombstone is not listed, so wait for the sync that carries it.
          await context.asBob.putWidget(roomId, 'marker', {
            ...content('marker'),
          });
          await widgets.until((s) => s.widgets.some((w) => w.id === 'marker'));

          expect(
            await failureOf(
              engine.putRoomWidget(alice, roomId, content('taken')),
            ),
          ).toBe('state-key-taken');
        } finally {
          widgets.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'putRoomWidget without power is forbidden',
      async () => {
        const roomId = await sharedRoom(false);
        const widgets = watch(roomId);
        try {
          await widgets.until((s) => s.identity !== null);

          expect(
            await failureOf(
              engine.putRoomWidget(alice, roomId, content('denied')),
            ),
          ).toBe('forbidden');
        } finally {
          widgets.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'removeRoomWidget of a replaced revision is a conflict',
      async () => {
        const roomId = await sharedRoom(true);
        const first = await context.asBob.putWidget(roomId, 'board', {
          ...content('board'),
        });
        const second = await context.asBob.putWidget(roomId, 'board', {
          ...content('board'),
          name: 'Renamed',
        });
        const widgets = watch(roomId);
        try {
          await widgets.until((s) =>
            s.widgets.some((w) => w.sourceEventId === second),
          );

          expect(
            await failureOf(
              engine.removeRoomWidget(alice, roomId, 'board', first),
            ),
          ).toBe('conflict');
        } finally {
          widgets.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'removeRoomWidget of a call widget is unsupported',
      async () => {
        const roomId = await sharedRoom(true);
        const eventId = await context.asBob.putWidget(roomId, 'call', {
          ...content('call', 'm.jitsi'),
        });
        const widgets = watch(roomId);
        try {
          await widgets.until((s) =>
            s.widgets.some((w) => w.sourceEventId === eventId),
          );

          expect(
            await failureOf(
              engine.removeRoomWidget(alice, roomId, 'call', eventId),
            ),
          ).toBe('unsupported');
        } finally {
          widgets.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'commands for an account that is not live are not-signed-in',
      async () => {
        const roomId = '!unknown:invalid';

        expect(
          await failureOf(engine.putRoomWidget(NOBODY, roomId, content('x'))),
        ).toBe('not-signed-in');
        expect(
          await failureOf(engine.removeRoomWidget(NOBODY, roomId, 'x', '$e')),
        ).toBe('not-signed-in');
      },
      testTimeoutMs,
    );
  });
}
