import {
  Injectable,
  Injector,
  type Signal,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { NEVER, Observable, concat, defer, map, of, throwError } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import type { RoomInfo } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { RoomListStore } from './room-list-store';
import { initialOf } from './room-projection';
import { unwrapOwned } from './unwrap-owned';

/** A room we have been invited to but not yet joined (shown in the Invites group). */
export interface PendingInvite {
  roomId: string;
  /** The signed-in account this invite belongs to — exact even across selected Accounts. */
  accountId: string;
  /** Room (or inviter, for an unnamed DM) display name. */
  name: string;
  /** Uppercased first character (sans sigil), for the avatar initials fallback. */
  initial: string;
  /** Raw `mxc://` room avatar; the avatar component resolves it (authed). */
  avatarMxc: string | null;
  /** Display name of whoever invited us (best-effort), for the subtitle. */
  inviterName: string;
  /** The inviter's user ID, or '' when the invite event names nobody. */
  inviterId: string;
  /** Whether the invited room is a Space (`type: m.space`) vs a normal room. */
  isSpace: boolean;
  /** Whether the invite is to a direct message (`is_direct` on our member event). */
  isDirect: boolean;
}

/**
 * Read model over the active Account's room list for incoming invites (rooms and spaces whose
 * membership is `invite`); the joined-room and space services exclude them.
 *
 * Accept joins and Decline leaves; the result reaches the read model and the joined lists
 * through {@link RoomListStore}, with no manual signal patching.
 */
@Injectable({ providedIn: 'root' })
export class InvitesService {
  private readonly engine = inject(ROOM_LIST_ENGINE);
  private readonly store = inject(RoomListStore);
  private readonly session = inject(SessionStateService);
  private readonly injector = inject(Injector);

  /** Rooms/spaces we have been invited to; live as the client syncs. */
  readonly pendingInvites: Signal<PendingInvite[]> = computed(() => {
    const accountId = this.session.activeAccountId();
    if (!accountId) return [];
    return this.store
      .rooms(accountId)()
      .filter((info) => info.membership === 'invite')
      .map((info) => pendingInviteOf(accountId, info))
      .sort((a, b) => a.name.localeCompare(b.name));
  });

  /**
   * Retained by the Room Library session lifetime. The store keeps each live Account's room
   * list itself, so this only acknowledges at once.
   */
  runProjection(): Observable<void> {
    return concat(of(undefined), NEVER);
  }

  /** Accept an invite by joining the room/space, on the account it was sent to. Cold. */
  acceptInvite(roomId: string, accountId?: string): Observable<void> {
    return defer(() => {
      const owner = this.owning(accountId);
      if (!owner) {
        return throwError(() => new Error('Not signed in.'));
      }
      return this.engine.join(owner, roomId, []).pipe(
        unwrapOwned(),
        map(() => void 0),
      );
    });
  }

  /** Decline an invite by leaving the invited room/space, on its own account. Cold. */
  declineInvite(roomId: string, accountId?: string): Observable<void> {
    return defer(() => {
      const owner = this.owning(accountId);
      if (!owner) {
        return throwError(() => new Error('Not signed in.'));
      }
      return this.engine.leave(owner, roomId).pipe(
        unwrapOwned(),
        map(() => void 0),
      );
    });
  }

  /**
   * Decline only if the invite is still pending on `accountId`: re-reads its membership just
   * before leaving, so an invite accepted on another device is never left as a joined room.
   * Resolves 'joined' then, and 'declined' when the invite is already gone. Cold.
   */
  declineIfInvited(
    roomId: string,
    accountId: string,
  ): Observable<'declined' | 'joined'> {
    return defer(() => {
      if (!this.isLive(accountId)) {
        return throwError(() => new Error('Not signed in.'));
      }
      const membership = this.store.room(accountId, roomId)?.membership;
      if (membership === 'join') return of('joined' as const);
      if (membership !== 'invite') return of('declined' as const);
      return this.engine.leave(accountId, roomId).pipe(
        unwrapOwned(),
        map(() => 'declined' as const),
      );
    });
  }

  /** Emits once, then completes, when `accountId`'s invite to `roomId` stops pending. */
  inviteSettled(roomId: string, accountId: string): Observable<void> {
    return new Observable<void>((subscriber) => {
      // An effect reads the current row on every run, so no change between runs is missed.
      const watch = effect(
        () => {
          if (!this.isLive(accountId)) return;
          if (this.store.room(accountId, roomId)?.membership === 'invite')
            return;
          untracked(() => {
            subscriber.next();
            subscriber.complete();
          });
        },
        { injector: this.injector },
      );
      return () => watch.destroy();
    });
  }

  /** The named account, else the active one; null when that account is not live. */
  private owning(accountId?: string): string | null {
    const owner = accountId ?? this.session.activeAccountId();
    return owner && this.isLive(owner) ? owner : null;
  }

  private isLive(accountId: string): boolean {
    return this.session.accountIds().includes(accountId);
  }
}

function pendingInviteOf(accountId: string, info: RoomInfo): PendingInvite {
  return {
    roomId: info.roomId,
    accountId,
    name: info.displayName,
    initial: initialOf(info.displayName),
    avatarMxc: info.avatarMxc,
    inviterName: info.inviter?.displayName ?? 'Someone',
    inviterId: info.inviter?.userId ?? '',
    isSpace: info.isSpace,
    isDirect: info.inviter?.isDirect ?? false,
  };
}
