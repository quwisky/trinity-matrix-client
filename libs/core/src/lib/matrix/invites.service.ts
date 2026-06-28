import { Injectable, inject, signal } from '@angular/core';
import {
  ClientEvent,
  RoomEvent,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { Observable, defer, from, map } from 'rxjs';
import { MatrixClientService } from './matrix-client.service';

/** A room we have been invited to but not yet joined (shown in the Invites group). */
export interface PendingInvite {
  roomId: string;
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
 * (and spaces) where our membership is `invite`. A sibling to {@link RoomsService}
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

  /**
   * The client we currently have listeners on. The client is recreated on every
   * (re-)login, so connection is keyed to the instance, not a boolean — otherwise a
   * logout→login would leave the listeners on the discarded client and freeze this
   * read model.
   */
  private connectedClient: MatrixClient | null = null;

  private readonly _pendingInvites = signal<PendingInvite[]>([]);
  /** Rooms/spaces we have been invited to; live as the client syncs. */
  readonly pendingInvites = this._pendingInvites.asReadonly();

  /** Stable listener ref so {@link connect}/{@link disconnect} can add and remove it. */
  private readonly onChange = (): void => this.refresh();

  /**
   * Attach sync listeners and do the first read. Idempotent per client (e.g. the
   * shell's `ngOnInit`); re-running after a re-login rewires onto the new client.
   */
  connect(): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    if (this.connectedClient === client) {
      return; // already wired to this client
    }
    this.disconnect(); // drop listeners from any previous client
    this.connectedClient = client;
    client.on(ClientEvent.Sync, this.onChange);
    // A fresh invite arrives as a new Room; accepting/declining flips MyMembership.
    client.on(ClientEvent.Room, this.onChange);
    client.on(RoomEvent.MyMembership, this.onChange);
    // The invited room being (re)named changes its label.
    client.on(RoomEvent.Name, this.onChange);
    this.refresh();
  }

  /** Detach listeners from the current client and reset the read model. */
  disconnect(): void {
    const client = this.connectedClient;
    if (!client) {
      return;
    }
    client.off(ClientEvent.Sync, this.onChange);
    client.off(ClientEvent.Room, this.onChange);
    client.off(RoomEvent.MyMembership, this.onChange);
    client.off(RoomEvent.Name, this.onChange);
    this.connectedClient = null;
    this._pendingInvites.set([]);
  }

  /** Accept an invite by joining the room/space. Cold: runs on subscribe. */
  acceptInvite(roomId: string): Observable<void> {
    return defer(() => from(this.matrix.instance.joinRoom(roomId))).pipe(
      map(() => void 0),
    );
  }

  /** Decline an invite by leaving the invited room/space. Cold: runs on subscribe. */
  declineInvite(roomId: string): Observable<void> {
    return defer(() => from(this.matrix.instance.leave(roomId))).pipe(
      map(() => void 0),
    );
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
        .map((r) => this.toInvite(client, r))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  private toInvite(client: MatrixClient, room: Room): PendingInvite {
    const name = room.name || room.roomId;
    // Our own `m.room.member` invite event carries the inviter (its sender) and,
    // for a DM, the `is_direct` flag the inviter set.
    const myMemberEvent = client.getUserId()
      ? room.getMember(client.getUserId() as string)?.events?.member
      : undefined;
    const inviterId = myMemberEvent?.getSender() ?? '';
    const inviter = inviterId ? room.getMember(inviterId) : null;
    return {
      roomId: room.roomId,
      name,
      initial: initialOf(name),
      avatarMxc: room.getMxcAvatarUrl(),
      inviterName: inviter?.name || inviterId || 'Someone',
      isSpace: room.isSpaceRoom(),
      isDirect: myMemberEvent?.getContent()?.['is_direct'] === true,
    };
  }
}

/** First visible character (sans leading `#`/`@`/`!`), uppercased, for fallbacks. */
function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}
