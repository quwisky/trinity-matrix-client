import { Injectable, inject, signal } from '@angular/core';
import {
  ClientEvent,
  KnownMembership,
  RoomEvent,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { Observable, defer, from, map, of, throwError } from 'rxjs';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import { roomAvatarMxc } from '@trinity/util/matrix';

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
 * Read model over the synced `MatrixClient` for incoming invites (rooms and spaces whose
 * membership is `invite`); the joined-room and space services exclude them.
 *
 * Accept joins and Decline leaves; the result reaches the read model and the joined lists
 * through the sync listeners, with no manual signal patching.
 */
@Injectable({ providedIn: 'root' })
export class InvitesService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _pendingInvites = signal<PendingInvite[]>([]);
  /** Rooms/spaces we have been invited to; live as the client syncs. */
  readonly pendingInvites = this._pendingInvites.asReadonly();

  private readonly projection = projectFromClient({
    id: 'invites.active-account',
    matrix: this.matrix,
    events: [
      ClientEvent.Sync,
      // A fresh invite arrives as a new Room; accepting/declining flips MyMembership.
      ClientEvent.Room,
      RoomEvent.MyMembership,
      // The invited room being (re)named changes its label.
      RoomEvent.Name,
    ],
    // Coalesced: `ClientEvent.Room` fires once per room during initial sync and refresh() walks
    // every joined room, so per-event rebuilds would be O(rooms²) on startup.
    rebuild: () => this.refresh(),
    reset: () => this._pendingInvites.set([]),
  });

  /** Cold active-Account projection retained by the Room Library session lifetime. */
  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /** Accept an invite by joining the room/space, on the account it was sent to. Cold. */
  acceptInvite(roomId: string, accountId?: string): Observable<void> {
    return defer(() => {
      const client = this.clientOwning(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(client.joinRoom(roomId)).pipe(map(() => void 0));
    });
  }

  /** Decline an invite by leaving the invited room/space, on its own account. Cold. */
  declineInvite(roomId: string, accountId?: string): Observable<void> {
    return defer(() => {
      const client = this.clientOwning(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(client.leave(roomId)).pipe(map(() => void 0));
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
      const client = this.matrix.clientFor(accountId);
      if (!client) {
        return throwError(() => new Error('Not signed in.'));
      }
      const membership = client.getRoom(roomId)?.getMyMembership();
      if (membership === KnownMembership.Join) return of('joined' as const);
      if (membership !== KnownMembership.Invite) return of('declined' as const);
      return from(client.leave(roomId)).pipe(map(() => 'declined' as const));
    });
  }

  /** Emits once, then completes, when `accountId`'s invite to `roomId` stops pending. */
  inviteSettled(roomId: string, accountId: string): Observable<void> {
    return new Observable<void>((subscriber) => {
      const client = this.matrix.clientFor(accountId);
      if (!client) return;
      const onMembership = (room: Room): void => {
        if (
          room.roomId === roomId &&
          room.getMyMembership() !== KnownMembership.Invite
        ) {
          subscriber.next();
          subscriber.complete();
        }
      };
      client.on(RoomEvent.MyMembership, onMembership);
      return () => client.off(RoomEvent.MyMembership, onMembership);
    });
  }

  /** The client owning an invite: the named account's, else the active one. */
  private clientOwning(accountId?: string): MatrixClient | null {
    if (accountId) {
      return this.matrix.clientFor(accountId);
    }
    return this.matrix.isInitialized ? this.matrix.instance : null;
  }

  private refresh(): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    this._pendingInvites.set(
      client
        .getRooms()
        .filter((r) => r.getMyMembership() === 'invite')
        .map((r) => this.toInvite(client, r, this.matrix.activeUserId() ?? ''))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  private toInvite(
    client: MatrixClient,
    room: Room,
    accountId: string,
  ): PendingInvite {
    return buildInvite(client, room, accountId);
  }
}

/**
 * Project one invited {@link Room} into a {@link PendingInvite}. Shared by
 * {@link InvitesService} (active account) and the selected-Account projector so both build
 * identical rows.
 */
export function buildInvite(
  client: MatrixClient,
  room: Room,
  accountId: string,
): PendingInvite {
  const name = room.name || room.roomId;
  // Our own `m.room.member` invite event carries the inviter (its sender) and,
  // for a DM, the `is_direct` flag the inviter set.
  const myMemberEvent = client.getUserId()
    ? room.getMember(client.getUserId() as string)?.events?.member
    : undefined;
  const inviterId = myMemberEvent?.getSender() ?? '';
  const inviter = inviterId ? room.getMember(inviterId) : null;
  const isDirect = myMemberEvent?.getContent()?.['is_direct'] === true;
  return {
    roomId: room.roomId,
    accountId,
    name,
    initial: initialOf(name),
    // A DM invite's stripped state carries the inviter's `m.room.member`, so it resolves to
    // their avatar like a joined DM. `is_direct` must decide: stripped state holds only the
    // inviter's and our membership whatever the room size, so the SDK's member-count heuristic
    // would return the inviter for every group-room and space invite.
    avatarMxc: roomAvatarMxc(room, isDirect),
    inviterName: inviter?.name || inviterId || 'Someone',
    inviterId,
    isSpace: room.isSpaceRoom(),
    isDirect,
  };
}

/** First visible character (sans leading `#`/`@`/`!`), uppercased, for fallbacks. */
function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}
