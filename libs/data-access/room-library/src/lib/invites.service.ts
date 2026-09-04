import { Injectable, inject, signal } from '@angular/core';
import {
  ClientEvent,
  RoomEvent,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { Observable, defer, from, map, throwError } from 'rxjs';
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
  /** Whether the invited room is a Space (`type: m.space`) vs a normal room. */
  isSpace: boolean;
  /** Whether the invite is to a direct message (`is_direct` on our member event). */
  isDirect: boolean;
}

/**
 * Read model over the synced `MatrixClient` for **incoming invites** — the rooms
 * (and spaces) where our membership is `invite`. A sibling to {@link RoomLibraryService}
 * (joined rooms) and {@link SpacesService} (joined spaces), all of which exclude
 * invited rooms; this surfaces them so the UI can offer Accept / Decline.
 *
 * Mirrors the sibling read models: components never touch `matrix-js-sdk`, the
 * signal recomputes as the client syncs, and connection is keyed to the client
 * *instance* (a logout→login swaps in a fresh client) rather than a boolean.
 *
 * Accept ({@link acceptInvite}) joins and Decline ({@link declineInvite}) leaves;
 * the result lands in the read model — and in the joined rooms/spaces lists — through
 * the existing sync listeners (no manual signal patching).
 */
@Injectable({ providedIn: 'root' })
export class InvitesService {
  private readonly matrix = inject(MatrixClientService);

  private readonly _pendingInvites = signal<PendingInvite[]>([]);
  /** Rooms/spaces we have been invited to; live as the client syncs. */
  readonly pendingInvites = this._pendingInvites.asReadonly();

  /** The sync projection: client-keyed listeners, coalesced rebuilds, account switch. */
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
    // Coalescing is not cosmetic here: `ClientEvent.Room` fires once PER ROOM during
    // initial sync and refresh() walks every joined room (filter + map + a localeCompare
    // sort), so rebuilding per event was O(rooms²) on startup. refresh() writes the
    // `_pendingInvites` signal, which schedules change detection on its own.
    rebuild: () => this.refresh(),
    reset: () => this._pendingInvites.set([]),
  });

  /**
   * Attach sync listeners and do the first read. Idempotent per client (e.g. the
   * shell's `ngOnInit`); re-running after a re-login rewires onto the new client.
   */
  connect(): void {
    this.projection.connect();
  }

  /** Detach listeners from the current client and reset the read model. */
  disconnect(): void {
    this.projection.disconnect();
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
 * Project one invited {@link Room} into a {@link PendingInvite}, tagged with the account it
 * was sent to. Pure read — shared by {@link InvitesService} (active account) and the
 * selected-Account projector so both build identical rows.
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
    // A DM invite's stripped state carries the inviter's `m.room.member`, so it resolves
    // to their avatar the same way a joined DM does. `is_direct` has to be what decides:
    // stripped state holds only the inviter's and our own membership no matter how big
    // the room really is, so left to its own member-count heuristic the SDK would hand
    // back the inviter for every group-room and space invite too.
    avatarMxc: roomAvatarMxc(room, isDirect),
    inviterName: inviter?.name || inviterId || 'Someone',
    isSpace: room.isSpaceRoom(),
    isDirect,
  };
}

/** First visible character (sans leading `#`/`@`/`!`), uppercased, for fallbacks. */
function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}
