import {
  BehaviorSubject,
  type Observable,
  defer,
  distinctUntilChanged,
  map,
  of,
} from 'rxjs';
import {
  type EngineFailure,
  type EngineResult,
  engineFail,
  engineOk,
  plainEqual,
} from '@trinity/util/matrix';
import type {
  AdministeredRoom,
  DirectoryVisibility,
  JsonObject,
  Membership,
  PowerLevel,
  RawStateEvent,
  RoomAdministrationEngine,
  RoomMemberInfo,
  RoomMembers,
} from '../lib/room-administration-engine';
import {
  isHydraRoomVersion,
  mayAct,
  maySendState,
  powerValue,
} from '../lib/room-power';
import type { ContractRoomOptions } from './room-administration-engine.contract';

interface FakeStateEvent {
  readonly sender: string;
  readonly originServerTs: number;
  readonly content: JsonObject;
}

/** State by `type` then state key. */
type FakeRoom = Map<string, Map<string, FakeStateEvent>>;

export interface FakeRoomOptions extends ContractRoomOptions {
  /** Leaves out `m.room.power_levels`, so spec defaults apply. */
  readonly withoutPowerLevels?: boolean;
  /** Without encryption state, reports `'unknown'` until {@link FakeRoomAdministrationEngine.answerEncryption}. */
  readonly encryptionUnknown?: boolean;
}

const MEMBERSHIPS: ReadonlySet<string> = new Set<Membership>([
  'join',
  'invite',
  'knock',
  'leave',
  'ban',
]);

// From js-sdk `room-member.ts` and `utils.ts`.
const MXID_PATTERN = /@.+:.+/;
const DIRECTION_MARKS = /[\u200E\u200F\u202A-\u202F]/;
const DIRECTION_OVERRIDES = /[\u202D-\u202E]/g;
const HIDDEN_CHARS =
  /[\u2000-\u200F\u202A-\u202F\u0300-\u036F\uFEFF\u061C\u2800\u2062-\u2063\s]/g;

/** js-sdk `removeHiddenChars`. shortcut: skips its `unhomoglyph` folding (not a dependency here); add it if a case needs look-alike letters. */
function withoutHiddenChars(name: string): string {
  return name.normalize('NFD').replace(HIDDEN_CHARS, '');
}

function failure(code: 'account-not-live' | 'room-unavailable'): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

/** A server refusal as the js-sdk engine describes it. */
function rejected(httpStatus: 403 | 404, errcode: string): EngineFailure {
  const kind = httpStatus === 403 ? 'permission' : 'http';
  return {
    kind,
    code: 'request-failed',
    diagnostic: { kind, httpStatus, errcode },
  };
}

const FORBIDDEN = rejected(403, 'M_FORBIDDEN');
const NOT_FOUND = rejected(404, 'M_NOT_FOUND');
const MANAGEABLE: ReadonlySet<Membership | null> = new Set<Membership | null>([
  'join',
  'invite',
  'knock',
]);

function record(value: unknown): JsonObject | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

/**
 * An in-memory {@link RoomAdministrationEngine} where alice is live and bob and carol
 * drive rooms. Power follows js-sdk: none without power levels, infinite for v12 creators.
 */
export class FakeRoomAdministrationEngine implements RoomAdministrationEngine {
  private readonly rooms = new Map<string, FakeRoom>();
  private readonly live = new Set<string>();
  /** The crypto store's answer per room; absent until answered. */
  private readonly encryptionAnswers = new Map<string, boolean | null>();
  /** The server's alias directory: alias to room and creator. */
  private readonly aliases = new Map<
    string,
    { readonly roomId: string; readonly creator: string }
  >();
  private readonly listed = new Set<string>();
  private readonly messages = new Map<string, Set<string>>();
  private readonly changes$ = new BehaviorSubject<void>(undefined);
  private nextRoom = 0;
  private nextEvent = 0;
  private clock = 1_700_000_000_000;

  readonly serverName = 'example.org';
  readonly alice = `@alice:${this.serverName}`;
  readonly bob = `@bob:${this.serverName}`;
  readonly carol = `@carol:${this.serverName}`;

  readonly asAlice = {
    join: async (roomId: string): Promise<void> =>
      this.joinAs(this.alice, roomId),
  };

  readonly asBob = {
    createRoom: async (options: FakeRoomOptions = {}): Promise<string> => {
      const roomId = `!fake-${++this.nextRoom}:${this.serverName}`;
      const version = options.roomVersion ?? '10';
      this.rooms.set(roomId, new Map());
      this.put(roomId, 'm.room.create', '', this.bob, {
        room_version: version,
        ...(options.additionalCreators
          ? { additional_creators: [...options.additionalCreators] }
          : {}),
      });
      this.put(roomId, 'm.room.member', this.bob, this.bob, {
        membership: 'join',
      });
      if (!options.withoutPowerLevels) {
        this.put(roomId, 'm.room.power_levels', '', this.bob, {
          users: isHydraRoomVersion(version) ? {} : { [this.bob]: 100 },
          users_default: 0,
          events: {},
          events_default: 0,
          state_default: 50,
          ban: 50,
          kick: 50,
          redact: 50,
          invite: 0,
        });
      }
      if (options.encryptionUnknown) this.encryptionAnswers.set(roomId, null);
      if (options.encrypted) {
        this.put(roomId, 'm.room.encryption', '', this.bob, {
          algorithm: 'm.megolm.v1.aes-sha2',
        });
      }
      return roomId;
    },
    invite: async (roomId: string, userId: string): Promise<void> =>
      this.setMembership(roomId, userId, this.bob, { membership: 'invite' }),
    setPowerLevel: async (
      roomId: string,
      userId: string,
      level: number,
    ): Promise<void> => {
      const levels = this.content(roomId, 'm.room.power_levels', '') ?? {};
      this.put(roomId, 'm.room.power_levels', '', this.bob, {
        ...levels,
        users: { ...record(levels['users']), [userId]: level },
      });
    },
    /** Merges top-level `m.room.power_levels` keys such as `kick` or `events`. */
    setPowerLevels: async (roomId: string, patch: JsonObject): Promise<void> =>
      this.put(roomId, 'm.room.power_levels', '', this.bob, {
        ...this.content(roomId, 'm.room.power_levels', ''),
        ...patch,
      }),
    setDisplayName: async (roomId: string, name: string): Promise<void> =>
      this.rename(this.bob, roomId, name),
    /** Writes any state event as bob, without a power check. */
    setState: async (
      roomId: string,
      type: string,
      content: JsonObject,
      stateKey = '',
    ): Promise<void> => this.put(roomId, type, stateKey, this.bob, content),
    ban: async (roomId: string, userId: string, reason: string) =>
      this.setMembership(roomId, userId, this.bob, {
        membership: 'ban',
        reason,
      }),
    sendMessage: async (roomId: string, _body: string): Promise<string> => {
      const eventId = `$fake-${++this.nextEvent}`;
      const sent = this.messages.get(roomId) ?? new Set<string>();
      sent.add(eventId);
      this.messages.set(roomId, sent);
      return eventId;
    },
  };

  readonly asCarol = {
    join: async (roomId: string): Promise<void> =>
      this.joinAs(this.carol, roomId),
    leave: async (roomId: string): Promise<void> =>
      this.setMembership(roomId, this.carol, this.carol, {
        membership: 'leave',
      }),
    knock: async (roomId: string, reason?: string): Promise<void> =>
      this.setMembership(roomId, this.carol, this.carol, {
        membership: 'knock',
        ...(reason ? { reason } : {}),
      }),
    setAvatar: async (roomId: string, mxc: string): Promise<void> =>
      this.put(roomId, 'm.room.member', this.carol, this.carol, {
        ...this.content(roomId, 'm.room.member', this.carol),
        avatar_url: mxc,
      }),
    setDisplayName: async (roomId: string, name: string): Promise<void> =>
      this.rename(this.carol, roomId, name),
  };

  constructor() {
    this.live.add(this.alice);
  }

  /** Ends or restores an account, as signing out and in again would. */
  setLive(accountId: string, live: boolean): void {
    if (live) this.live.add(accountId);
    else this.live.delete(accountId);
    this.changed();
  }

  /** Answers an `encryptionUnknown` room's encryption, as the crypto store would. */
  answerEncryption(roomId: string, encrypted: boolean): void {
    this.encryptionAnswers.set(roomId, encrypted);
    this.changed();
  }

  room(accountId: string, roomId: string): Observable<AdministeredRoom | null> {
    return this.changes$.pipe(
      map(() => this.roomSnapshot(accountId, roomId)),
      distinctUntilChanged<AdministeredRoom | null>(plainEqual),
    );
  }

  members(accountId: string, roomId: string): Observable<RoomMembers | null> {
    return this.changes$.pipe(
      map(() => this.membersSnapshot(accountId, roomId)),
      distinctUntilChanged<RoomMembers | null>(plainEqual),
    );
  }

  setState(
    accountId: string,
    roomId: string,
    type: string,
    stateKey: string,
    content: JsonObject,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      if (!this.live.has(accountId)) {
        return of(engineFail(failure('account-not-live')));
      }
      if (this.membershipOf(roomId, accountId) !== 'join') {
        return of(engineFail(failure('room-unavailable')));
      }
      const levels = this.content(roomId, 'm.room.power_levels', '');
      if (!maySendState(levels, this.powerOf(roomId, accountId), type)) {
        return of(engineFail(FORBIDDEN));
      }
      this.put(roomId, type, stateKey, accountId, structuredClone(content));
      return of(engineOk(null));
    });
  }

  stateEvents(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<readonly RawStateEvent[]>> {
    return defer(() => {
      if (!this.live.has(accountId)) {
        return of(engineFail(failure('account-not-live')));
      }
      const state = this.rooms.get(roomId);
      if (!state || !this.membershipOf(roomId, accountId)) {
        return of(engineFail(failure('room-unavailable')));
      }
      return of(
        engineOk(
          [...state].flatMap(([type, byKey]) =>
            [...byKey].map(([stateKey, event]) => ({
              type,
              stateKey,
              event: structuredClone({
                type,
                state_key: stateKey,
                sender: event.sender,
                origin_server_ts: event.originServerTs,
                room_id: roomId,
                content: event.content,
              }),
            })),
          ),
        ),
      );
    });
  }

  kick(
    accountId: string,
    roomId: string,
    userId: string,
    reason: string | null,
  ): Observable<EngineResult<null>> {
    return this.moderate(accountId, roomId, userId, ['kick'], MANAGEABLE, {
      membership: 'leave',
      ...(reason ? { reason } : {}),
    });
  }

  ban(
    accountId: string,
    roomId: string,
    userId: string,
    reason: string | null,
  ): Observable<EngineResult<null>> {
    return this.moderate(accountId, roomId, userId, ['ban'], null, {
      membership: 'ban',
      ...(reason ? { reason } : {}),
    });
  }

  unban(
    accountId: string,
    roomId: string,
    userId: string,
  ): Observable<EngineResult<null>> {
    return this.moderate(
      accountId,
      roomId,
      userId,
      ['ban', 'kick'],
      new Set(['ban']),
      { membership: 'leave' },
    );
  }

  reportEvent(
    accountId: string,
    roomId: string,
    eventId: string,
  ): Observable<EngineResult<null>> {
    // Synapse reports only events the reporter can see.
    return this.command(accountId, () =>
      this.membershipOf(roomId, accountId) === 'join' &&
      this.messages.get(roomId)?.has(eventId)
        ? null
        : NOT_FOUND,
    );
  }

  reportRoom(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () =>
      this.rooms.has(roomId) ? null : NOT_FOUND,
    );
  }

  /** Synapse answers success for any user, so reports do not reveal who exists. */
  reportUser(accountId: string): Observable<EngineResult<null>> {
    return this.command(accountId, () => null);
  }

  localAliases(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<readonly string[]>> {
    return defer(() => {
      if (!this.live.has(accountId)) {
        return of(engineFail(failure('account-not-live')));
      }
      if (this.membershipOf(roomId, accountId) !== 'join') {
        return of(engineFail(FORBIDDEN));
      }
      return of(
        engineOk(
          [...this.aliases]
            .filter(([, entry]) => entry.roomId === roomId)
            .map(([alias]) => alias),
        ),
      );
    });
  }

  publishAlias(
    accountId: string,
    roomId: string,
    alias: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      if (this.membershipOf(roomId, accountId) !== 'join') return FORBIDDEN;
      this.aliases.set(alias, { roomId, creator: accountId });
      return null;
    });
  }

  /** Synapse lets the alias's creator or a room moderator remove it. */
  removeAlias(
    accountId: string,
    alias: string,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      const entry = this.aliases.get(alias);
      if (!entry) return NOT_FOUND;
      if (
        entry.creator !== accountId &&
        !this.mayChangeRoomList(accountId, entry.roomId)
      ) {
        return FORBIDDEN;
      }
      this.aliases.delete(alias);
      return null;
    });
  }

  directoryVisibility(
    accountId: string,
    roomId: string,
  ): Observable<EngineResult<DirectoryVisibility>> {
    return defer(() => {
      if (!this.live.has(accountId)) {
        return of(engineFail(failure('account-not-live')));
      }
      if (!this.rooms.has(roomId)) return of(engineFail(NOT_FOUND));
      return of(
        engineOk<DirectoryVisibility>(
          this.listed.has(roomId) ? 'public' : 'private',
        ),
      );
    });
  }

  setDirectoryVisibility(
    accountId: string,
    roomId: string,
    visibility: DirectoryVisibility,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      if (!this.mayChangeRoomList(accountId, roomId)) return FORBIDDEN;
      if (visibility === 'public') this.listed.add(roomId);
      else this.listed.delete(roomId);
      return null;
    });
  }

  /** A server command for a live account; `run` answers its refusal or null. */
  private command(
    accountId: string,
    run: () => EngineFailure | null,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      if (!this.live.has(accountId)) {
        return of(engineFail(failure('account-not-live')));
      }
      const refusal = run();
      return of(refusal ? engineFail(refusal) : engineOk(null));
    });
  }

  /**
   * Synapse event auth for changing another user's membership: joined, every `levels`
   * action allowed, out-ranking the target, whose membership is in `from` (any when null).
   */
  private moderate(
    accountId: string,
    roomId: string,
    userId: string,
    levels: readonly ('kick' | 'ban')[],
    from: ReadonlySet<Membership | null> | null,
    content: JsonObject,
  ): Observable<EngineResult<null>> {
    return this.command(accountId, () => {
      const powerLevels = this.content(roomId, 'm.room.power_levels', '');
      const power = this.powerOf(roomId, accountId);
      if (
        this.membershipOf(roomId, accountId) !== 'join' ||
        (from && !from.has(this.membershipOf(roomId, userId))) ||
        !levels.every((action) => mayAct(powerLevels, power, action)) ||
        powerValue(power) <= powerValue(this.powerOf(roomId, userId))
      ) {
        return FORBIDDEN;
      }
      this.setMembership(roomId, userId, accountId, content);
      return null;
    });
  }

  /** Synapse `check_can_change_room_list`: joined, with the power to set the canonical alias. */
  private mayChangeRoomList(accountId: string, roomId: string): boolean {
    return (
      this.membershipOf(roomId, accountId) === 'join' &&
      maySendState(
        this.content(roomId, 'm.room.power_levels', ''),
        this.powerOf(roomId, accountId),
        'm.room.canonical_alias',
      )
    );
  }

  private roomSnapshot(
    accountId: string,
    roomId: string,
  ): AdministeredRoom | null {
    const state = this.rooms.get(roomId);
    if (
      !this.live.has(accountId) ||
      !state ||
      !this.membershipOf(roomId, accountId)
    ) {
      return null;
    }
    const single = (type: string): JsonObject | null =>
      this.content(roomId, type, '');
    const create = state.get('m.room.create')?.get('') ?? null;
    return {
      roomId,
      ownUserId: accountId,
      ownMembership: this.membershipOf(roomId, accountId),
      ownPower: this.powerOf(roomId, accountId),
      powerLevels: single('m.room.power_levels'),
      isSpace: create?.content['type'] === 'm.space',
      state: {
        create: create && {
          sender: create.sender,
          originServerTs: create.originServerTs,
          content: create.content,
        },
        name: single('m.room.name'),
        topic: single('m.room.topic'),
        avatar: single('m.room.avatar'),
        joinRules: single('m.room.join_rules'),
        historyVisibility: single('m.room.history_visibility'),
        canonicalAlias: single('m.room.canonical_alias'),
        encryption: single('m.room.encryption'),
        tombstone: single('m.room.tombstone'),
      },
      spaceParents: [...(state.get('m.space.parent')?.keys() ?? [])],
      creators: this.creatorsOf(roomId).map((userId) => ({
        userId,
        displayName: this.displayNameOf(roomId, userId),
      })),
      encryption: this.encryptionOf(roomId),
    };
  }

  private membersSnapshot(
    accountId: string,
    roomId: string,
  ): RoomMembers | null {
    const state = this.rooms.get(roomId);
    if (
      !this.live.has(accountId) ||
      !state ||
      !this.membershipOf(roomId, accountId)
    ) {
      return null;
    }
    const members: RoomMemberInfo[] = [];
    for (const [userId, event] of state.get('m.room.member') ?? []) {
      const membership = this.membershipOf(roomId, userId);
      if (!membership) continue;
      members.push({
        userId,
        displayName: this.displayNameOf(roomId, userId),
        avatarMxc: text(event.content['avatar_url']),
        membership,
        reason: text(event.content['reason']),
        power: this.powerOf(roomId, userId),
      });
    }
    return { roomId, complete: true, members };
  }

  private encryptionOf(roomId: string): AdministeredRoom['encryption'] {
    if (this.content(roomId, 'm.room.encryption', '')) return 'encrypted';
    const answer = this.encryptionAnswers.get(roomId);
    if (answer === null) return 'unknown';
    return answer ? 'encrypted' : 'unencrypted';
  }

  /** js-sdk `powerLevelForUserId`, applied only when create and power levels exist. */
  private powerOf(roomId: string, userId: string): PowerLevel {
    const levels = this.content(roomId, 'm.room.power_levels', '');
    if (!levels || !this.content(roomId, 'm.room.create', '')) return 0;
    if (this.hydra(roomId) && this.creatorsOf(roomId).includes(userId)) {
      return 'infinite';
    }
    const own = record(levels['users'])?.[userId];
    if (Number.isInteger(own)) return own as number;
    const fallback = levels['users_default'];
    return typeof fallback === 'number' ? fallback : 0;
  }

  private hydra(roomId: string): boolean {
    return isHydraRoomVersion(
      this.content(roomId, 'm.room.create', '')?.['room_version'],
    );
  }

  private creatorsOf(roomId: string): string[] {
    const create = this.rooms.get(roomId)?.get('m.room.create')?.get('');
    if (!create) return [];
    const additional = create.content['additional_creators'];
    const ids = [create.sender];
    if (this.hydra(roomId) && Array.isArray(additional)) {
      ids.push(
        ...additional.filter((id): id is string => typeof id === 'string'),
      );
    }
    return [...new Set(ids)];
  }

  /**
   * js-sdk `RoomMember.name`: the user id is appended to a name that looks like a user id,
   * has direction marks, or matches another member's after hidden-character removal.
   */
  private displayNameOf(roomId: string, userId: string): string {
    const members = this.rooms.get(roomId)?.get('m.room.member');
    const name = members?.get(userId)?.content['displayname'];
    if (typeof name !== 'string' || !name || name === userId) return userId;
    const key = withoutHiddenChars(name);
    if (!key) return userId;
    const ambiguous =
      MXID_PATTERN.test(key) ||
      DIRECTION_MARKS.test(name) ||
      [...(members ?? [])].some(([other, event]) => {
        const otherName = event.content['displayname'];
        return (
          other !== userId &&
          typeof otherName === 'string' &&
          withoutHiddenChars(otherName) === key
        );
      });
    const shown = name.replace(DIRECTION_OVERRIDES, '');
    return ambiguous ? `${shown} (${userId})` : shown;
  }

  private membershipOf(roomId: string, userId: string): Membership | null {
    const membership = this.content(roomId, 'm.room.member', userId)?.[
      'membership'
    ];
    return typeof membership === 'string' && MEMBERSHIPS.has(membership)
      ? (membership as Membership)
      : null;
  }

  private async joinAs(userId: string, roomId: string): Promise<void> {
    if (this.membershipOf(roomId, userId) !== 'invite') {
      throw new Error(`${userId} is not invited to ${roomId}`);
    }
    this.setMembership(roomId, userId, userId, { membership: 'join' });
  }

  private rename(userId: string, roomId: string, name: string): void {
    const current = this.content(roomId, 'm.room.member', userId) ?? {};
    this.put(roomId, 'm.room.member', userId, userId, {
      ...current,
      displayname: name,
    });
  }

  private setMembership(
    roomId: string,
    userId: string,
    sender: string,
    content: JsonObject,
  ): void {
    const displayname = this.content(roomId, 'm.room.member', userId)?.[
      'displayname'
    ];
    this.put(roomId, 'm.room.member', userId, sender, {
      ...(typeof displayname === 'string' ? { displayname } : {}),
      ...content,
    });
  }

  private content(
    roomId: string,
    type: string,
    stateKey: string,
  ): JsonObject | null {
    return this.rooms.get(roomId)?.get(type)?.get(stateKey)?.content ?? null;
  }

  private put(
    roomId: string,
    type: string,
    stateKey: string,
    sender: string,
    content: JsonObject,
  ): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new Error(`Unknown room ${roomId}`);
    let byKey = room.get(type);
    if (!byKey) {
      byKey = new Map();
      room.set(type, byKey);
    }
    byKey.set(stateKey, { sender, originServerTs: ++this.clock, content });
    this.changes$.next();
  }

  private changed(): void {
    this.changes$.next();
  }
}
