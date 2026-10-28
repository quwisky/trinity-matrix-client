import { Injectable, inject } from '@angular/core';
import {
  ClientEvent,
  EventType,
  KnownMembership,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  RoomEvent,
  type RoomMember,
  type RoomState,
  RoomStateEvent,
} from 'matrix-js-sdk';
import {
  NEVER,
  Observable,
  catchError,
  concat,
  defer,
  distinctUntilChanged,
  from,
  map,
  of,
} from 'rxjs';
import { JS_SDK_CLIENTS, coalesce } from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  type EngineResult,
  describeMatrixRequestFailure,
  engineFail,
  engineOk,
  isRoomEncrypted,
  liveRoomState,
  plainEqual,
} from '@trinity/util/matrix';
import type {
  AdministeredRoom,
  JsonObject,
  Membership,
  PowerLevel,
  RoomAdministrationEngine,
  RoomCreatorInfo,
  RoomMemberInfo,
  RoomMembers,
} from '../room-administration-engine';
import { isHydraRoomVersion } from '../room-power';

const MEMBERSHIPS: ReadonlySet<string> = new Set<Membership>([
  'join',
  'invite',
  'knock',
  'leave',
  'ban',
]);

function localFailure(
  code: 'account-not-live' | 'room-unavailable',
): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

function requestFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return {
    kind,
    code: 'request-failed',
    diagnostic,
    ...(diagnostic.errorName === 'TokenRefreshError'
      ? { params: { cause: 'session-refresh' as const } }
      : {}),
  };
}

/** {@link RoomAdministrationEngine} over the live matrix-js-sdk clients of {@link JS_SDK_CLIENTS}. */
@Injectable({ providedIn: 'root' })
export class JsSdkRoomAdministrationEngine implements RoomAdministrationEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);
  /** Per client and room: the crypto store's answer to "is this room encrypted?". */
  private readonly encryptionAnswers = new WeakMap<
    MatrixClient,
    Map<string, boolean>
  >();

  room(accountId: string, roomId: string): Observable<AdministeredRoom | null> {
    return this.watch(accountId, roomId, (client, schedule) => {
      let asked = false;
      const onState = (event: MatrixEvent, state?: RoomState): void => {
        if (event.getRoomId() === roomId || state?.roomId === roomId) {
          schedule();
        }
      };
      const onMembership = (room?: { roomId?: string }): void => {
        if (!room?.roomId || room.roomId === roomId) schedule();
      };
      client.on(RoomStateEvent.Events, onState);
      client.on(RoomStateEvent.Members, onState);
      client.on(RoomEvent.MyMembership, onMembership);
      return {
        read: () => {
          const room = client.getRoom(roomId);
          if (!room) return null;
          const answers = this.answers(client);
          // Unknown until the crypto store answers, so nobody offers to encrypt a room it
          // may know is encrypted.
          if (
            !asked &&
            !room.hasEncryptionStateEvent() &&
            !answers.has(roomId)
          ) {
            asked = true;
            void isRoomEncrypted(room, client.getCrypto?.()).then(
              (encrypted) => {
                answers.set(roomId, encrypted);
                schedule();
              },
            );
          }
          return roomSnapshot(client, accountId, room, answers.get(roomId));
        },
        detach: () => {
          client.off(RoomStateEvent.Events, onState);
          client.off(RoomStateEvent.Members, onState);
          client.off(RoomEvent.MyMembership, onMembership);
        },
      };
    }).pipe(distinctUntilChanged<AdministeredRoom | null>(plainEqual));
  }

  members(accountId: string, roomId: string): Observable<RoomMembers | null> {
    return this.watch(accountId, roomId, (client, schedule) => {
      const onMember = (_event: MatrixEvent, state: RoomState): void => {
        if (state.roomId === roomId) schedule();
      };
      const onMembership = (room?: { roomId?: string }): void => {
        if (!room?.roomId || room.roomId === roomId) schedule();
      };
      client.on(RoomStateEvent.Members, onMember);
      client.on(RoomEvent.MyMembership, onMembership);
      let requested = false;
      return {
        read: () => {
          const room = client.getRoom(roomId);
          if (!room) return null;
          if (!requested) {
            requested = true;
            // Lazily synced members: load the rest. They arrive as RoomState.members
            // events; the load finishing flips `complete`.
            void room
              .loadMembersIfNeeded()
              .then(schedule)
              .catch(() => undefined);
          }
          return membersSnapshot(room);
        },
        detach: () => {
          client.off(RoomStateEvent.Members, onMember);
          client.off(RoomEvent.MyMembership, onMembership);
        },
      };
    }).pipe(distinctUntilChanged<RoomMembers | null>(plainEqual));
  }

  setState(
    accountId: string,
    roomId: string,
    type: string,
    stateKey: string,
    content: JsonObject,
  ): Observable<EngineResult<null>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(localFailure('account-not-live')));
      if (client.getRoom(roomId)?.getMyMembership() !== KnownMembership.Join) {
        return of(engineFail(localFailure('room-unavailable')));
      }
      // The SDK's typed state map cannot name an arbitrary event type.
      const send = client.sendStateEvent.bind(client) as unknown as (
        targetRoomId: string,
        eventType: string,
        eventContent: JsonObject,
        targetStateKey: string,
      ) => Promise<unknown>;
      return from(send(roomId, type, content, stateKey)).pipe(
        map(() => engineOk(null)),
        catchError((error: unknown) => of(engineFail(requestFailed(error)))),
      );
    });
  }

  /**
   * A snapshot subscription for one account: `null` at once while the account is not
   * live, else a synchronous first value and microtask-coalesced re-reads, stopping when
   * the account's client is replaced (the caller subscribes again). Syncs are followed
   * only while the client does not know the room; once it does, `attach`'s room events
   * carry every change, so a sync costs no re-read.
   */
  private watch<T>(
    accountId: string,
    roomId: string,
    attach: (
      client: MatrixClient,
      schedule: () => void,
    ) => { read(): T | null; detach(): void },
  ): Observable<T | null> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return concat(of(null), NEVER);
      return new Observable<T | null>((subscriber) => {
        let followingSync = false;
        const onSync = (): void => queue.schedule();
        const onDelete = (deleted: string): void => {
          if (deleted === roomId) queue.schedule();
        };
        const followSync = (follow: boolean): void => {
          if (follow === followingSync) return;
          followingSync = follow;
          if (follow) client.on(ClientEvent.Sync, onSync);
          else client.off(ClientEvent.Sync, onSync);
        };
        const publish = (): void => {
          // A late async answer may still schedule after the unsubscribe.
          if (
            !subscriber.closed &&
            this.clients.clientFor(accountId) === client
          ) {
            const value = source.read();
            followSync(value === null);
            subscriber.next(value);
          }
        };
        const queue = coalesce(publish);
        const source = attach(client, () => queue.schedule());
        client.on(ClientEvent.DeleteRoom, onDelete);
        publish();
        return () => {
          queue.cancel();
          followSync(false);
          client.off(ClientEvent.DeleteRoom, onDelete);
          source.detach();
        };
      });
    });
  }

  private answers(client: MatrixClient): Map<string, boolean> {
    let answers = this.encryptionAnswers.get(client);
    if (!answers) {
      answers = new Map();
      this.encryptionAnswers.set(client, answers);
    }
    return answers;
  }
}

function roomSnapshot(
  client: MatrixClient,
  accountId: string,
  room: Room,
  storeAnswer: boolean | undefined,
): AdministeredRoom {
  const ownUserId = client.getUserId() ?? accountId;
  const state = liveRoomState(room);
  const single = (type: string): JsonObject | null => {
    const event = state?.getStateEvents(type, '');
    return event ? plain(event.getContent()) : null;
  };
  const create = state?.getStateEvents(EventType.RoomCreate, '') ?? null;
  const createdAt = create?.getTs();
  return {
    roomId: room.roomId,
    ownUserId,
    ownMembership: membershipOf(room.getMyMembership()),
    ownPower: powerOf(room.getMember(ownUserId)?.powerLevel ?? 0),
    powerLevels: single(EventType.RoomPowerLevels),
    isSpace: room.isSpaceRoom(),
    state: {
      create: create && {
        sender: create.getSender() ?? null,
        originServerTs:
          typeof createdAt === 'number' && Number.isFinite(createdAt)
            ? createdAt
            : null,
        content: plain(create.getContent()),
      },
      name: single(EventType.RoomName),
      topic: single(EventType.RoomTopic),
      avatar: single(EventType.RoomAvatar),
      joinRules: single(EventType.RoomJoinRules),
      historyVisibility: single(EventType.RoomHistoryVisibility),
      canonicalAlias: single(EventType.RoomCanonicalAlias),
      encryption: single(EventType.RoomEncryption),
      tombstone: single(EventType.RoomTombstone),
    },
    spaceParents: (state?.getStateEvents(EventType.SpaceParent) ?? []).flatMap(
      (event) => event.getStateKey() ?? [],
    ),
    creators: create ? creatorsOf(create, state) : [],
    encryption: room.hasEncryptionStateEvent()
      ? 'encrypted'
      : storeAnswer === undefined
        ? 'unknown'
        : storeAnswer
          ? 'encrypted'
          : 'unencrypted',
  };
}

function membersSnapshot(room: Room): RoomMembers {
  return {
    roomId: room.roomId,
    complete: room.membersLoaded(),
    members: room.getMembers().flatMap((member): RoomMemberInfo[] => {
      const membership = membershipOf(member.membership);
      return membership ? [memberInfo(member, membership)] : [];
    }),
  };
}

function memberInfo(
  member: RoomMember,
  membership: Membership,
): RoomMemberInfo {
  const reason = member.events?.member?.getContent()?.['reason'];
  return {
    userId: member.userId,
    displayName: member.name || member.userId,
    avatarMxc: member.getMxcAvatarUrl() ?? null,
    membership,
    reason: typeof reason === 'string' && reason.trim() ? reason : null,
    power: powerOf(member.powerLevel),
  };
}

/** The create event's sender (or legacy `creator`), plus v12+ `additional_creators`. */
function creatorsOf(
  create: MatrixEvent,
  state: RoomState | undefined,
): readonly RoomCreatorInfo[] {
  const content: Record<string, unknown> = create.getContent();
  const ids = [text(create.getSender()) ?? text(content['creator'])];
  const additional = content['additional_creators'];
  // Listed exactly when js-sdk gives them creator power.
  if (
    isHydraRoomVersion(content['room_version']) &&
    Array.isArray(additional)
  ) {
    ids.push(...additional.map(text));
  }
  return [...new Set(ids.filter((id): id is string => id !== null))].map(
    (userId) => ({
      userId,
      displayName: state?.getMember(userId)?.name || userId,
    }),
  );
}

/** A v12 creator's `Infinity` crosses as `'infinite'`. */
function powerOf(level: number): PowerLevel {
  return level === Infinity ? 'infinite' : level;
}

function membershipOf(value: string | undefined): Membership | null {
  return value !== undefined && MEMBERSHIPS.has(value)
    ? (value as Membership)
    : null;
}

/** A deep, plain copy: SDK content objects stay the SDK's. */
function plain(content: object): JsonObject {
  return JSON.parse(JSON.stringify(content)) as JsonObject;
}

/** A non-blank string, or null. */
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}
