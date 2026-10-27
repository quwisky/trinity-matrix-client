import {
  type Observable,
  filter,
  firstValueFrom,
  scan,
  take,
  tap,
  timeout,
  toArray,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type EngineResult,
  type VectorDiff,
  applyVectorDiffs,
  assertPlainData,
} from '@trinity/util/matrix';
import type { RoomInfo, RoomListEngine } from '../lib/room-list-engine';

export interface RoomListContractSetup {
  readonly engine: RoomListEngine;
  /** A live account in `engine`. */
  readonly alice: string;
  /** A registered user on the same server, driven only through `asBob`. */
  readonly bob: string;
  readonly serverName: string;
  readonly asAlice: {
    /** Publishes `#localpart:serverName` for the room and returns the full alias. */
    publishAlias(roomId: string, localpart: string): Promise<string>;
  };
  readonly asBob: {
    createRoom(name: string): Promise<string>;
    join(roomId: string): Promise<void>;
    invite(
      roomId: string,
      userId: string,
      options?: { readonly isDirect?: boolean },
    ): Promise<void>;
    sendTyping(roomId: string): Promise<void>;
  };
  dispose(): Promise<void>;
}

export interface RoomListContractTiming {
  /** How long a change may take to reach a `rooms()`, `typing()` or `directMap()` emission. */
  readonly settleTimeoutMs: number;
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

const NOBODY = '@nobody:invalid';

function unique(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function defineRoomListEngineContract(
  setup: () => Promise<RoomListContractSetup>,
  { settleTimeoutMs, testTimeoutMs }: RoomListContractTiming,
): void {
  describe('RoomListEngine contract', () => {
    let context: RoomListContractSetup;
    let engine: RoomListEngine;
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

    /** Alice's room list, folded and checked for plain data on every batch. */
    function folded(): Observable<readonly RoomInfo[]> {
      return engine.rooms(alice).pipe(
        tap((batch) => expect(() => assertPlainData(batch)).not.toThrow()),
        scan(
          (list: readonly RoomInfo[], batch: readonly VectorDiff<RoomInfo>[]) =>
            applyVectorDiffs(list, batch),
          [],
        ),
      );
    }

    function roomsUntil(
      predicate: (rooms: readonly RoomInfo[]) => boolean,
    ): Promise<readonly RoomInfo[]> {
      return firstValueFrom(
        folded().pipe(filter(predicate), timeout(settleTimeoutMs)),
      );
    }

    async function roomUntil(
      roomId: string,
      predicate: (room: RoomInfo) => boolean,
    ): Promise<RoomInfo> {
      const rooms = await roomsUntil((list) =>
        list.some((r) => r.roomId === roomId && predicate(r)),
      );
      return rooms.find((r) => r.roomId === roomId) as RoomInfo;
    }

    async function createRoom(): Promise<string> {
      const { roomId } = await ok(
        engine.createRoom(alice, {
          name: `contract ${unique()}`,
          topic: null,
          isPublic: false,
        }),
      );
      return roomId;
    }

    it(
      'rooms emits a snapshot first and every emission is plain data',
      async () => {
        const roomId = await createRoom();

        const first = await firstValueFrom(
          engine.rooms(alice).pipe(timeout(settleTimeoutMs)),
        );

        expect(() => assertPlainData(first)).not.toThrow();
        expect(first.filter((d) => d.op === 'reset')).toHaveLength(1);
        await roomUntil(roomId, () => true);
      },
      testTimeoutMs,
    );

    it(
      'createRoom shows the room as joined before it replies',
      async () => {
        const roomId = await createRoom();

        const snapshot = await firstValueFrom(
          folded().pipe(take(1), timeout(settleTimeoutMs)),
        );

        expect(snapshot.find((r) => r.roomId === roomId)?.membership).toBe(
          'join',
        );
      },
      testTimeoutMs,
    );

    it(
      'setTag favourite and lowPriority round-trip',
      async () => {
        const roomId = await createRoom();

        await ok(engine.setTag(alice, roomId, 'favourite', true));
        await roomUntil(roomId, (r) => r.favourite);
        await ok(engine.setTag(alice, roomId, 'lowPriority', true));
        await roomUntil(roomId, (r) => r.lowPriority);
        await ok(engine.setTag(alice, roomId, 'favourite', false));
        await ok(engine.setTag(alice, roomId, 'lowPriority', false));
        await roomUntil(roomId, (r) => !r.favourite && !r.lowPriority);
      },
      testTimeoutMs,
    );

    it(
      'setMarkedUnread round-trips',
      async () => {
        const roomId = await createRoom();

        await ok(engine.setMarkedUnread(alice, roomId, true));
        await roomUntil(roomId, (r) => r.markedUnread);
        await ok(engine.setMarkedUnread(alice, roomId, false));
        await roomUntil(roomId, (r) => !r.markedUnread);
      },
      testTimeoutMs,
    );

    it(
      'markRead clears notificationCount and markedUnread',
      async () => {
        const roomId = await createRoom();
        await ok(engine.setMarkedUnread(alice, roomId, true));
        await roomUntil(roomId, (r) => r.markedUnread);

        await ok(engine.markRead(alice, roomId, 'public'));

        await roomUntil(
          roomId,
          (r) => !r.markedUnread && r.notificationCount === 0,
        );
      },
      testTimeoutMs,
    );

    it(
      'an invite from bob arrives with inviter and isDirect',
      async () => {
        const roomId = await context.asBob.createRoom(`bob ${unique()}`);

        await context.asBob.invite(roomId, alice, { isDirect: true });

        const room = await roomUntil(roomId, (r) => r.membership === 'invite');
        expect(room.inviter).toEqual({
          userId: bob,
          displayName: expect.any(String),
          isDirect: true,
        });
        expect(room.inviter?.displayName).not.toBe('');
      },
      testTimeoutMs,
    );

    it(
      'leave removes the room',
      async () => {
        const roomId = await createRoom();

        await ok(engine.leave(alice, roomId));

        await roomsUntil((rooms) => rooms.every((r) => r.roomId !== roomId));
      },
      testTimeoutMs,
    );

    it(
      'createDirectMessage reuses the joined DM',
      async () => {
        const first = await ok(engine.createDirectMessage(alice, bob));
        await roomUntil(first.roomId, (r) => r.membership === 'join');

        const second = await ok(engine.createDirectMessage(alice, bob));

        expect(second.roomId).toBe(first.roomId);
      },
      testTimeoutMs,
    );

    it(
      'directMap includes a left DM',
      async () => {
        const { roomId } = await ok(engine.createDirectMessage(alice, bob));

        await ok(engine.leave(alice, roomId));

        const directMap = await firstValueFrom(
          engine.directMap(alice).pipe(
            tap((map) => expect(() => assertPlainData(map)).not.toThrow()),
            filter((map) => map[bob]?.includes(roomId) ?? false),
            timeout(settleTimeoutMs),
          ),
        );
        expect(directMap[bob]).toContain(roomId);
      },
      testTimeoutMs,
    );

    it(
      'resolveAlias resolves a published alias',
      async () => {
        const roomId = await createRoom();
        const alias = await context.asAlice.publishAlias(
          roomId,
          `contract-${unique()}`,
        );

        await expect(ok(engine.resolveAlias(alice, alias))).resolves.toEqual({
          roomId,
        });
      },
      testTimeoutMs,
    );

    it(
      'typing names bob in the room',
      async () => {
        const roomId = await createRoom();
        await ok(engine.invite(alice, roomId, bob));
        await context.asBob.join(roomId);

        await context.asBob.sendTyping(roomId);

        const typing = await firstValueFrom(
          engine.typing(alice).pipe(
            tap((map) => expect(() => assertPlainData(map)).not.toThrow()),
            filter(
              (map) => map[roomId]?.some((m) => m.userId === bob) ?? false,
            ),
            timeout(settleTimeoutMs),
          ),
        );
        expect(typing[roomId]).toContainEqual({
          userId: bob,
          displayName: expect.any(String),
        });
      },
      testTimeoutMs,
    );

    it(
      'invite to an unknown user is request-failed',
      async () => {
        const roomId = await createRoom();

        const result = await once(
          engine.invite(
            alice,
            roomId,
            `@nobody-${unique()}:${context.serverName}`,
          ),
        );

        expect(!result.ok && result.failure.code).toBe('request-failed');
      },
      testTimeoutMs,
    );

    it(
      'commands for an unknown account are account-not-live',
      async () => {
        const commands: Observable<EngineResult<unknown>>[] = [
          engine.setTag(NOBODY, '!r:invalid', 'favourite', true),
          engine.setMarkedUnread(NOBODY, '!r:invalid', true),
          engine.markRead(NOBODY, '!r:invalid', 'private'),
          engine.leave(NOBODY, '!r:invalid'),
          engine.createRoom(NOBODY, {
            name: 'x',
            topic: null,
            isPublic: false,
          }),
          engine.createDirectMessage(NOBODY, bob),
          engine.resolveAlias(NOBODY, '#x:invalid'),
          engine.invite(NOBODY, '!r:invalid', bob),
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
        const roomId = await createRoom();
        let seen = 0;
        const subscription = engine.rooms(alice).subscribe(() => (seen += 1));
        await roomUntil(roomId, () => true);
        subscription.unsubscribe();
        const before = seen;

        await ok(engine.setTag(alice, roomId, 'favourite', true));
        await roomUntil(roomId, (r) => r.favourite);

        expect(seen).toBe(before);
      },
      testTimeoutMs,
    );
  });
}
