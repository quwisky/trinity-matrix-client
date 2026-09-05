import {
  Injectable,
  type Signal,
  type WritableSignal,
  inject,
  signal,
} from '@angular/core';
import {
  ClientEvent,
  KnownMembership,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type RoomMember,
  type RoomState,
} from 'matrix-js-sdk';
import {
  MatrixClientService,
  coalesce,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import { initialOf } from '@trinity/util/matrix';
import type { Observable } from 'rxjs';
import type { RoomAdministrationView } from './room-administration-health.models';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';

/** A joined member projected from authoritative Matrix room state.
 *
 * Matrix membership events may override a user's display name and avatar for one Room.
 * The explicit `room*` names keep that contextual presentation distinct from the stable
 * user summary owned by Identity.
 */
export interface MemberSummary {
  readonly userId: string;
  readonly roomDisplayName: string;
  readonly roomInitial: string;
  readonly roomAvatarMxc: string | null;
  readonly powerLevel: number;
  /** Immutable creator identity, independent of the member's current power level. */
  readonly isCreator: boolean;
}

/** A banned member projected from authoritative Matrix room state. */
export interface BannedMember {
  readonly userId: string;
  readonly roomDisplayName: string;
  readonly reason: string | null;
}

const EMPTY_MEMBERS: readonly MemberSummary[] = Object.freeze([]);
const EMPTY_BANS: readonly BannedMember[] = Object.freeze([]);

/** Live joined and banned membership summaries owned by Room Administration. */
@Injectable({ providedIn: 'root' })
export class RoomMembersService {
  private readonly matrix = inject(MatrixClientService);
  private readonly projectionState = inject(RoomAdministrationProjectionState);
  private readonly memberSignals = new Map<
    string,
    WritableSignal<readonly MemberSummary[]>
  >();
  private readonly bannedSignals = new Map<
    string,
    WritableSignal<readonly BannedMember[]>
  >();
  private readonly dirtyRooms = new Set<string>();
  private allDirty = false;
  private lastClient: MatrixClient | null = null;
  private retryRequested = false;
  private readonly collator = new Intl.Collator();
  private readonly memberCache = new Map<
    string,
    { readonly fingerprint: string; readonly members: readonly MemberSummary[] }
  >();
  private readonly bannedCache = new Map<
    string,
    { readonly fingerprint: string; readonly members: readonly BannedMember[] }
  >();

  private readonly flusher = coalesce(() => {
    if (this.allDirty) {
      this.allDirty = false;
      this.dirtyRooms.clear();
      this.reread(null);
      return;
    }
    const rooms = [...this.dirtyRooms];
    this.dirtyRooms.clear();
    for (const roomId of rooms) {
      this.reread(roomId);
    }
  });

  private readonly onMemberChanged = (
    _event: MatrixEvent,
    state: RoomState,
  ): void => this.schedule(state.roomId);

  private readonly onMyMembership = (room?: { roomId?: string }): void =>
    this.schedule(room?.roomId ?? null);

  private readonly projection = projectFromClient({
    id: 'room-administration.members',
    matrix: this.matrix,
    events: [ClientEvent.Sync],
    rebuild: (client) => {
      if (client !== this.lastClient || this.retryRequested) {
        this.retryRequested = false;
        this.lastClient = client;
        this.memberCache.clear();
        this.bannedCache.clear();
        this.reread(null);
      }
    },
    bind: (client) => {
      client.on(RoomStateEvent.Members, this.onMemberChanged);
      client.on(RoomEvent.MyMembership, this.onMyMembership);
    },
    unbind: (client) => {
      client.off(RoomStateEvent.Members, this.onMemberChanged);
      client.off(RoomEvent.MyMembership, this.onMyMembership);
    },
    reset: () => {
      this.lastClient = null;
      this.memberCache.clear();
      this.bannedCache.clear();
      this.flusher.cancel();
      this.dirtyRooms.clear();
      this.allDirty = false;
      this.retryRequested = false;
      for (const members of this.memberSignals.values()) {
        members.set(EMPTY_MEMBERS);
      }
      for (const bans of this.bannedSignals.values()) {
        bans.set(EMPTY_BANS);
      }
    },
  });

  /** Cold membership projection retained by the Room Administration session lifetime. */
  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /** Repair this retained projection without adding another listener owner. */
  retryProjection(): void {
    this.retryRequested = true;
    this.projection.schedule();
  }

  /** A memoized signal for one Room's joined members. */
  membersFor(roomId: string | null): Signal<readonly MemberSummary[]> {
    const key = roomId ?? '';
    let members = this.memberSignals.get(key);
    if (!members) {
      members = signal(this.membersOf(roomId));
      this.memberSignals.set(key, members);
    }
    return members.asReadonly();
  }

  /** Joined members with explicit current, stale, or unavailable authority. */
  membersView(
    roomId: string | null,
  ): RoomAdministrationView<readonly MemberSummary[]> {
    return this.projectionState.view(
      'members',
      roomId,
      this.membersFor(roomId)(),
    );
  }

  /** One authoritative snapshot of a Room's joined members. */
  membersOf(roomId: string | null): readonly MemberSummary[] {
    if (!roomId || !this.matrix.isInitialized) {
      return EMPTY_MEMBERS;
    }
    const room = this.matrix.instance.getRoom(roomId);
    if (!room) {
      return EMPTY_MEMBERS;
    }
    const joined = room.getJoinedMembers();
    const fingerprint = joined
      .map(
        (member) =>
          `${member.userId}\x1f${member.name}\x1f${member.getMxcAvatarUrl() ?? ''}\x1f${member.powerLevel}`,
      )
      .join('\x1e');
    const cached = this.memberCache.get(roomId);
    if (cached?.fingerprint === fingerprint) {
      return cached.members;
    }
    const creatorId = room.getCreator();
    const members = joined
      .map((member) => this.toSummary(member, creatorId))
      .sort((a, b) =>
        this.collator.compare(a.roomDisplayName, b.roomDisplayName),
      );
    this.memberCache.set(roomId, { fingerprint, members });
    return members;
  }

  /** A memoized signal for one Room's banned members. */
  bannedFor(roomId: string | null): Signal<readonly BannedMember[]> {
    const key = roomId ?? '';
    let members = this.bannedSignals.get(key);
    if (!members) {
      members = signal(this.bannedMembersOf(roomId));
      this.bannedSignals.set(key, members);
    }
    return members.asReadonly();
  }

  /** Banned members with explicit current, stale, or unavailable authority. */
  bannedView(
    roomId: string | null,
  ): RoomAdministrationView<readonly BannedMember[]> {
    return this.projectionState.view('bans', roomId, this.bannedFor(roomId)());
  }

  /** One authoritative snapshot of a Room's banned members. */
  bannedMembersOf(roomId: string | null): readonly BannedMember[] {
    if (!roomId || !this.matrix.isInitialized) {
      return EMPTY_BANS;
    }
    const room = this.matrix.instance.getRoom(roomId);
    if (!room) {
      return EMPTY_BANS;
    }
    const banned = room.getMembersWithMembership(KnownMembership.Ban);
    const summaries = banned.map((member) => {
      const reason = member.events?.member?.getContent()?.['reason'];
      return {
        userId: member.userId,
        roomDisplayName: member.name || member.userId,
        reason: typeof reason === 'string' && reason ? reason : null,
      } satisfies BannedMember;
    });
    const fingerprint = summaries
      .map(
        (member) =>
          `${member.userId}\x1f${member.roomDisplayName}\x1f${member.reason ?? ''}`,
      )
      .join('\x1e');
    const cached = this.bannedCache.get(roomId);
    if (cached?.fingerprint === fingerprint) {
      return cached.members;
    }
    summaries.sort((a, b) =>
      this.collator.compare(a.roomDisplayName, b.roomDisplayName),
    );
    this.bannedCache.set(roomId, { fingerprint, members: summaries });
    return summaries;
  }

  private schedule(roomId: string | null): void {
    if (roomId === null) {
      this.allDirty = true;
    } else if (
      this.memberSignals.has(roomId) ||
      this.bannedSignals.has(roomId)
    ) {
      this.dirtyRooms.add(roomId);
    } else {
      return;
    }
    this.flusher.schedule();
  }

  private reread(roomId: string | null): void {
    if (roomId !== null) {
      this.memberSignals.get(roomId)?.set(this.membersOf(roomId));
      this.bannedSignals.get(roomId)?.set(this.bannedMembersOf(roomId));
      return;
    }
    for (const [key, members] of this.memberSignals) {
      members.set(this.membersOf(key || null));
    }
    for (const [key, bans] of this.bannedSignals) {
      bans.set(this.bannedMembersOf(key || null));
    }
  }

  private toSummary(
    member: RoomMember,
    creatorId: string | null,
  ): MemberSummary {
    const roomDisplayName = member.name || member.userId;
    return {
      userId: member.userId,
      roomDisplayName,
      roomInitial: initialOf(roomDisplayName),
      roomAvatarMxc: member.getMxcAvatarUrl() ?? null,
      powerLevel: member.powerLevel,
      isCreator: !!creatorId && member.userId === creatorId,
    };
  }
}
