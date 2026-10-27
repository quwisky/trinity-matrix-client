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
import type {
  CreateRoomRequest,
  RoomInfo,
  RoomListEngine,
  SpaceChildLink,
} from '../lib/room-list-engine';

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
    /** Accepts an invite outside the engine. */
    join(roomId: string): Promise<void>;
    /** The spaces named by the room's `m.space.parent` state, read from the server. */
    spaceParents(roomId: string): Promise<readonly string[]>;
  };
  readonly asBob: {
    createRoom(name: string): Promise<string>;
    /** A public room with the alias `#localpart:serverName`. */
    createPublicRoom(
      name: string,
      localpart: string,
    ): Promise<{ readonly roomId: string; readonly alias: string }>;
    join(roomId: string): Promise<void>;
    invite(
      roomId: string,
      userId: string,
      options?: { readonly isDirect?: boolean },
    ): Promise<void>;
    sendTyping(roomId: string): Promise<void>;
    sendMessage(roomId: string, body: string): Promise<void>;
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

    async function createRoom(
      patch: Partial<CreateRoomRequest> = {},
    ): Promise<string> {
      const { roomId } = await ok(
        engine.createRoom(alice, {
          name: `contract ${unique()}`,
          topic: null,
          isPublic: false,
          kind: 'room',
          parentSpaceId: null,
          ...patch,
        }),
      );
      return roomId;
    }

    /** The space's links as an open subscription sees them right now. */
    function linksNow(spaceId: string): Promise<readonly SpaceChildLink[]> {
      return firstValueFrom(
        engine.spaceChildLinks(alice, spaceId).pipe(
          tap((links) => expect(() => assertPlainData(links)).not.toThrow()),
          take(1),
          timeout(settleTimeoutMs),
        ),
      );
    }

    it(
      'rooms emits a snapshot first and every emission is plain data',
      async () => {
        const roomId = await createRoom();

        const first = await firstValueFrom(
          engine.rooms(alice).pipe(timeout(settleTimeoutMs)),
        );

        expect(() => assertPlainData(first)).not.toThrow();
        expect(first).toHaveLength(1);
        expect(first[0].op).toBe('reset');
        await roomUntil(roomId, () => true);
      },
      testTimeoutMs,
    );

    it(
      'typing and directMap emit a snapshot first',
      async () => {
        const sources: Observable<unknown>[] = [
          engine.typing(alice),
          engine.directMap(alice),
        ];
        for (const source of sources) {
          const first = await firstValueFrom(
            source.pipe(timeout(settleTimeoutMs)),
          );
          expect(() => assertPlainData(first)).not.toThrow();
        }
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
        // Bob's room: an unencrypted message only counts toward notifications in an unencrypted
        // room, and rooms created through the engine are encrypted.
        const roomId = await context.asBob.createRoom(`bob ${unique()}`);
        await context.asBob.invite(roomId, alice);
        await roomUntil(roomId, (r) => r.membership === 'invite');
        await context.asAlice.join(roomId);
        await context.asBob.sendMessage(roomId, 'hello');
        await roomUntil(roomId, (r) => r.notificationCount > 0);
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
        await firstValueFrom(
          engine.directMap(alice).pipe(
            filter((map) => map[bob]?.includes(first.roomId) ?? false),
            timeout(settleTimeoutMs),
          ),
        );

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
      'invite into a room alice is not in is request-failed',
      async () => {
        const roomId = await context.asBob.createRoom(`bob ${unique()}`);

        const result = await once(engine.invite(alice, roomId, bob));

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
            kind: 'room',
            parentSpaceId: null,
          }),
          engine.createDirectMessage(NOBODY, bob),
          engine.resolveAlias(NOBODY, '#x:invalid'),
          engine.invite(NOBODY, '!r:invalid', bob),
          engine.join(NOBODY, '!r:invalid', []),
          engine.spaceHierarchy(NOBODY, '!s:invalid', { maxPages: 1 }),
          engine.setSpaceChild(NOBODY, '!s:invalid', '!r:invalid', null),
          engine.setSpaceParent(NOBODY, '!r:invalid', '!s:invalid', []),
        ];

        for (const command of commands) {
          const result = await once(command);
          expect(!result.ok && result.failure.code).toBe('account-not-live');
        }
      },
      testTimeoutMs,
    );

    it(
      'join by alias with via shows the room as joined before it replies',
      async () => {
        const { roomId, alias } = await context.asBob.createPublicRoom(
          `bob ${unique()}`,
          `contract-${unique()}`,
        );

        await expect(
          ok(engine.join(alice, alias, [context.serverName])),
        ).resolves.toEqual({ roomId });

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
      'create a space, link a child, read it from spaceChildLinks',
      async () => {
        const spaceId = await createRoom({ kind: 'space' });
        const childId = await createRoom();
        await roomUntil(spaceId, (r) => r.isSpace);
        const link = { via: [context.serverName], suggested: true, order: 'm' };

        await ok(engine.setSpaceChild(alice, spaceId, childId, link));

        expect(await linksNow(spaceId)).toEqual([{ childId, ...link }]);
      },
      testTimeoutMs,
    );

    it(
      'spaceChildLinks reads an order the spec rejects as empty',
      async () => {
        const spaceId = await createRoom({ kind: 'space' });
        const childId = await createRoom();
        await roomUntil(spaceId, (r) => r.isSpace);
        const link = { via: [context.serverName], suggested: false };

        await ok(
          engine.setSpaceChild(alice, spaceId, childId, {
            ...link,
            order: 'x'.repeat(51),
          }),
        );

        expect(await linksNow(spaceId)).toEqual([
          { childId, ...link, order: '' },
        ]);
      },
      testTimeoutMs,
    );

    it(
      'setSpaceChild null unlinks',
      async () => {
        const spaceId = await createRoom({ kind: 'space' });
        const childId = await createRoom();
        await ok(
          engine.setSpaceChild(alice, spaceId, childId, {
            via: [context.serverName],
            suggested: false,
            order: '',
          }),
        );

        await ok(engine.setSpaceChild(alice, spaceId, childId, null));

        expect(await linksNow(spaceId)).toEqual([]);
      },
      testTimeoutMs,
    );

    it(
      'createRoom with parentSpaceId links both ways',
      async () => {
        const spaceId = await createRoom({ kind: 'space' });

        const childId = await createRoom({ parentSpaceId: spaceId });

        expect(await linksNow(spaceId)).toEqual([
          {
            childId,
            via: [context.serverName],
            suggested: true,
            order: '',
          },
        ]);
        await expect(context.asAlice.spaceParents(childId)).resolves.toEqual([
          spaceId,
        ]);
      },
      testTimeoutMs,
    );

    it(
      'spaceHierarchy lists the space and its child',
      async () => {
        const spaceId = await createRoom({ kind: 'space' });
        const childId = await createRoom({ parentSpaceId: spaceId });

        const entries = await ok(
          engine.spaceHierarchy(alice, spaceId, { maxPages: null }),
        );

        const space = entries.find((e) => e.roomId === spaceId);
        expect(space?.isSpace).toBe(true);
        expect(space?.childrenState.map((l) => l.childId)).toEqual([childId]);
        expect(entries.find((e) => e.roomId === childId)?.isSpace).toBe(false);
      },
      testTimeoutMs,
    );

    it(
      'setSpaceParent writes a parent the server reports',
      async () => {
        const spaceId = await createRoom({ kind: 'space' });
        const childId = await createRoom();

        await ok(
          engine.setSpaceParent(alice, childId, spaceId, [context.serverName]),
        );

        await expect(context.asAlice.spaceParents(childId)).resolves.toEqual([
          spaceId,
        ]);
      },
      testTimeoutMs,
    );

    it(
      'unsubscribing stops emissions',
      async () => {
        const roomId = await createRoom();
        let seen = 0;
        const subscription = engine.rooms(alice).subscribe(() => (seen += 1));
        try {
          await roomUntil(roomId, () => true);
        } finally {
          subscription.unsubscribe();
        }
        const before = seen;

        await ok(engine.setTag(alice, roomId, 'favourite', true));
        await roomUntil(roomId, (r) => r.favourite);

        expect(seen).toBe(before);
      },
      testTimeoutMs,
    );
  });
}
