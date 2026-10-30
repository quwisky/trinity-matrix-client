import {
  BehaviorSubject,
  type Observable,
  filter,
  firstValueFrom,
  scan,
  take,
  tap,
  timeout,
  toArray,
} from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
} from 'vitest';
import {
  type EngineResult,
  type VectorDiff,
  applyVectorDiffs,
  assertPlainData,
} from '@trinity/util/matrix';
import type {
  CreateRoomRequest,
  InviteBlocking,
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
  /** Whether the server advertises MSC4380 invite blocking, as `/versions` reports it. */
  readonly serverBlocksInvites: boolean;
  readonly asAlice: {
    /** Publishes `#localpart:serverName` for the room and returns the full alias. */
    publishAlias(roomId: string, localpart: string): Promise<string>;
    /** Accepts an invite outside the engine. */
    join(roomId: string): Promise<void>;
    /** The spaces named by the room's `m.space.parent` state, read from the server. */
    spaceParents(roomId: string): Promise<readonly string[]>;
  };
  readonly asBob: {
    createRoom(
      name: string,
      options?: { readonly historyVisibility?: RoomInfo['historyVisibility'] },
    ): Promise<string>;
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

    /** A new subscription's first batch: the list as the engine holds it right now. */
    function snapshotNow(): Promise<readonly RoomInfo[]> {
      return firstValueFrom(folded().pipe(take(1), timeout(settleTimeoutMs)));
    }

    async function invitedByBob(
      historyVisibility?: RoomInfo['historyVisibility'],
    ): Promise<string> {
      const roomId = await context.asBob.createRoom(`bob ${unique()}`, {
        historyVisibility,
      });
      await context.asBob.invite(roomId, alice);
      await roomUntil(roomId, (r) => r.membership === 'invite');
      return roomId;
    }

    function request(
      patch: Partial<CreateRoomRequest> = {},
    ): CreateRoomRequest {
      return {
        name: `contract ${unique()}`,
        topic: null,
        isPublic: false,
        kind: 'room',
        parentSpaceId: null,
        ...patch,
      };
    }

    async function createRoom(
      patch: Partial<CreateRoomRequest> = {},
    ): Promise<string> {
      const { roomId } = await ok(engine.createRoom(alice, request(patch)));
      return roomId;
    }

    /** Alice's open subscription to `source`: its latest value, closed when the test finishes. */
    function track<T>(source: Observable<T>): BehaviorSubject<T | null> {
      const latest = new BehaviorSubject<T | null>(null);
      const open = source
        .pipe(
          tap((value) => expect(() => assertPlainData(value)).not.toThrow()),
        )
        .subscribe((value) => latest.next(value));
      onTestFinished(() => open.unsubscribe());
      return latest;
    }

    /** The command's value, with what `latest` held at the moment it replied. */
    async function atReply<T, S>(
      command: Observable<EngineResult<T>>,
      latest: { readonly value: S },
    ): Promise<{ readonly value: T; readonly seen: S }> {
      let seen = latest.value;
      const value = await ok<T>(
        command.pipe(
          tap(() => {
            seen = latest.value;
          }),
        ),
      );
      return { value, seen };
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

    /** Waits until an open subscription's latest value satisfies the predicate. */
    function latestUntil<T>(
      latest: BehaviorSubject<T | null>,
      predicate: (value: T) => boolean,
    ): Promise<T> {
      return firstValueFrom(
        latest.pipe(
          filter((value): value is T => value !== null && predicate(value)),
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

    function blockingUntil(
      predicate: (state: InviteBlocking) => boolean,
    ): Promise<InviteBlocking> {
      return firstValueFrom(
        engine.inviteBlocking(alice).pipe(
          tap((state) => expect(() => assertPlainData(state)).not.toThrow()),
          filter(predicate),
          timeout(settleTimeoutMs),
        ),
      );
    }

    it(
      'typing, directMap and inviteBlocking emit a snapshot first',
      async () => {
        const sources: Observable<unknown>[] = [
          engine.typing(alice),
          engine.directMap(alice),
          engine.inviteBlocking(alice),
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

        const snapshot = await snapshotNow();

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
        const roomId = await invitedByBob();
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
        await roomUntil(
          first.roomId,
          (r) => r.membership === 'join' && r.directUserId === bob,
        );
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
          engine.createRoom(NOBODY, request()),
          engine.createDirectMessage(NOBODY, bob),
          engine.resolveAlias(NOBODY, '#x:invalid'),
          engine.invite(NOBODY, '!r:invalid', bob),
          engine.join(NOBODY, '!r:invalid', []),
          engine.spaceHierarchy(NOBODY, '!s:invalid', { maxPages: 1 }),
          engine.setSpaceChild(NOBODY, '!s:invalid', '!r:invalid', null),
          engine.setSpaceParent(NOBODY, '!r:invalid', '!s:invalid', []),
          engine.setInviteBlocking(NOBODY, true),
        ];

        for (const command of commands) {
          const result = await once(command);
          expect(!result.ok && result.failure.code).toBe('account-not-live');
        }
        await expect(
          firstValueFrom(
            engine.inviteBlocking(NOBODY).pipe(timeout(settleTimeoutMs)),
          ),
        ).resolves.toEqual({ supported: false, blocked: false });
        await expect(
          firstValueFrom(
            engine.roomsInCommon(NOBODY, bob).pipe(timeout(settleTimeoutMs)),
          ),
        ).resolves.toEqual([]);
      },
      testTimeoutMs,
    );

    it(
      'roomsInCommon adds a room once alice joins bob in it',
      async () => {
        const roomId = await invitedByBob();
        const latest = track(engine.roomsInCommon(alice, bob));
        await latestUntil(latest, () => true);
        expect(latest.value).toEqual([]);

        await context.asAlice.join(roomId);

        await latestUntil(latest, (ids) => ids.includes(roomId));
        expect(latest.value).toEqual([roomId]);
      },
      testTimeoutMs,
    );

    it(
      'roomsInCommon leaves out rooms only one of them has joined',
      async () => {
        await createRoom();
        await context.asBob.createRoom(`bob ${unique()}`);

        const shared = await firstValueFrom(
          engine.roomsInCommon(alice, bob).pipe(timeout(settleTimeoutMs)),
        );

        expect(() => assertPlainData(shared)).not.toThrow();
        expect(shared).toEqual([]);
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

        const snapshot = await snapshotNow();
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
      'setInviteBlocking round-trips, or is request-failed where the server lacks MSC4380',
      async () => {
        if (!context.serverBlocksInvites) {
          const result = await once(engine.setInviteBlocking(alice, true));
          expect(!result.ok && result.failure.code).toBe('request-failed');
          await expect(
            firstValueFrom(
              engine.inviteBlocking(alice).pipe(timeout(settleTimeoutMs)),
            ),
          ).resolves.toEqual({ supported: false, blocked: false });
          return;
        }
        const latest = track(engine.inviteBlocking(alice));
        await latestUntil(latest, (state) => state.supported);
        expect(latest.value).toEqual({ supported: true, blocked: false });

        const on = await atReply(engine.setInviteBlocking(alice, true), latest);
        expect(on.seen).toEqual({ supported: true, blocked: true });
        await blockingUntil((state) => state.blocked);

        const off = await atReply(
          engine.setInviteBlocking(alice, false),
          latest,
        );
        expect(off.seen).toEqual({ supported: true, blocked: false });
      },
      testTimeoutMs,
    );

    it(
      "shows each command's effect in an open rooms() subscription before it replies",
      async () => {
        const latest = track(folded());
        const row = (rooms: readonly RoomInfo[], roomId: string) =>
          rooms.find((r) => r.roomId === roomId);
        const shows = async <T>(
          step: string,
          command: Observable<EngineResult<T>>,
          effect: (rooms: readonly RoomInfo[], value: T) => boolean,
        ): Promise<T> => {
          const { value, seen } = await atReply(command, latest);
          expect(effect(seen ?? [], value), step).toBe(true);
          return value;
        };
        await latestUntil(latest, () => true);

        const { roomId: created } = await shows(
          'createRoom',
          engine.createRoom(alice, request()),
          (rooms, { roomId }) => row(rooms, roomId)?.membership === 'join',
        );
        await shows(
          'setTag on',
          engine.setTag(alice, created, 'favourite', true),
          (rooms) => row(rooms, created)?.favourite === true,
        );
        await shows(
          'setTag off',
          engine.setTag(alice, created, 'favourite', false),
          (rooms) => row(rooms, created)?.favourite === false,
        );
        await shows(
          'createDirectMessage',
          engine.createDirectMessage(alice, bob),
          (rooms, { roomId }) => row(rooms, roomId) !== undefined,
        );
        const publicRoom = await context.asBob.createPublicRoom(
          `bob ${unique()}`,
          `contract-${unique()}`,
        );
        await shows(
          'join',
          engine.join(alice, publicRoom.roomId, [context.serverName]),
          (rooms) => row(rooms, publicRoom.roomId)?.membership === 'join',
        );
        await shows(
          'leave',
          engine.leave(alice, created),
          (rooms) => row(rooms, created) === undefined,
        );
      },
      testTimeoutMs,
    );

    it(
      "a created room's row carries its name, topic, encryption and history",
      async () => {
        const name = `contract ${unique()}`;
        const roomId = await createRoom({ name, topic: 'about' });
        const spaceId = await createRoom({ kind: 'space' });

        const room = await roomUntil(
          roomId,
          (r) =>
            r.displayName === name &&
            r.topic !== '' &&
            r.joinedMemberCount > 0 &&
            r.encryption !== 'unknown',
        );
        const space = await roomUntil(
          spaceId,
          (r) => r.isSpace && r.encryption !== 'unknown',
        );

        expect(room).toMatchObject({
          membership: 'join',
          isSpace: false,
          displayName: name,
          topic: 'about',
          avatarMxc: null,
          directUserId: null,
          encryption: 'encrypted',
          joinedMemberCount: 1,
          historyVisibility: 'shared',
          latestMessage: null,
          favourite: false,
          inviter: null,
        });
        expect(space.encryption).toBe('unencrypted');
      },
      testTimeoutMs,
    );

    it(
      'a message from bob shows as the latest message and moves recencyStamp',
      async () => {
        const roomId = await invitedByBob('joined');
        await context.asAlice.join(roomId);
        const before = await roomUntil(roomId, (r) => r.membership === 'join');

        await context.asBob.sendMessage(roomId, 'hello');

        const after = await roomUntil(
          roomId,
          (r) => r.latestMessage?.text === 'hello',
        );
        expect(after.latestMessage).toEqual({ text: 'hello', mark: null });
        expect(after.historyVisibility).toBe('joined');
        expect(after.recencyStamp).toBeGreaterThan(before.recencyStamp);
      },
      testTimeoutMs,
    );

    it(
      'a plaintext message in an encrypted room shows with the unencrypted mark',
      async () => {
        const roomId = await createRoom();
        await ok(engine.invite(alice, roomId, bob));
        await context.asBob.join(roomId);

        await context.asBob.sendMessage(roomId, 'hello');

        const room = await roomUntil(
          roomId,
          (r) => r.latestMessage?.text === 'hello',
        );
        expect(room.latestMessage?.mark).toBe('unencrypted');
      },
      testTimeoutMs,
    );

    it(
      'join accepts an invite',
      async () => {
        const roomId = await invitedByBob();

        await expect(ok(engine.join(alice, roomId, []))).resolves.toEqual({
          roomId,
        });

        expect(
          (await snapshotNow()).find((r) => r.roomId === roomId),
        ).toMatchObject({ membership: 'join', inviter: null });
      },
      testTimeoutMs,
    );

    it(
      'leave declines an invite',
      async () => {
        const roomId = await invitedByBob();

        await ok(engine.leave(alice, roomId));

        expect((await snapshotNow()).some((r) => r.roomId === roomId)).toBe(
          false,
        );
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
