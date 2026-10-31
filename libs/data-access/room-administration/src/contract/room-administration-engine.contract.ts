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
  JsonObject,
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
  /** Creates a space (`type: m.space`). */
  readonly space?: boolean;
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
    /** Sends a text message and resolves its event ID. */
    sendMessage(roomId: string, body: string): Promise<string>;
    setState(
      roomId: string,
      type: string,
      content: JsonObject,
      stateKey?: string,
    ): Promise<void>;
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
      source: Observable<EngineResult<unknown>>,
    ): Promise<{ readonly code: string; readonly kind: string } | null> {
      const result = await once(source);
      return result.ok
        ? null
        : { code: result.failure.code, kind: result.failure.kind };
    }

    /** The failure's code, kind, HTTP status and errcode; null on success. */
    async function rejectionOf(
      source: Observable<EngineResult<unknown>>,
    ): Promise<Record<string, unknown> | null> {
      const result = await once(source);
      if (result.ok) return null;
      const { code, kind, diagnostic } = result.failure;
      return {
        code,
        kind,
        httpStatus: diagnostic.httpStatus,
        errcode: diagnostic.errcode,
      };
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
      async () => {
        const first = await Promise.all([
          firstValueFrom(engine.room(NOBODY, '!unknown:invalid')),
          firstValueFrom(engine.members(NOBODY, '!unknown:invalid')),
        ]);

        expect(first).toEqual([null, null]);
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
            (r) =>
              r.ownMembership === 'join' &&
              r.creators.length > 0 &&
              r.encryption === 'unencrypted',
          );

          expect(snapshot).toMatchObject({
            roomId,
            ownUserId: alice,
            ownMembership: 'join',
            ownPower: 0,
            isSpace: false,
            spaceParents: [],
            encryption: 'unencrypted',
          });
          expect(snapshot.powerLevels?.['users']).toMatchObject({
            [bob]: 100,
          });
          expect(snapshot.creators.map((c) => c.userId)).toEqual([bob]);
          expect(snapshot.state.create?.sender).toBe(bob);
        } finally {
          room.close();
        }

        const first = await firstValueFrom(engine.room(alice, roomId));
        expect(first?.ownMembership).toBe('join');
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
            (m) => m.complete && memberOf(m, alice)?.membership === 'join',
          );
          expect(first.complete).toBe(true);
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

    it(
      'kick, ban and unban change membership; refused without the power',
      async () => {
        const roomId = await sharedRoom();
        await context.asBob.invite(roomId, carol);
        await context.asCarol.join(roomId);
        const members = watch(engine.members(alice, roomId));
        try {
          await members.until((m) => memberOf(m, carol)?.membership === 'join');
          expect(
            await rejectionOf(engine.kick(alice, roomId, carol, 'spam')),
          ).toMatchObject({
            code: 'request-failed',
            kind: 'permission',
            httpStatus: 403,
          });
          expect(
            await failureOf(engine.kick(NOBODY, roomId, carol, null)),
          ).toMatchObject({ code: 'account-not-live' });

          await context.asBob.setPowerLevel(roomId, alice, 100);
          const room = watch(engine.room(alice, roomId));
          try {
            await room.until((r) => r.ownPower === 100);
          } finally {
            room.close();
          }

          const kick = engine.kick(alice, roomId, carol, 'spam');
          // Cold: nothing is sent before subscribing.
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(
            memberOf(await members.until(() => true), carol)?.membership,
          ).toBe('join');
          expect(await failureOf(kick)).toBeNull();
          expect(
            memberOf(
              await members.until(
                (m) => memberOf(m, carol)?.membership === 'leave',
              ),
              carol,
            ),
          ).toMatchObject({ reason: 'spam' });

          expect(
            await failureOf(engine.ban(alice, roomId, carol, 'abuse')),
          ).toBeNull();
          expect(
            memberOf(
              await members.until(
                (m) => memberOf(m, carol)?.membership === 'ban',
              ),
              carol,
            ),
          ).toMatchObject({ reason: 'abuse' });

          expect(
            await failureOf(engine.unban(alice, roomId, carol)),
          ).toBeNull();
          await members.until(
            (m) => memberOf(m, carol)?.membership === 'leave',
          );
        } finally {
          members.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'reports an event, a room and a user; an unknown event or room is not found',
      async () => {
        const roomId = await sharedRoom();
        const eventId = await context.asBob.sendMessage(roomId, 'report me');
        const notFound = {
          code: 'request-failed',
          httpStatus: 404,
          errcode: 'M_NOT_FOUND',
        };

        expect(
          await failureOf(engine.reportEvent(alice, roomId, eventId, 'spam')),
        ).toBeNull();
        expect(
          await rejectionOf(
            engine.reportEvent(alice, roomId, '$unknown-event', ''),
          ),
        ).toMatchObject(notFound);
        expect(
          await failureOf(engine.reportRoom(alice, roomId, '')),
        ).toBeNull();
        expect(
          await rejectionOf(engine.reportRoom(alice, '!unknown:invalid', '')),
        ).toMatchObject(notFound);
        expect(
          await failureOf(engine.reportUser(alice, bob, 'spam')),
        ).toBeNull();
        expect(
          await failureOf(engine.reportUser(NOBODY, bob, '')),
        ).toMatchObject({ code: 'account-not-live' });
      },
      testTimeoutMs,
    );

    it(
      'publishes, lists and removes a local alias',
      async () => {
        const roomId = await sharedRoom();
        const server = alice.slice(alice.indexOf(':') + 1);
        const alias = `#ra-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}:${server}`;
        const aliases = async () => {
          const result = await once(engine.localAliases(alice, roomId));
          return result.ok ? result.value : null;
        };

        expect(await aliases()).toEqual([]);
        const publish = engine.publishAlias(alice, roomId, alias);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(await aliases()).toEqual([]);
        expect(await failureOf(publish)).toBeNull();
        expect(await aliases()).toEqual([alias]);

        expect(await failureOf(engine.removeAlias(alice, alias))).toBeNull();
        expect(await aliases()).toEqual([]);
        expect(
          await rejectionOf(engine.removeAlias(alice, alias)),
        ).toMatchObject({
          code: 'request-failed',
          httpStatus: 404,
          errcode: 'M_NOT_FOUND',
        });
      },
      testTimeoutMs,
    );

    it(
      'aliases of a room the account has not joined are refused',
      async () => {
        const roomId = await context.asBob.createRoom();
        const server = alice.slice(alice.indexOf(':') + 1);
        const forbidden = {
          code: 'request-failed',
          kind: 'permission',
          httpStatus: 403,
        };

        expect(
          await rejectionOf(engine.localAliases(alice, roomId)),
        ).toMatchObject(forbidden);
        expect(
          await rejectionOf(
            engine.publishAlias(
              alice,
              roomId,
              `#ra-never-${Date.now()}:${server}`,
            ),
          ),
        ).toMatchObject(forbidden);
        expect(
          await failureOf(engine.localAliases(NOBODY, roomId)),
        ).toMatchObject({ code: 'account-not-live' });
      },
      testTimeoutMs,
    );

    it(
      'lists and unlists a room in the directory with the power to',
      async () => {
        const roomId = await sharedRoom();
        const visibility = async () => {
          const result = await once(engine.directoryVisibility(alice, roomId));
          return result.ok ? result.value : null;
        };

        expect(await visibility()).toBe('private');
        expect(
          await rejectionOf(
            engine.setDirectoryVisibility(alice, roomId, 'public'),
          ),
        ).toMatchObject({
          code: 'request-failed',
          kind: 'permission',
          httpStatus: 403,
        });

        await context.asBob.setPowerLevel(roomId, alice, 100);
        const room = watch(engine.room(alice, roomId));
        try {
          await room.until((r) => r.ownPower === 100);
        } finally {
          room.close();
        }
        expect(
          await failureOf(
            engine.setDirectoryVisibility(alice, roomId, 'public'),
          ),
        ).toBeNull();
        expect(await visibility()).toBe('public');
        expect(
          await failureOf(
            engine.setDirectoryVisibility(alice, roomId, 'private'),
          ),
        ).toBeNull();
        expect(await visibility()).toBe('private');

        expect(
          await rejectionOf(
            engine.directoryVisibility(alice, '!unknown:invalid'),
          ),
        ).toMatchObject({
          code: 'request-failed',
          httpStatus: 404,
          errcode: 'M_NOT_FOUND',
        });
        expect(
          await failureOf(
            engine.setDirectoryVisibility(NOBODY, roomId, 'private'),
          ),
        ).toMatchObject({ code: 'account-not-live' });
      },
      testTimeoutMs,
    );

    it(
      "stateEvent reads one event's content from the server, null when absent",
      async () => {
        const roomId = await sharedRoom();

        const levels = await once(
          engine.stateEvent(alice, roomId, 'm.room.power_levels', ''),
        );
        expect(levels.ok && levels.value?.['users']).toMatchObject({
          [bob]: 100,
        });
        expect(
          await once(engine.stateEvent(alice, roomId, 'org.trinity.none', '')),
        ).toEqual({ ok: true, value: null });
        expect(
          await once(engine.stateEvent(alice, roomId, 'm.room.member', NOBODY)),
        ).toEqual({ ok: true, value: null });
        expect(
          await failureOf(
            engine.stateEvent(NOBODY, roomId, 'm.room.power_levels', ''),
          ),
        ).toMatchObject({ code: 'account-not-live' });
      },
      testTimeoutMs,
    );
    it(
      'enableEncryption sends Megolm encryption once; the room reports it',
      async () => {
        const roomId = await sharedRoom();
        await context.asBob.setPowerLevel(roomId, alice, 100);
        const room = watch(engine.room(alice, roomId));
        try {
          await room.until((r) => r.ownPower === 100);
          const enable = engine.enableEncryption(alice, roomId);
          // Cold: nothing is sent before subscribing.
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(room.seen.some((r) => r.state.encryption !== null)).toBe(
            false,
          );

          expect(await failureOf(enable)).toBeNull();

          const after = await room.until(
            (r) => r.state.encryption !== null && r.encryption === 'encrypted',
          );
          expect(after.state.encryption).toMatchObject({
            algorithm: 'm.megolm.v1.aes-sha2',
          });
          expect(
            await failureOf(engine.enableEncryption(alice, roomId)),
          ).toMatchObject({ code: 'already-encrypted' });
        } finally {
          room.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'enableEncryption refuses an encrypted or unknown room, no power and no live account',
      async () => {
        const plain = await sharedRoom();
        const encrypted = await sharedRoom({ encrypted: true });
        const rooms = [
          watch(engine.room(alice, plain)),
          watch(engine.room(alice, encrypted)),
        ];
        try {
          await rooms[0].until((r) => r.ownMembership === 'join');
          await rooms[1].until((r) => r.encryption === 'encrypted');

          expect(
            await rejectionOf(engine.enableEncryption(alice, plain)),
          ).toMatchObject({
            code: 'request-failed',
            kind: 'permission',
            httpStatus: 403,
          });
          expect(
            await failureOf(engine.enableEncryption(alice, encrypted)),
          ).toMatchObject({ code: 'already-encrypted' });
          expect(
            await failureOf(engine.enableEncryption(alice, '!unknown:invalid')),
          ).toMatchObject({ code: 'room-unavailable' });
          expect(
            await failureOf(engine.enableEncryption(NOBODY, plain)),
          ).toMatchObject({ code: 'account-not-live' });
        } finally {
          rooms.forEach((room) => room.close());
        }
      },
      testTimeoutMs,
    );

    it(
      'upgradeRoom replaces the room and tombstones the old one',
      async () => {
        const roomId = await sharedRoom();
        await context.asBob.setPowerLevel(roomId, alice, 100);
        const room = watch(engine.room(alice, roomId));
        try {
          await room.until((r) => r.ownPower === 100);
          const upgrade = engine.upgradeRoom(alice, roomId, '11', null);
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(room.seen.some((r) => r.state.tombstone !== null)).toBe(false);

          const result = await once(upgrade);
          if (!result.ok) throw new Error(result.failure.code);
          const { replacementRoomId } = result.value;

          await room.until(
            (r) =>
              r.state.tombstone?.['replacement_room'] === replacementRoomId,
          );
          const next = watch(engine.room(alice, replacementRoomId));
          try {
            const created = await next.until(
              (r) => r.ownMembership === 'join' && r.state.create !== null,
            );
            expect(created.state.create?.content).toMatchObject({
              room_version: '11',
              predecessor: { room_id: roomId },
            });
            expect(created.creators.map((c) => c.userId)).toEqual([alice]);
          } finally {
            next.close();
          }
        } finally {
          room.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'upgradeRoom to v12 makes the additional creators creators',
      async () => {
        const roomId = await sharedRoom();
        await context.asBob.setPowerLevel(roomId, alice, 100);
        const room = watch(engine.room(alice, roomId));
        try {
          await room.until((r) => r.ownPower === 100);
        } finally {
          room.close();
        }

        const result = await once(
          engine.upgradeRoom(alice, roomId, '12', [bob]),
        );
        if (!result.ok) throw new Error(result.failure.code);
        const next = watch(engine.room(alice, result.value.replacementRoomId));
        try {
          const created = await next.until(
            (r) => r.ownMembership === 'join' && r.ownPower === 'infinite',
          );
          expect(created.creators.map((c) => c.userId)).toEqual([alice, bob]);
        } finally {
          next.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'upgradeRoom is refused without the power, for an unknown room or version',
      async () => {
        const roomId = await sharedRoom();

        expect(
          await rejectionOf(engine.upgradeRoom(alice, roomId, '11', null)),
        ).toMatchObject({
          code: 'request-failed',
          kind: 'permission',
          httpStatus: 403,
        });
        expect(
          await rejectionOf(
            engine.upgradeRoom(alice, '!unknown:invalid', '11', null),
          ),
        ).toMatchObject({
          code: 'request-failed',
          httpStatus: 404,
          errcode: 'M_NOT_FOUND',
        });
        expect(
          await rejectionOf(
            engine.upgradeRoom(alice, roomId, 'org.trinity.none', null),
          ),
        ).toMatchObject({
          code: 'request-failed',
          httpStatus: 400,
          errcode: 'M_UNSUPPORTED_ROOM_VERSION',
        });
        expect(
          await failureOf(engine.upgradeRoom(NOBODY, roomId, '11', null)),
        ).toMatchObject({ code: 'account-not-live' });
      },
      testTimeoutMs,
    );

    it(
      'invite invites a user; a banned user is refused',
      async () => {
        const roomId = await sharedRoom();
        const members = watch(engine.members(alice, roomId));
        try {
          await members.until((m) => memberOf(m, alice)?.membership === 'join');
          const invite = engine.invite(alice, roomId, carol);
          await new Promise((resolve) => setTimeout(resolve, 50));
          expect(
            memberOf(await members.until(() => true), carol),
          ).toBeUndefined();

          expect(await failureOf(invite)).toBeNull();
          await members.until(
            (m) => memberOf(m, carol)?.membership === 'invite',
          );

          await context.asBob.ban(roomId, carol, 'spam');
          await members.until((m) => memberOf(m, carol)?.membership === 'ban');
          expect(
            await rejectionOf(engine.invite(alice, roomId, carol)),
          ).toMatchObject({
            code: 'request-failed',
            kind: 'permission',
            httpStatus: 403,
          });
          expect(
            await failureOf(engine.invite(NOBODY, roomId, carol)),
          ).toMatchObject({ code: 'account-not-live' });
        } finally {
          members.close();
        }
      },
      testTimeoutMs,
    );

    it(
      'linkingSpaces lists the joined spaces that link the room',
      async () => {
        const roomId = await sharedRoom();
        const server = alice.slice(alice.indexOf(':') + 1);
        const spaceId = await context.asBob.createRoom({ space: true });
        await context.asBob.setState(spaceId, 'm.room.name', {
          name: 'Contract space',
        });
        await context.asBob.setState(
          spaceId,
          'm.space.child',
          { via: [server], order: 'a' },
          roomId,
        );
        await context.asBob.setState(roomId, 'm.room.topic', {
          topic: 'Contract topic',
        });
        await context.asBob.setState(
          roomId,
          'm.space.parent',
          { via: [server], canonical: true },
          spaceId,
        );
        // A space alice has not joined does not count.
        const other = await context.asBob.createRoom({ space: true });
        await context.asBob.setState(
          other,
          'm.space.child',
          { via: [server] },
          roomId,
        );
        await context.asBob.invite(spaceId, alice);
        await context.asAlice.join(spaceId);
        const space = watch(engine.room(alice, spaceId));
        const child = watch(engine.room(alice, roomId));
        try {
          const joinedSpace = await space.until(
            (r) =>
              r.ownMembership === 'join' && r.isSpace && r.state.name !== null,
          );
          expect(joinedSpace.state.name).toEqual({ name: 'Contract space' });
          const linked = await child.until((r) => r.spaceParents.length > 0);
          expect(linked.isSpace).toBe(false);
          expect(linked.spaceParents).toEqual([spaceId]);
          expect(linked.state.topic).toEqual({ topic: 'Contract topic' });
        } finally {
          space.close();
          child.close();
        }

        const result = await once(engine.linkingSpaces(alice, roomId));
        expect(result).toEqual({
          ok: true,
          value: [
            {
              spaceId,
              name: 'Contract space',
              childContent: { via: [server], order: 'a' },
              ownPower: 0,
              powerLevels: expect.objectContaining({
                users: expect.objectContaining({ [bob]: 100 }),
              }),
            },
          ],
        });
        expect(
          await failureOf(engine.linkingSpaces(alice, '!unknown:invalid')),
        ).toMatchObject({ code: 'room-unavailable' });
        expect(
          await failureOf(engine.linkingSpaces(NOBODY, roomId)),
        ).toMatchObject({ code: 'account-not-live' });
      },
      testTimeoutMs,
    );
  });
}
