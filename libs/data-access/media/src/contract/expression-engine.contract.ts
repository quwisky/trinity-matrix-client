import {
  BehaviorSubject,
  type Observable,
  type Subscription,
  filter,
  firstValueFrom,
  timeout,
  toArray,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type EngineResult, assertPlainData } from '@trinity/util/matrix';
import type {
  ExpressionEngine,
  PackRoomSnapshot,
} from '../lib/expression-engine';
import { IMAGE_PACK_EVENT_TYPE } from '../lib/image-pack.model';

export interface ExpressionContractSetup {
  readonly engine: ExpressionEngine;
  /** A live account in `engine`. */
  readonly alice: string;
  /** A room alice created (so she may write its pack), as the engine sees it. */
  ownRoom(): Promise<string>;
  /** Alice leaves `roomId`. */
  leave(roomId: string): Promise<void>;
  /**
   * A public, world-readable room another user created with `name`, an alias and `pack` as its
   * `m.room.image_pack` under state key `""`. Alice is not in it and may not write state there.
   */
  foreignPackRoom(
    name: string,
    pack: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly roomId: string; readonly alias: string }>;
  dispose(): Promise<void>;
}

export interface ExpressionContractTiming {
  /** How long a change may take to reach a subscription. */
  readonly settleTimeoutMs: number;
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

interface Watch<T> {
  readonly emissions: T[];
  until(predicate: (value: T) => boolean): Promise<T>;
}

const NOBODY = '@nobody:invalid';
const NO_ROOM = '!missing:invalid';

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A null-prototype map holding a `__proto__` key, as the management service writes. */
function protoKeyed(value: unknown): Record<string, unknown> {
  const map = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(map, '__proto__', {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return map;
}

function hasProtoKey(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.hasOwn(value, '__proto__')
  );
}

export function defineExpressionEngineContract(
  setup: () => Promise<ExpressionContractSetup>,
  { settleTimeoutMs, testTimeoutMs }: ExpressionContractTiming,
): void {
  describe('ExpressionEngine contract', () => {
    let context: ExpressionContractSetup;
    let engine: ExpressionEngine;
    let alice: string;
    let subscriptions: Subscription[];

    beforeEach(async () => {
      context = await setup();
      ({ engine, alice } = context);
      subscriptions = [];
    }, testTimeoutMs);

    afterEach(async () => {
      for (const subscription of subscriptions) subscription.unsubscribe();
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

    /** Subscribes; every emission must be plain data, and the first must arrive at once. */
    function watch<T>(source: Observable<T>): Watch<T> {
      const emissions: T[] = [];
      const latest = new BehaviorSubject<T[]>(emissions);
      subscriptions.push(
        source.subscribe((value) => {
          expect(() => assertPlainData(value)).not.toThrow();
          emissions.push(value);
          latest.next(emissions);
        }),
      );
      return {
        emissions,
        until: (predicate) =>
          firstValueFrom(
            latest.pipe(
              filter((all) => all.length > 0 && predicate(all.at(-1) as T)),
              timeout(settleTimeoutMs),
            ),
          ).then((all) => all.at(-1) as T),
      };
    }

    function room(
      rooms: readonly PackRoomSnapshot[],
      roomId: string,
    ): PackRoomSnapshot {
      const found = rooms.find((entry) => entry.roomId === roomId);
      if (!found) throw new Error(`No snapshot for ${roomId}`);
      return found;
    }

    it(
      'emits an account-data snapshot first, null for an absent type',
      async () => {
        const type = `org.trinity.test.${unique()}`;
        const data = watch(engine.accountData(alice, [type]));

        const first = await data.until(() => true);

        expect(first).toEqual({ [type]: null });
      },
      testTimeoutMs,
    );

    it(
      're-emits for a change to a subscribed type but not for an unrelated type',
      async () => {
        const watched = `org.trinity.test.${unique()}`;
        const unrelated = `org.trinity.test.${unique()}`;
        const data = watch(engine.accountData(alice, [watched]));
        await data.until(() => true);

        await ok(engine.setAccountData(alice, unrelated, { n: 1 }));
        await ok(engine.setAccountData(alice, watched, { n: 2 }));
        await data.until((snapshot) => snapshot[watched] !== null);

        expect(data.emissions).toEqual([
          { [watched]: null },
          { [watched]: { n: 2 } },
        ]);
      },
      testTimeoutMs,
    );

    it(
      'fetches the server copy of account data, null when absent',
      async () => {
        const type = `org.trinity.test.${unique()}`;

        expect(await ok(engine.fetchAccountData(alice, type))).toBeNull();
        expect(
          await ok(engine.setAccountData(alice, type, { kept: true })),
        ).toBeNull();
        expect(await ok(engine.fetchAccountData(alice, type))).toEqual({
          kept: true,
        });
      },
      testTimeoutMs,
    );

    it(
      'round-trips a __proto__ key through account data',
      async () => {
        const type = `org.trinity.test.${unique()}`;

        await ok(
          engine.setAccountData(alice, type, {
            rooms: protoKeyed({ '': {} }),
          }),
        );
        const fetched = (await ok(engine.fetchAccountData(alice, type))) as {
          rooms: unknown;
        };

        expect(hasProtoKey(fetched.rooms)).toBe(true);
      },
      testTimeoutMs,
    );

    it(
      'round-trips a __proto__ state key and content key through room state',
      async () => {
        const roomId = await context.ownRoom();
        const type = `org.trinity.test.${unique()}`;

        expect(
          await ok(
            engine.setRoomState(alice, roomId, type, '__proto__', {
              images: protoKeyed({ url: 'mxc://hs/a' }),
            }),
          ),
        ).toBeNull();
        const fetched = (await ok(
          engine.fetchRoomState(alice, roomId, type, '__proto__'),
        )) as { images: unknown };

        expect(hasProtoKey(fetched.images)).toBe(true);
        expect(
          await ok(engine.fetchRoomState(alice, roomId, type, 'absent')),
        ).toBeNull();
      },
      testTimeoutMs,
    );

    it(
      'reflects pack state, power and name in packRooms for a room alice owns',
      async () => {
        const roomId = await context.ownRoom();
        const rooms = watch(engine.packRooms(alice, [roomId]));
        const before = room(
          await rooms.until((all) => room(all, roomId).joined),
          roomId,
        );
        expect(before.canWritePack).toBe(true);

        const pack = { pack: { display_name: 'Mine' }, images: {} };
        await ok(
          engine.setRoomState(alice, roomId, IMAGE_PACK_EVENT_TYPE, '', pack),
        );
        const after = await rooms.until(
          (all) => room(all, roomId).packEvents.length > 0,
        );

        expect(room(after, roomId).packEvents).toEqual([
          { type: IMAGE_PACK_EVENT_TYPE, state_key: '', content: pack },
        ]);
      },
      testTimeoutMs,
    );

    it(
      'reports no pack write for a room alice has left',
      async () => {
        const roomId = await context.ownRoom();
        const rooms = watch(engine.packRooms(alice, [roomId]));
        await rooms.until((all) => room(all, roomId).canWritePack);

        await context.leave(roomId);
        const left = await rooms.until((all) => !room(all, roomId).joined);

        expect(room(left, roomId).canWritePack).toBe(false);
      },
      testTimeoutMs,
    );

    it(
      'joins a pack room by alias and reflects the join in packRooms',
      async () => {
        const name = `Pack ${unique()}`;
        const pack = { pack: { display_name: name }, images: {} };
        const { roomId, alias } = await context.foreignPackRoom(name, pack);
        const rooms = watch(engine.packRooms(alice, [NO_ROOM, roomId]));
        const before = await rooms.until(() => true);
        expect(before.map((entry) => entry.roomId)).toEqual([NO_ROOM, roomId]);
        expect(room(before, roomId)).toMatchObject({
          joined: false,
          name: null,
        });

        const joined = await ok(engine.joinPackRoom(alice, alias));

        expect(joined.roomId).toBe(roomId);
        expect(joined.roomName).toBe(name);
        expect(joined.events).toContainEqual({
          type: IMAGE_PACK_EVENT_TYPE,
          state_key: '',
          content: pack,
        });
        const all = await rooms.until(
          (latest) =>
            room(latest, roomId).joined &&
            room(latest, roomId).packEvents.length > 0,
        );
        expect(room(all, roomId)).toEqual({
          roomId,
          joined: true,
          name,
          canWritePack: false,
          packEvents: [
            { type: IMAGE_PACK_EVENT_TYPE, state_key: '', content: pack },
          ],
        });
        expect(room(all, NO_ROOM)).toEqual({
          roomId: NO_ROOM,
          joined: false,
          name: null,
          canWritePack: false,
          packEvents: [],
        });
      },
      testTimeoutMs,
    );

    it(
      'keeps the name of a pack room alice has left',
      async () => {
        const name = `Pack ${unique()}`;
        const { alias } = await context.foreignPackRoom(name, { images: {} });
        const { roomId } = await ok(engine.joinPackRoom(alice, alias));
        const rooms = watch(engine.packRooms(alice, [roomId]));
        await rooms.until((all) => room(all, roomId).joined);

        await context.leave(roomId);
        const left = await rooms.until((all) => !room(all, roomId).joined);

        expect(room(left, roomId).name).toBe(name);
      },
      testTimeoutMs,
    );

    it(
      "reads a world-readable room's state without joining it",
      async () => {
        const pack = { pack: { display_name: 'Open' }, images: {} };
        const { roomId } = await context.foreignPackRoom('Open', pack);

        expect(
          await ok(
            engine.fetchRoomState(alice, roomId, IMAGE_PACK_EVENT_TYPE, ''),
          ),
        ).toEqual(pack);
      },
      testTimeoutMs,
    );

    it(
      'refuses a pack write without the power as a permission failure',
      async () => {
        const { alias } = await context.foreignPackRoom('Locked', {
          images: {},
        });
        const { roomId } = await ok(engine.joinPackRoom(alice, alias));

        const result = await once(
          engine.setRoomState(alice, roomId, IMAGE_PACK_EVENT_TYPE, '', {
            images: {},
          }),
        );

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.failure.code).toBe('request-failed');
          expect(result.failure.kind).toBe('permission');
        }
      },
      testTimeoutMs,
    );

    it(
      'fails commands for an account that is not live and emits empty snapshots',
      async () => {
        const failure = async (
          source: Observable<EngineResult<unknown>>,
        ): Promise<string> => {
          const result = await once(source);
          return result.ok ? 'ok' : result.failure.code;
        };

        expect(await failure(engine.fetchAccountData(NOBODY, 'x'))).toBe(
          'account-not-live',
        );
        expect(await failure(engine.setAccountData(NOBODY, 'x', {}))).toBe(
          'account-not-live',
        );
        expect(
          await failure(engine.fetchRoomState(NOBODY, NO_ROOM, 'x', '')),
        ).toBe('account-not-live');
        expect(
          await failure(engine.setRoomState(NOBODY, NO_ROOM, 'x', '', {})),
        ).toBe('account-not-live');
        expect(await failure(engine.joinPackRoom(NOBODY, NO_ROOM))).toBe(
          'account-not-live',
        );
        expect(
          await watch(engine.accountData(NOBODY, ['x'])).until(() => true),
        ).toEqual({ x: null });
        expect(
          await watch(engine.packRooms(NOBODY, [NO_ROOM])).until(() => true),
        ).toEqual([
          {
            roomId: NO_ROOM,
            joined: false,
            name: null,
            canWritePack: false,
            packEvents: [],
          },
        ]);
      },
      testTimeoutMs,
    );
  });
}
