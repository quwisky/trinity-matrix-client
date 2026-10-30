import {
  Injectable,
  computed,
  effect,
  inject,
  signal,
  untracked,
  type Signal,
} from '@angular/core';
import type { Subscription } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { plainEqual } from '@trinity/util/matrix';
import type { RoomInfo } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { RoomListStore } from './room-list-store';
import { initialOf } from './room-projection';

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

interface CommonView {
  readonly owner: string;
  readonly generation: number;
  readonly view: Signal<CommonRooms>;
  readonly subscription: Subscription;
}

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

function toCommonRoom(room: RoomInfo, owner: string): CommonRoom {
  return {
    id: room.roomId,
    accountId: owner,
    name: room.displayName,
    initial: initialOf(room.displayName),
    avatarMxc: room.avatarMxc,
    kind: room.isSpace ? 'space' : room.directUserId ? 'direct' : 'room',
    memberCount: room.joinedMemberCount,
  };
}

/** The rooms and spaces an account shares with another person, for their user card. */
@Injectable({ providedIn: 'root' })
export class RoomsInCommonService {
  private readonly engine = inject(ROOM_LIST_ENGINE);
  private readonly store = inject(RoomListStore);
  private readonly session = inject(SessionStateService);

  private readonly views = new Map<string, CommonView>();
  /** Each live account and its session generation, which grows when the account restarts. */
  private readonly generations = computed(
    () =>
      this.session
        .snapshot()
        .accounts.map((a): [string, number] => [a.accountId, a.generation]),
    { equal: plainEqual },
  );

  /** The live accounts, ticking on a restart too; ask {@link roomsInCommon} again when they change. */
  readonly accountIds: Signal<readonly string[]> = computed(() =>
    this.generations().map(([accountId]) => accountId),
  );

  constructor() {
    // Releases the views of accounts that left or restarted; asking again opens a fresh one.
    effect(() => {
      const live = new Map(this.generations());
      untracked(() => {
        for (const [key, entry] of this.views) {
          if (live.get(entry.owner) === entry.generation) continue;
          entry.subscription.unsubscribe();
          this.views.delete(key);
        }
      });
    });
  }

  /**
   * Rooms and spaces that `accountId` (default: the active account) and `userId` have both
   * joined, without `excludeRoomId`, ordered by name. Null until that account's rooms are
   * prepared and the first answer arrives, and, without `accountId`, once another account is
   * active. Cached per user, excluded room and account, for the {@link MAX_VIEWS} latest.
   * Call again when `accountIds()` changes: a held view is orphaned once its account restarts.
   */
  roomsInCommon(
    userId: string,
    excludeRoomId: string,
    accountId?: string | null,
  ): Signal<CommonRooms> {
    const follows = !accountId;
    const owner = accountId || untracked(this.session.activeAccountId);
    const generation = owner
      ? untracked(() => this.session.status(owner))?.generation
      : undefined;
    if (!owner || generation === undefined) return NO_ROOMS;
    const key = [userId, excludeRoomId, owner, follows, generation].join('\n');
    let entry = this.views.get(key);
    if (entry) {
      // Least recently requested first, for eviction.
      this.views.delete(key);
      this.views.set(key, entry);
    } else {
      const shared = signal<ReadonlySet<string> | null>(null);
      const subscription = this.engine
        .roomsInCommon(owner, userId)
        .subscribe((ids) => shared.set(new Set(ids)));
      const rooms = this.store.rooms(owner);
      const view = computed(
        () => {
          if (follows && this.session.activeAccountId() !== owner) return null;
          const ids = shared();
          if (!ids || !this.session.status(owner)?.roomsPrepared) return null;
          return rooms()
            .filter(
              (room) =>
                room.membership === 'join' &&
                room.roomId !== excludeRoomId &&
                ids.has(room.roomId),
            )
            .map((room) => toCommonRoom(room, owner))
            .sort((a, b) =>
              a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
            );
        },
        { equal: sameCommonRooms },
      );
      entry = { owner, generation, view, subscription };
      this.views.set(key, entry);
      this.evictBeyondCap();
    }
    return entry.view;
  }

  private evictBeyondCap(): void {
    for (const [key, entry] of this.views) {
      if (this.views.size <= MAX_VIEWS) return;
      entry.subscription.unsubscribe();
      this.views.delete(key);
    }
  }
}
