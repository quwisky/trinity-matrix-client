import {
  Injectable,
  Injector,
  type Signal,
  computed,
  inject,
  untracked,
} from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  SessionStateService,
  projectActiveAccount,
} from '@trinity/data-access/matrix-client';
import { initialOf } from '@trinity/util/matrix';
import {
  NEVER,
  type Observable,
  concat,
  defer,
  distinctUntilChanged,
  of,
  startWith,
} from 'rxjs';
import { AdministeredRoomStore } from './administered-room.store';
import type { Membership, RoomMemberInfo } from './room-administration-engine';
import type { RoomAdministrationView } from './room-administration-health.models';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import { powerValue } from './room-power';
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

/** Someone who asked to join, projected from authoritative Matrix room state. */
export interface KnockRequest {
  readonly userId: string;
  readonly roomDisplayName: string;
  readonly roomInitial: string;
  readonly roomAvatarMxc: string | null;
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
  readonly invited: readonly MemberSummary[];
  readonly knocking: readonly KnockRequest[];
}

const EMPTY_MEMBERS: readonly MemberSummary[] = Object.freeze([]);
const EMPTY_BANS: readonly BannedMember[] = Object.freeze([]);
const EMPTY_KNOCKS: readonly KnockRequest[] = Object.freeze([]);

type ListKind = 'join' | 'invite' | 'ban' | 'knock';

/**
 * Live joined, invited, banned and knocking members owned by Room Administration, read
 * from {@link AdministeredRoomStore}. Every read is reactive and keyed by account, so an
 * account switch or sign-out never shows the previous account's members.
 */
@Injectable({ providedIn: 'root' })
export class RoomMembersService {
  private readonly store = inject(AdministeredRoomStore);
  private readonly session = inject(SessionStateService);
  private readonly injector = inject(Injector);
  private readonly projectionState = inject(RoomAdministrationProjectionState);
  private readonly collator = new Intl.Collator();
  private readonly signals = new Map<
    string,
    { readonly list: Signal<readonly unknown[]>; readonly read: () => unknown }
  >();
  /** The last list per kind, account and room: it keeps its reference while unchanged. */
  private readonly lists = new Map<
    string,
    { readonly fingerprint: string; readonly items: readonly unknown[] }
  >();

  // Reads are reactive through the store; the lease keeps the session lifetime's health
  // facts, and its reconcile rereads every held list, so a failing read fails the lease.
  private readonly projection = projectActiveAccount<void>({
    id: 'room-administration.members',
    subscribe: () => concat(of(undefined), NEVER),
    rebuild: () => {
      for (const { read } of this.signals.values()) read();
    },
    reset: () => this.lists.clear(),
  });

  /** Cold membership projection retained by the Room Administration session lifetime. */
  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /** Reconcile this retained projection again without releasing its lease. */
  retryProjection(): void {
    this.projection.invalidate();
  }

  /** A memoized signal for one Room's joined members. */
  membersFor(roomId: string | null): Signal<readonly MemberSummary[]> {
    return this.memo('join', roomId, () => this.membersOf(roomId));
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
    const accountId = this.session.activeAccountId();
    return roomId && accountId
      ? this.summaries({ accountId, roomId }, 'join')
      : EMPTY_MEMBERS;
  }

  /** Read one settings roster from its immutable opening Account. */
  snapshot(target: RoomSettingsTarget): RoomMembersSnapshot {
    const live = this.session.status(target.accountId) !== null;
    const room = live ? this.store.room(target.accountId, target.roomId) : null;
    const availability: RoomMembersAvailability = !live
      ? 'account-unavailable'
      : room?.ownMembership !== 'join'
        ? 'room-unavailable'
        : 'available';
    const available = availability === 'available';
    return {
      target,
      availability,
      unavailableReason:
        availability === 'account-unavailable'
          ? 'This account is no longer available. The member list remains attached to this account.'
          : availability === 'room-unavailable'
            ? 'This room is no longer joined for this account.'
            : null,
      members: available ? this.summaries(target, 'join') : EMPTY_MEMBERS,
      banned: available ? this.bans(target) : EMPTY_BANS,
      invited: available ? this.summaries(target, 'invite') : EMPTY_MEMBERS,
      knocking: available ? this.knocks(target) : EMPTY_KNOCKS,
    };
  }

  /**
   * Observe one exact settings target: its snapshot at once, then after each change of
   * that Account's room, members or session.
   */
  observe(target: RoomSettingsTarget): Observable<RoomMembersSnapshot> {
    return defer(() => {
      const current = computed(() => this.snapshot(target));
      return toObservable(current, { injector: this.injector }).pipe(
        startWith(untracked(current)),
        distinctUntilChanged(),
      );
    });
  }

  /** A memoized signal for one Room's invited (not yet joined) members. */
  invitedFor(roomId: string | null): Signal<readonly MemberSummary[]> {
    return this.memo('invite', roomId, () => this.invitedMembersOf(roomId));
  }

  /** One authoritative snapshot of a Room's invited members. */
  invitedMembersOf(roomId: string | null): readonly MemberSummary[] {
    const accountId = this.session.activeAccountId();
    return roomId && accountId
      ? this.summaries({ accountId, roomId }, 'invite')
      : EMPTY_MEMBERS;
  }

  /** A memoized signal for one Room's banned members. */
  bannedFor(roomId: string | null): Signal<readonly BannedMember[]> {
    return this.memo('ban', roomId, () => this.bannedMembersOf(roomId));
  }

  /** Banned members with explicit current, stale, or unavailable authority. */
  bannedView(
    roomId: string | null,
  ): RoomAdministrationView<readonly BannedMember[]> {
    return this.projectionState.view('bans', roomId, this.bannedFor(roomId)());
  }

  /** One authoritative snapshot of a Room's banned members. */
  bannedMembersOf(roomId: string | null): readonly BannedMember[] {
    const accountId = this.session.activeAccountId();
    return roomId && accountId ? this.bans({ accountId, roomId }) : EMPTY_BANS;
  }

  /** A memoized signal for one Room's requests to join. */
  knockingFor(roomId: string | null): Signal<readonly KnockRequest[]> {
    return this.memo('knock', roomId, () => this.knockingMembersOf(roomId));
  }

  /** One authoritative snapshot of a Room's requests to join. */
  knockingMembersOf(roomId: string | null): readonly KnockRequest[] {
    const accountId = this.session.activeAccountId();
    return roomId && accountId
      ? this.knocks({ accountId, roomId })
      : EMPTY_KNOCKS;
  }

  private memo<T>(
    kind: ListKind,
    roomId: string | null,
    read: () => readonly T[],
  ): Signal<readonly T[]> {
    const key = `${kind}\u001f${roomId ?? ''}`;
    let entry = this.signals.get(key);
    if (!entry) {
      entry = { list: computed(read), read };
      this.signals.set(key, entry);
    }
    return entry.list as Signal<readonly T[]>;
  }

  private summaries(
    target: RoomSettingsTarget,
    membership: 'join' | 'invite',
  ): readonly MemberSummary[] {
    const creatorId =
      this.store.room(target.accountId, target.roomId)?.creators[0]?.userId ??
      null;
    return this.list(target, membership, (member) => ({
      userId: member.userId,
      roomDisplayName: member.displayName,
      roomInitial: initialOf(member.displayName),
      roomAvatarMxc: member.avatarMxc,
      powerLevel: powerValue(member.power),
      isCreator: member.userId === creatorId,
    }));
  }

  private bans(target: RoomSettingsTarget): readonly BannedMember[] {
    return this.list(target, 'ban', (member) => ({
      userId: member.userId,
      roomDisplayName: member.displayName,
      reason: member.reason,
    }));
  }

  private knocks(target: RoomSettingsTarget): readonly KnockRequest[] {
    return this.list(target, 'knock', (member) => ({
      userId: member.userId,
      roomDisplayName: member.displayName,
      roomInitial: initialOf(member.displayName),
      roomAvatarMxc: member.avatarMxc,
      reason: member.reason,
    }));
  }

  /** The members with `membership`, sorted by name; the same list while nothing changed. */
  private list<T extends { readonly roomDisplayName: string }>(
    { accountId, roomId }: RoomSettingsTarget,
    membership: Membership,
    project: (member: RoomMemberInfo) => T,
  ): readonly T[] {
    const items = (this.store.members(accountId, roomId)?.members ?? [])
      .filter((member) => member.membership === membership)
      .map(project);
    // `Infinity` prints as null; power is never null otherwise.
    const fingerprint = JSON.stringify(items);
    const key = `${membership}\u001f${accountId}\u001f${roomId}`;
    const cached = this.lists.get(key);
    if (cached?.fingerprint === fingerprint)
      return cached.items as readonly T[];
    items.sort((a, b) =>
      this.collator.compare(a.roomDisplayName, b.roomDisplayName),
    );
    this.lists.set(key, { fingerprint, items });
    return items;
  }
}
