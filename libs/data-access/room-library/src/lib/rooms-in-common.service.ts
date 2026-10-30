import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
  type WritableSignal,
} from '@angular/core';
import {
  EventType,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomMember,
  type RoomState,
} from 'matrix-js-sdk';
import type { Subscription } from 'rxjs';
import {
  MatrixClientService,
  mutualRoomIds,
} from '@trinity/data-access/matrix-client';
import { roomAvatarMxc } from './js-sdk/room-avatar';
import { RoomLibraryService } from './room-library.service';
import { initialOf } from './room-projection';
import { directMapOf, isJoinedSpace } from './js-sdk/room-info';

/** A joined room or space that another person has also joined. */
export interface CommonRoom {
  readonly id: string;
  /** The account whose client found the room. */
  readonly accountId: string;
  readonly name: string;
  readonly initial: string;
  readonly avatarMxc: string | null;
  readonly kind: 'room' | 'direct' | 'space';
  readonly memberCount: number;
}

type CommonRooms = readonly CommonRoom[] | null;

/** Pending (`undefined`), unavailable so read locally (`null`), or the server's room ids. */
type ServerAnswer = ReadonlySet<string> | null | undefined;

interface CommonView {
  readonly userId: string;
  readonly client: MatrixClient;
  readonly view: Signal<CommonRooms>;
  readonly server: WritableSignal<ServerAnswer>;
  timer?: ReturnType<typeof setTimeout>;
  fetch?: Subscription;
}

const REFETCH_DELAY_MS = 1000;
const MAX_VIEWS = 20;
const NO_ROOMS: Signal<CommonRooms> = signal(null).asReadonly();

function sameCommonRooms(a: CommonRooms, b: CommonRooms): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((room, i) => {
    const other = b[i];
    return (Object.keys(room) as (keyof CommonRoom)[]).every(
      (key) => room[key] === other[key],
    );
  });
}

/**
 * The rooms and spaces an account shares with another person, for their user card. The server's
 * MSC2666 answer comes first, since lazy-loaded members leave most rooms' rosters unknown
 * locally; membership the client can see overrides it.
 */
@Injectable({ providedIn: 'root' })
export class RoomsInCommonService {
  private readonly matrix = inject(MatrixClientService);
  private readonly library = inject(RoomLibraryService);

  private readonly views = new Map<string, CommonView>();
  /** User ids some view lists rooms for; other people's member events are ignored. */
  private readonly watched = new Set<string>();
  /** Bumped when local membership, a room name or a room avatar changes. */
  private readonly revision = signal(0);

  private readonly onName = (): void => {
    if (this.views.size) this.bump();
  };
  private readonly onStateEvent = (event: MatrixEvent): void => {
    if (this.views.size && event.getType() === EventType.RoomAvatar) {
      this.bump();
    }
  };

  /** The live accounts; ask {@link roomsInCommon} again when they change. */
  readonly accountIds = this.matrix.accountIds;

  constructor() {
    let first = true;
    // One listener set per live account client, not per room; re-bound when a client is
    // added or replaced, which also drops every view built on the outgoing clients.
    effect((onCleanup) => {
      const clients = this.matrix
        .accountIds()
        .map((id) => this.matrix.clientFor(id))
        .filter((client): client is MatrixClient => client !== null);
      if (!first) untracked(() => this.forget());
      first = false;
      // Per-client handlers, so a membership change refetches only that account's views.
      const bound = clients.map((client) => {
        const onMember = (
          _event: MatrixEvent,
          _state: RoomState,
          member: RoomMember,
        ): void => this.membershipChanged(client, member.userId);
        const onMyMembership = (): void => this.membershipChanged(client);
        client.on(RoomStateEvent.Members, onMember);
        client.on(RoomStateEvent.Events, this.onStateEvent);
        client.on(RoomEvent.MyMembership, onMyMembership);
        client.on(RoomEvent.Name, this.onName);
        return () => {
          client.off(RoomStateEvent.Members, onMember);
          client.off(RoomStateEvent.Events, this.onStateEvent);
          client.off(RoomEvent.MyMembership, onMyMembership);
          client.off(RoomEvent.Name, this.onName);
        };
      });
      onCleanup(() => bound.forEach((unbind) => unbind()));
    });
  }

  /**
   * Rooms and spaces that `accountId` (default: the active account) and `userId` have both
   * joined, without `excludeRoomId`, ordered by name. Null until that account's rooms are
   * prepared and the first answer arrives, and, without `accountId`, once another account is
   * active. Cached per user, excluded room and account, for the {@link MAX_VIEWS} latest.
   * Call again when `accountIds()` changes: a held view is orphaned once its client restarts.
   */
  roomsInCommon(
    userId: string,
    excludeRoomId: string,
    accountId?: string | null,
  ): Signal<CommonRooms> {
    const follows = !accountId;
    const owner = accountId || untracked(this.matrix.activeUserId);
    const client = owner ? this.matrix.clientFor(owner) : null;
    if (!owner || !client) return NO_ROOMS;
    const key = [userId, excludeRoomId, owner, follows].join('\n');
    let entry = this.views.get(key);
    if (entry) {
      // Least recently requested first, for eviction.
      this.views.delete(key);
      this.views.set(key, entry);
    } else {
      const server = signal<ServerAnswer>(undefined);
      const view = computed(
        () => {
          this.revision();
          // Our own room set and member counts change through the room-list rebuilds.
          this.library.rooms();
          if (follows && this.matrix.activeUserId() !== owner) return null;
          const answer = server();
          if (answer === undefined || !this.matrix.roomsPrepared(owner)) {
            return null;
          }
          return this.read(client, owner, userId, excludeRoomId, answer);
        },
        { equal: sameCommonRooms },
      );
      entry = { userId, client, view, server };
      this.views.set(key, entry);
      this.watched.add(userId);
      this.fetch(entry);
      this.evictBeyondCap();
    }
    return entry.view;
  }

  private read(
    client: MatrixClient,
    owner: string,
    userId: string,
    excludeRoomId: string,
    server: ReadonlySet<string> | null,
  ): readonly CommonRoom[] {
    const { userByRoom } = directMapOf(client);
    return client
      .getRooms()
      .filter((room) => {
        if (
          room.roomId === excludeRoomId ||
          room.getMyMembership() !== 'join'
        ) {
          return false;
        }
        // A member the client knows decides; an unloaded roster defers to the server.
        const membership = room.getMember(userId)?.membership;
        return membership ? membership === 'join' : !!server?.has(room.roomId);
      })
      .map((room) => toCommonRoom(room, owner, userByRoom.has(room.roomId)))
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      );
  }

  private fetch(entry: CommonView): void {
    entry.fetch?.unsubscribe();
    entry.fetch = mutualRoomIds(entry.client, entry.userId).subscribe((ids) =>
      entry.server.set(ids),
    );
  }

  private refetchSoon(entry: CommonView): void {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => this.fetch(entry), REFETCH_DELAY_MS);
  }

  /** A member event for `userId`, or this account's own membership when `userId` is absent. */
  private membershipChanged(client: MatrixClient, userId?: string): void {
    if (userId !== undefined && !this.watched.has(userId)) return;
    let affected = false;
    for (const entry of this.views.values()) {
      if (entry.client !== client) continue;
      if (userId !== undefined && entry.userId !== userId) continue;
      affected = true;
      this.refetchSoon(entry);
    }
    if (affected) this.bump();
  }

  private evictBeyondCap(): void {
    for (const [key, entry] of this.views) {
      if (this.views.size <= MAX_VIEWS) return;
      this.release(entry);
      this.views.delete(key);
      if (![...this.views.values()].some((e) => e.userId === entry.userId)) {
        this.watched.delete(entry.userId);
      }
    }
  }

  private release(entry: CommonView): void {
    clearTimeout(entry.timer);
    entry.fetch?.unsubscribe();
  }

  private bump(): void {
    this.revision.update((n) => n + 1);
  }

  private forget(): void {
    for (const entry of this.views.values()) this.release(entry);
    this.views.clear();
    this.watched.clear();
  }
}

function toCommonRoom(room: Room, owner: string, direct: boolean): CommonRoom {
  const name = room.name || room.roomId;
  return {
    id: room.roomId,
    accountId: owner,
    name,
    initial: initialOf(name),
    avatarMxc: roomAvatarMxc(room, direct),
    kind: isJoinedSpace(room) ? 'space' : direct ? 'direct' : 'room',
    memberCount: room.getJoinedMemberCount(),
  };
}
