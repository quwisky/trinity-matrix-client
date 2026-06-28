import { Injectable, inject, signal } from '@angular/core';
import {
  ClientEvent,
  NotificationCountType,
  RoomEvent,
  type MatrixClient,
  type Room,
  type RoomMember,
} from 'matrix-js-sdk';
import { MatrixClientService } from './matrix-client.service';

/** A joinable room shown in the channel sidebar. */
export interface RoomSummary {
  id: string;
  name: string;
  initial: string;
  avatarMxc: string | null;
  topic: string;
  memberCount: number;
  /** Whether the room has encryption enabled (`m.room.encryption`). */
  encrypted: boolean;
  /** Total unread notifications (drives the unread highlight). */
  unreadCount: number;
  /** Unread mentions/highlights (drives the red badge). */
  highlightCount: number;
  /** Convenience flag: there are unread notifications. */
  hasUnread: boolean;
  /** Last-activity timestamp (ms), used to order the list by recency. */
  activityTs: number;
}

/** A joined member shown in the member list. */
export interface MemberSummary {
  userId: string;
  name: string;
  initial: string;
  avatarMxc: string | null;
}

/**
 * Read model over the synced `MatrixClient`: exposes joined rooms and members as
 * plain view models (components never touch `matrix-js-sdk` directly). Signals are
 * recomputed as the client syncs; `connect()` wires the listeners.
 *
 * Spaces (the server rail) are a separate read model — see {@link SpacesService}.
 * Space rooms are excluded from {@link rooms} so they never appear as channels.
 */
@Injectable({ providedIn: 'root' })
export class RoomsService {
  private readonly matrix = inject(MatrixClientService);

  /**
   * The client we currently have listeners on. The client is recreated on every
   * (re-)login, so connection is keyed to the instance, not a boolean — otherwise
   * a logout→login would leave the listeners on the discarded client and the read
   * model frozen.
   */
  private connectedClient: MatrixClient | null = null;

  /** Stable listener ref so {@link connect}/{@link disconnect} can add and remove it. */
  private readonly onClientEvent = (): void => this.refresh();

  private readonly _rooms = signal<RoomSummary[]>([]);
  readonly rooms = this._rooms.asReadonly();

  /** Bumped on every refresh so member queries can stay reactive. */
  private readonly _revision = signal(0);
  readonly revision = this._revision.asReadonly();

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
    client.on(ClientEvent.Sync, this.onClientEvent);
    client.on(ClientEvent.Room, this.onClientEvent);
    client.on(RoomEvent.Name, this.onClientEvent);
    client.on(RoomEvent.MyMembership, this.onClientEvent);
    // Keep unread badges live: new-message increments arrive via Sync above;
    // Receipt fires when a room is read and its unread count clears.
    client.on(RoomEvent.Receipt, this.onClientEvent);
    this.refresh();
  }

  /** Detach listeners from the current client and reset the read model. */
  disconnect(): void {
    const client = this.connectedClient;
    if (!client) {
      return;
    }
    client.off(ClientEvent.Sync, this.onClientEvent);
    client.off(ClientEvent.Room, this.onClientEvent);
    client.off(RoomEvent.Name, this.onClientEvent);
    client.off(RoomEvent.MyMembership, this.onClientEvent);
    client.off(RoomEvent.Receipt, this.onClientEvent);
    this.connectedClient = null;
    this._rooms.set([]);
  }

  /** Joined members of a room (empty if the room is unknown). */
  membersOf(roomId: string | null): MemberSummary[] {
    if (!roomId || !this.matrix.isInitialized) {
      return [];
    }
    const room = this.matrix.instance.getRoom(roomId);
    if (!room) {
      return [];
    }
    return room
      .getJoinedMembers()
      .map((m) => this.toMember(m))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private refresh(): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    const all = client.getRooms();

    this._rooms.set(
      all
        // Spaces are rendered in the server rail, not as channels in the room list.
        .filter((r) => !r.isSpaceRoom() && r.getMyMembership() === 'join')
        .map((r) => this.toRoom(r))
        // Most recently active first; fall back to name for quiet rooms.
        .sort(
          (a, b) => b.activityTs - a.activityTs || a.name.localeCompare(b.name),
        ),
    );
    this._revision.update((n) => n + 1);
  }

  private toRoom(room: Room): RoomSummary {
    const name = room.name || room.roomId;
    const topicEvent = room.currentState.getStateEvents('m.room.topic', '');
    const unreadCount = room.getUnreadNotificationCount(
      NotificationCountType.Total,
    );
    const highlightCount = room.getUnreadNotificationCount(
      NotificationCountType.Highlight,
    );
    return {
      id: room.roomId,
      name,
      initial: initialOf(name),
      avatarMxc: room.getMxcAvatarUrl(),
      topic: (topicEvent?.getContent()?.['topic'] as string) ?? '',
      memberCount: room.getJoinedMemberCount(),
      encrypted: room.hasEncryptionStateEvent(),
      unreadCount,
      highlightCount,
      hasUnread: unreadCount > 0,
      activityTs: room.getLastActiveTimestamp(),
    };
  }

  private toMember(member: RoomMember): MemberSummary {
    const name = member.name || member.userId;
    return {
      userId: member.userId,
      name,
      initial: initialOf(name),
      avatarMxc: member.getMxcAvatarUrl() ?? null,
    };
  }
}

/** First visible character (sans leading `#`/`@`), uppercased, for fallback avatars. */
function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}
