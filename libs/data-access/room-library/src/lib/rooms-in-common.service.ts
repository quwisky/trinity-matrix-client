import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  type Signal,
} from '@angular/core';
import {
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type RoomMember,
  type RoomState,
} from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomLibraryService } from './room-library.service';
import { SpacesService } from './spaces.service';
import {
  buildRoomSummary,
  directMapOf,
  isJoinedSpace,
} from './room-projection';

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

/** The rooms and spaces an account shares with another person, for their user card. */
@Injectable({ providedIn: 'root' })
export class RoomsInCommonService {
  private readonly matrix = inject(MatrixClientService);
  private readonly library = inject(RoomLibraryService);
  private readonly spaces = inject(SpacesService);

  private readonly views = new Map<
    string,
    Signal<readonly CommonRoom[] | null>
  >();
  /** User ids some view lists rooms for; other people's member events are ignored. */
  private readonly watched = new Set<string>();
  /** Bumped when a watched person's membership, or this account's own, changes. */
  private readonly revision = signal(0);

  private readonly onMember = (
    _event: MatrixEvent,
    _state: RoomState,
    member: RoomMember,
  ): void => {
    if (this.watched.has(member.userId)) this.revision.update((n) => n + 1);
  };
  private readonly onMyMembership = (): void => {
    if (this.watched.size) this.revision.update((n) => n + 1);
  };

  constructor() {
    // One listener pair per live account client, not per room; re-bound when a client is
    // added or replaced. The room list does not rebuild on other members' joins and leaves.
    effect((onCleanup) => {
      const clients = this.matrix
        .accountIds()
        .map((id) => this.matrix.clientFor(id))
        .filter((client): client is MatrixClient => client !== null);
      for (const client of clients) {
        client.on(RoomStateEvent.Members, this.onMember);
        client.on(RoomEvent.MyMembership, this.onMyMembership);
      }
      onCleanup(() => {
        for (const client of clients) {
          client.off(RoomStateEvent.Members, this.onMember);
          client.off(RoomEvent.MyMembership, this.onMyMembership);
        }
      });
    });
  }

  /**
   * Rooms and spaces that `accountId` (default: the active account) and `userId` have both
   * joined, without `excludeRoomId`, ordered by name; null until that account's rooms are
   * prepared. Cached per user, excluded room and account.
   */
  roomsInCommon(
    userId: string,
    excludeRoomId: string,
    accountId?: string | null,
  ): Signal<readonly CommonRoom[] | null> {
    const key = `${userId}\n${excludeRoomId}\n${accountId ?? ''}`;
    let view = this.views.get(key);
    if (!view) {
      this.watched.add(userId);
      view = computed(() => this.read(userId, excludeRoomId, accountId));
      this.views.set(key, view);
    }
    return view;
  }

  private read(
    userId: string,
    excludeRoomId: string,
    accountId?: string | null,
  ): readonly CommonRoom[] | null {
    this.revision();
    // Names, avatars and our own room set change through the room-list rebuilds.
    this.library.rooms();
    this.spaces.spaces();
    const owner = accountId ?? this.matrix.activeUserId();
    const client = owner ? this.matrix.clientFor(owner) : null;
    if (!owner || !client || !this.matrix.roomsPrepared(owner)) return null;
    // The owner's own `m.direct` map: `directRoomIds()` covers only the active account.
    const { userByRoom } = directMapOf(client);
    return client
      .getRooms()
      .filter(
        (room) =>
          room.roomId !== excludeRoomId &&
          room.getMyMembership() === 'join' &&
          room.getMember(userId)?.membership === 'join',
      )
      .map((room): CommonRoom => {
        const summary = buildRoomSummary(
          room,
          owner,
          userByRoom.get(room.roomId),
        );
        return {
          id: summary.id,
          accountId: owner,
          name: summary.name,
          initial: summary.initial,
          avatarMxc: summary.avatarMxc,
          kind: isJoinedSpace(room)
            ? 'space'
            : userByRoom.has(room.roomId)
              ? 'direct'
              : 'room',
          memberCount: summary.memberCount,
        };
      })
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      );
  }
}
