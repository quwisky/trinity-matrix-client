import {
  Injector,
  Injectable,
  type Signal,
  type WritableSignal,
  inject,
  signal,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
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
import { Observable, of, switchMap } from 'rxjs';
import type { RoomAdministrationView } from './room-administration-health.models';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import type { RoomSettingsTarget } from './room-settings.service';

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

export type RoomMembersAvailability =
  'available' | 'account-unavailable' | 'room-unavailable';

/** Exact Account-and-Room roster and ban state for a settings lifetime. */
export interface RoomMembersSnapshot {
  readonly target: RoomSettingsTarget;
  readonly availability: RoomMembersAvailability;
  readonly unavailableReason: string | null;
  readonly members: readonly MemberSummary[];
  readonly banned: readonly BannedMember[];
}

const EMPTY_MEMBERS: readonly MemberSummary[] = Object.freeze([]);
const EMPTY_BANS: readonly BannedMember[] = Object.freeze([]);

/** Live joined and banned membership summaries owned by Room Administration. */
@Injectable({ providedIn: 'root' })
export class RoomMembersService {
  private readonly matrix = inject(MatrixClientService);
  private readonly injector = inject(Injector);
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
    return this.membersFrom(
      this.matrix.instance,
      roomId,
      `active\x1f${roomId}`,
    );
  }

  /** Read one settings roster from its immutable opening Account. */
  snapshot(target: RoomSettingsTarget): RoomMembersSnapshot {
    const client = this.matrix.clientFor(target.accountId);
    const room = client?.getRoom(target.roomId) ?? null;
    const joined = room?.getMyMembership() === KnownMembership.Join;
    const availability: RoomMembersAvailability = !client
      ? 'account-unavailable'
      : !room || !joined
        ? 'room-unavailable'
        : 'available';
    const cacheKey = `${target.accountId}\x1f${target.roomId}`;
    return {
      target,
      availability,
      unavailableReason:
        availability === 'account-unavailable'
          ? 'This Account is no longer available. The member list remains attached to the opening Account.'
          : availability === 'room-unavailable'
            ? 'This Room is no longer joined for the opening Account.'
            : null,
      members:
        client && availability === 'available'
          ? this.membersFrom(client, target.roomId, cacheKey)
          : EMPTY_MEMBERS,
      banned:
        client && availability === 'available'
          ? this.bannedFrom(client, target.roomId, cacheKey)
          : EMPTY_BANS,
    };
  }

  /**
   * Observe one exact settings target. Subscription owns only that Account's filtered
   * membership listeners and reattaches if the Account is removed or restored.
   */
  observe(target: RoomSettingsTarget): Observable<RoomMembersSnapshot> {
    return toObservable(this.matrix.accountIds, {
      injector: this.injector,
    }).pipe(switchMap(() => this.observeCurrentClient(target)));
  }

  private observeCurrentClient(
    target: RoomSettingsTarget,
  ): Observable<RoomMembersSnapshot> {
    const client = this.matrix.clientFor(target.accountId);
    if (!client) return of(this.snapshot(target));
    return new Observable((subscriber) => {
      const publish = (): void => subscriber.next(this.snapshot(target));
      const onMember = (_event: MatrixEvent, state: RoomState): void => {
        if (state.roomId === target.roomId) publish();
      };
      const onMembership = (room?: { roomId?: string }): void => {
        if (!room?.roomId || room.roomId === target.roomId) publish();
      };
      client.on(RoomStateEvent.Members, onMember);
      client.on(RoomEvent.MyMembership, onMembership);
      client.on(ClientEvent.Sync, publish);
      publish();
      return () => {
        client.off(RoomStateEvent.Members, onMember);
        client.off(RoomEvent.MyMembership, onMembership);
        client.off(ClientEvent.Sync, publish);
      };
    });
  }

  private membersFrom(
    client: MatrixClient,
    roomId: string,
    cacheKey: string,
  ): readonly MemberSummary[] {
    const room = client.getRoom(roomId);
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
    const cached = this.memberCache.get(cacheKey);
    if (cached?.fingerprint === fingerprint) {
      return cached.members;
    }
    const creatorId = room.getCreator();
    const members = joined
      .map((member) => this.toSummary(member, creatorId))
      .sort((a, b) =>
        this.collator.compare(a.roomDisplayName, b.roomDisplayName),
      );
    this.memberCache.set(cacheKey, { fingerprint, members });
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
    return this.bannedFrom(this.matrix.instance, roomId, `active\x1f${roomId}`);
  }

  private bannedFrom(
    client: MatrixClient,
    roomId: string,
    cacheKey: string,
  ): readonly BannedMember[] {
    const room = client.getRoom(roomId);
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
    const cached = this.bannedCache.get(cacheKey);
    if (cached?.fingerprint === fingerprint) {
      return cached.members;
    }
    summaries.sort((a, b) =>
      this.collator.compare(a.roomDisplayName, b.roomDisplayName),
    );
    this.bannedCache.set(cacheKey, { fingerprint, members: summaries });
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
