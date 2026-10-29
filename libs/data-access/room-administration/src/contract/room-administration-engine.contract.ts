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
  AdministeredRoom,
  RoomAdministrationEngine,
  RoomMemberInfo,
  RoomMembers,
} from '../lib/room-administration-engine';

export interface ContractRoomOptions {
  /** The room version; the server's default when absent. */
  readonly roomVersion?: string;
  /** v12 `additional_creators`. */
  readonly additionalCreators?: readonly string[];
  /** Creates the room with Megolm `m.room.encryption` state. */
  readonly encrypted?: boolean;
}

export interface RoomAdministrationContractSetup {
  readonly engine: RoomAdministrationEngine;
  /** A live account in `engine`. */
  readonly alice: string;
  /** Registered users on the same server, driven only through `asBob` and `asCarol`. */
  readonly bob: string;
  readonly carol: string;
  readonly asAlice: {
    join(roomId: string): Promise<void>;
  };
  readonly asBob: {
    /** A private room where bob has power level 100 (or is the creator in v12). */
    createRoom(options?: ContractRoomOptions): Promise<string>;
    invite(roomId: string, userId: string): Promise<void>;
    setPowerLevel(roomId: string, userId: string, level: number): Promise<void>;
    setDisplayName(roomId: string, name: string): Promise<void>;
    ban(roomId: string, userId: string, reason: string): Promise<void>;
  };
  readonly asCarol: {
    join(roomId: string): Promise<void>;
    leave(roomId: string): Promise<void>;
    setDisplayName(roomId: string, name: string): Promise<void>;
  };
  dispose(): Promise<void>;
}

export interface RoomAdministrationContractTiming {
  /** How long a change may take to reach an emission. */
  readonly settleTimeoutMs: number;
  /** Per-test timeout; a live server needs several round trips per case. */
  readonly testTimeoutMs: number;
}

interface Watch<T> {
  readonly seen: readonly T[];
  until(predicate: (value: T) => boolean): Promise<T>;
  close(): void;
}

const NOBODY = '@nobody:invalid';

export function defineRoomAdministrationEngineContract(
  setup: () => Promise<RoomAdministrationContractSetup>,
  { settleTimeoutMs, testTimeoutMs }: RoomAdministrationContractTiming,
): void {
  describe('RoomAdministrationEngine contract', () => {
    let context: RoomAdministrationContractSetup;
    let engine: RoomAdministrationEngine;
    let alice: string;
    let bob: string;
    let carol: string;

    beforeEach(async () => {
      context = await setup();
      ({ engine, alice, bob, carol } = context);
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
    ): Promise<{ readonly code: string; readonly kind: string } | null> {
      const result = await once(source);
      return result.ok
        ? null
        : { code: result.failure.code, kind: result.failure.kind };
    }

    function watch<T>(source: Observable<T | null>): Watch<T> {
      const seen: T[] = [];
      const latest$ = new BehaviorSubject<T | null>(null);
      const subscription = source
        .pipe(
          tap((value) => {
            expect(() => assertPlainData(value)).not.toThrow();
            if (value !== null) seen.push(value);
          }),
        )
        .subscribe(latest$);
      return {
        seen,
        until: (predicate) =>
          firstValueFrom(
            latest$.pipe(
              filter((value): value is T => value !== null),
              filter(predicate),
              timeout(settleTimeoutMs),
            ),
          ),
        close: () => subscription.unsubscribe(),
      };
    }

    /** Bob's room with alice joined. */
    async function sharedRoom(options?: ContractRoomOptions): Promise<string> {
      const roomId = await context.asBob.createRoom(options);
      await context.asBob.invite(roomId, alice);
      await context.asAlice.join(roomId);
      return roomId;
    }

    function memberOf(
      members: RoomMembers,
      userId: string,
    ): RoomMemberInfo | undefined {
      return members.members.find((member) => member.userId === userId);
    }

    it(
      'room and members emit null at once for an account that is not live',
      () => {
        const seen: unknown[] = [];
        engine
          .room(NOBODY, '!unknown:invalid')
          .subscribe((value) => seen.push(value))
          .unsubscribe();
        engine
          .members(NOBODY, '!unknown:invalid')
          .subscribe((value) => seen.push(value))
          .unsubscribe();

        expect(seen).toEqual([null, null]);
      },
      testTimeoutMs,
    );

    it(
      'room emits the joined room with its power levels and creator',
      async () => {
        const roomId = await sharedRoom();
        const room = watch(engine.room(alice, roomId));
        try {
          const snapshot = await room.until(
            (r) => r.ownMembership === 'join' && r.creators.length > 0,
          );

          expect(snapshot).toMatchObject({
            roomId,
            ownUserId: alice,
            ownMembership: 'join',
            ownPower: 0,
            isSpace: false,
            spaceParents: [],
          });
          expect(snapshot.powerLevels?.['users']).toMatchObject({
            [bob]: 100,
          });
          expect(snapshot.creators.map((c) => c.userId)).toEqual([bob]);
          expect(snapshot.state.create?.sender).toBe(bob);
        } finally {
          room.close();
        }

        const seen: (AdministeredRoom | null)[] = [];
        engine
          .room(alice, roomId)
          .subscribe((value) => seen.push(value))
          .unsubscribe();
        expect(seen).toHaveLength(1);
        expect(seen[0]?.ownMembership).toBe('join');
      },
      testTimeoutMs,
    );

    it(
      'a power level change re-emits room',
      async () => {
        const roomId = await sharedRoom();
        const room = watch(engine.room(alice, roomId));
        try {
          await room.until((r) => r.ownMembership === 'join');

          await context.asBob.setPowerLevel(roomId, alice, 50);

          const changed = await room.until((r) => r.ownPower === 50);
          expect(changed.powerLevels?.['users']).toMatchObject({
            [alice]: 50,
          });
        } finally {
          room.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'v12 creators have infinite power',
      async () => {
        const roomId = await sharedRoom({
          roomVersion: '12',
          additionalCreators: [alice],
        });
        const room = watch(engine.room(alice, roomId));
        const members = watch(engine.members(alice, roomId));
        try {
          const snapshot = await room.until(
            (r) => r.ownMembership === 'join' && r.ownPower === 'infinite',
          );
          expect(snapshot.creators.map((c) => c.userId)).toEqual([bob, alice]);

          const listed = await members.until(
            (m) => memberOf(m, alice)?.membership === 'join',
          );
          expect(memberOf(listed, alice)?.power).toBe('infinite');
          expect(memberOf(listed, bob)?.power).toBe('infinite');
        } finally {
          room.close();
          members.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'members re-emits on a join, a name change, a leave and a ban',
      async () => {
        const roomId = await sharedRoom();
        const members = watch(engine.members(alice, roomId));
        try {
          const first = await members.until(
            (m) => memberOf(m, alice)?.membership === 'join',
          );
          expect(memberOf(first, bob)).toMatchObject({
            membership: 'join',
            power: 100,
            reason: null,
          });

          await context.asBob.invite(roomId, carol);
          await context.asCarol.join(roomId);
          await members.until((m) => memberOf(m, carol)?.membership === 'join');

          await context.asCarol.setDisplayName(roomId, 'Carol Renamed');
          await members.until(
            (m) => memberOf(m, carol)?.displayName === 'Carol Renamed',
          );

          await context.asCarol.leave(roomId);
          await members.until(
            (m) => memberOf(m, carol)?.membership === 'leave',
          );

          await context.asBob.ban(roomId, carol, 'spam');
          const banned = await members.until(
            (m) => memberOf(m, carol)?.membership === 'ban',
          );
          expect(memberOf(banned, carol)?.reason).toBe('spam');
        } finally {
          members.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'members disambiguates two members with the same display name',
      async () => {
        const roomId = await sharedRoom();
        await context.asBob.invite(roomId, carol);
        await context.asCarol.join(roomId);
        const members = watch(engine.members(alice, roomId));
        try {
          await members.until((m) => memberOf(m, carol)?.membership === 'join');

          await context.asBob.setDisplayName(roomId, 'Twin');
          await context.asCarol.setDisplayName(roomId, 'Twin');

          await members.until(
            (m) =>
              memberOf(m, bob)?.displayName === `Twin (${bob})` &&
              memberOf(m, carol)?.displayName === `Twin (${carol})`,
          );
        } finally {
          members.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'members disambiguates look-alike, user-id-like and direction-marked names',
      async () => {
        const roomId = await sharedRoom();
        await context.asBob.invite(roomId, carol);
        await context.asCarol.join(roomId);
        const members = watch(engine.members(alice, roomId));
        const shows = (bobName: string, carolName: string) =>
          members.until(
            (m) =>
              memberOf(m, bob)?.displayName === bobName &&
              memberOf(m, carol)?.displayName === carolName,
          );
        try {
          await members.until((m) => memberOf(m, carol)?.membership === 'join');
          await context.asBob.setDisplayName(roomId, 'Twin');

          // Equal once zero-width and spacing characters are removed.
          await context.asCarol.setDisplayName(roomId, 'Tw\u200Bin ');
          await shows(`Twin (${bob})`, `Tw\u200Bin  (${carol})`);

          await context.asCarol.setDisplayName(roomId, '@admin:example.org');
          await shows('Twin', `@admin:example.org (${carol})`);

          // A right-to-left override is dropped from the name, which still names its user.
          await context.asCarol.setDisplayName(roomId, '\u202Enimda');
          await shows('Twin', `nimda (${carol})`);

          await context.asCarol.setDisplayName(roomId, '\u200B');
          await shows('Twin', carol);
        } finally {
          members.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'room never reports an encrypted room as unencrypted',
      async () => {
        const roomId = await sharedRoom({ encrypted: true });
        const room = watch(engine.room(alice, roomId));
        try {
          await room.until((r) => r.encryption === 'encrypted');

          expect(room.seen.map((r) => r.encryption)).not.toContain(
            'unencrypted',
          );
        } finally {
          room.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'setState round-trips unknown power level keys',
      async () => {
        const roomId = await sharedRoom();
        await context.asBob.setPowerLevel(roomId, alice, 100);
        const room = watch(engine.room(alice, roomId));
        try {
          const before = await room.until((r) => r.ownPower === 100);
          const content = {
            ...before.powerLevels,
            'org.trinity.contract': { nested: [1, 'two', null] },
          };
          const write = engine.setState(
            alice,
            roomId,
            'm.room.power_levels',
            '',
            content,
          );
          // Cold: nothing is written before subscribing.
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(
            room.seen.some((r) => r.powerLevels?.['org.trinity.contract']),
          ).toBe(false);

          expect(await failureOf(write)).toBeNull();

          const after = await room.until(
            (r) => r.powerLevels?.['org.trinity.contract'] !== undefined,
          );
          expect(after.powerLevels).toEqual(content);
        } finally {
          room.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'setState fails without a live account, a joined room or the power',
      async () => {
        const roomId = await context.asBob.createRoom();

        expect(
          await failureOf(
            engine.setState(NOBODY, roomId, 'm.room.topic', '', { topic: 'x' }),
          ),
        ).toMatchObject({ code: 'account-not-live' });
        expect(
          await failureOf(
            engine.setState(alice, roomId, 'm.room.topic', '', { topic: 'x' }),
          ),
        ).toMatchObject({ code: 'room-unavailable' });

        await context.asBob.invite(roomId, alice);
        await context.asAlice.join(roomId);
        const room = watch(engine.room(alice, roomId));
        try {
          await room.until((r) => r.ownMembership === 'join');
          expect(
            await failureOf(
              engine.setState(alice, roomId, 'm.room.topic', '', {
                topic: 'x',
              }),
            ),
          ).toEqual({ code: 'request-failed', kind: 'permission' });
        } finally {
          room.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'stateEvents lists the current state of a known room',
      async () => {
        const roomId = await sharedRoom();
        const room = watch(engine.room(alice, roomId));
        try {
          await room.until((r) => r.ownMembership === 'join');
        } finally {
          room.close();
        }

        const result = await once(engine.stateEvents(alice, roomId));
        const events = result.ok ? result.value : [];
        expect(
          events.find(({ type }) => type === 'm.room.create'),
        ).toMatchObject({
          stateKey: '',
          event: { type: 'm.room.create', state_key: '', sender: bob },
        });
        expect(
          events.find(
            ({ type, stateKey }) =>
              type === 'm.room.member' && stateKey === alice,
          )?.event['content'],
        ).toMatchObject({ membership: 'join' });

        const codes = await Promise.all(
          [
            engine.stateEvents(NOBODY, roomId),
            engine.stateEvents(alice, '!unknown:invalid'),
          ].map(async (command) => {
            const failed = await once(command);
            return failed.ok ? null : failed.failure.code;
          }),
        );
        expect(codes).toEqual(['account-not-live', 'room-unavailable']);
      },
      testTimeoutMs,
    );
  });
}
