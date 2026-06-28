import { Injectable, inject, signal } from '@angular/core';
import {
  ClientEvent,
  RoomEvent,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { MatrixClientService } from './matrix-client.service';

/** State-event type that links a child room into a Space (`m.space.child`). */
const SPACE_CHILD_EVENT = 'm.space.child';

/** A Matrix Space (a room with `type: m.space`) shown as a pill in the server rail. */
export interface SpaceSummary {
  id: string;
  name: string;
  /** Uppercased first character (sans sigil), for the avatar initials fallback. */
  initial: string;
  /** Raw `mxc://` avatar; the avatar component resolves it to an authed blob URL. */
  avatarMxc: string | null;
  /**
   * This space's *joined* child room ids, ordered by the `m.space.child` `order`
   * field (lexicographic) then room name. Children we have not joined — and
   * removed/dangling child links — are dropped for this increment.
   */
  childRoomIds: string[];
}

/** Internal scratch shape used while sorting a space's children. */
interface ChildEntry {
  id: string;
  order: string;
  name: string;
}

/**
 * Read model over the synced `MatrixClient` for Matrix **Spaces** — the
 * Discord-style server rail. Exposes the user's joined spaces and, per space, the
 * ordered ids of its joined child rooms (so the room list can filter to a space).
 *
 * Mirrors {@link RoomsService}'s patterns: components never touch `matrix-js-sdk`
 * directly, signals recompute as the client syncs, and connection is keyed to the
 * client *instance* (a logout→login swaps in a fresh client) rather than a boolean.
 *
 * Creating/managing spaces (create, add/remove children, invites, nesting) is a
 * deferred follow-up; this service is read-only navigation/display.
 */
@Injectable({ providedIn: 'root' })
export class SpacesService {
  private readonly matrix = inject(MatrixClientService);

  /**
   * The client we currently have listeners on. The client is recreated on every
   * (re-)login, so connection is keyed to the instance, not a boolean — otherwise a
   * logout→login would leave the listeners on the discarded client and freeze this
   * read model.
   */
  private connectedClient: MatrixClient | null = null;

  private readonly _spaces = signal<SpaceSummary[]>([]);
  /** The user's joined spaces, sorted by name; live as the client syncs. */
  readonly spaces = this._spaces.asReadonly();

  /** Stable listener ref so {@link connect}/{@link disconnect} can add and remove it. */
  private readonly onChange = (): void => this.refresh();

  /**
   * State-event listener scoped to `m.space.child`: every state event flows through
   * here, so filter to the child links to avoid refreshing on unrelated state
   * (avatars, topics, membership of unrelated rooms, …).
   */
  private readonly onStateEvent = (event: MatrixEvent): void => {
    if (event.getType() === SPACE_CHILD_EVENT) {
      this.refresh();
    }
  };

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
    client.on(ClientEvent.Room, this.onChange);
    // A space (or child) being (re)named affects sort order and labels.
    client.on(RoomEvent.Name, this.onChange);
    // Joining/leaving a space or a child room changes what is shown.
    client.on(RoomEvent.MyMembership, this.onChange);
    // `m.space.child` add/remove/reorder arrives as a room state event.
    client.on(RoomStateEvent.Events, this.onStateEvent);
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
    client.off(RoomEvent.Name, this.onChange);
    client.off(RoomEvent.MyMembership, this.onChange);
    client.off(RoomStateEvent.Events, this.onStateEvent);
    this.connectedClient = null;
    this._spaces.set([]);
  }

  /**
   * Ordered joined child-room ids of a space, or `[]` for Home (`null`) / an
   * unknown space. Reads the {@link spaces} signal, so callers that read this from
   * within a `computed`/effect stay reactive to live updates.
   */
  childRoomIds(spaceId: string | null): string[] {
    if (!spaceId) {
      return [];
    }
    return this.spaces().find((s) => s.id === spaceId)?.childRoomIds ?? [];
  }

  private refresh(): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    this._spaces.set(
      client
        .getRooms()
        .filter((r) => r.isSpaceRoom() && r.getMyMembership() === 'join')
        .map((r) => this.toSpace(client, r))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  private toSpace(client: MatrixClient, room: Room): SpaceSummary {
    const name = room.name || room.roomId;
    return {
      id: room.roomId,
      name,
      initial: initialOf(name),
      avatarMxc: room.getMxcAvatarUrl(),
      childRoomIds: this.orderedChildIds(client, room),
    };
  }

  /**
   * Resolve a space's `m.space.child` links to the ids of its *joined* child rooms,
   * ordered by the child's `order` field then its name.
   *
   * Per the spec a valid child carries a non-empty `via` array; a child link with
   * empty content (no `via`) is a removed/tombstoned link and is skipped. Children
   * whose room we have not joined are dropped for this increment (not-yet-joined
   * children are a deferred follow-up).
   */
  private orderedChildIds(client: MatrixClient, space: Room): string[] {
    const children = space.currentState
      .getStateEvents(SPACE_CHILD_EVENT)
      .map((event): ChildEntry | null => {
        const childId = event.getStateKey();
        const content = event.getContent();
        const via = content['via'];
        if (!childId || !Array.isArray(via) || via.length === 0) {
          return null; // removed / invalid child link
        }
        const child = client.getRoom(childId);
        if (!child || child.getMyMembership() !== 'join') {
          return null; // only joined children for this increment
        }
        const order =
          typeof content['order'] === 'string' ? content['order'] : '';
        return { id: childId, order, name: child.name || childId };
      })
      .filter((entry): entry is ChildEntry => entry !== null);

    children.sort(
      (a, b) => a.order.localeCompare(b.order) || a.name.localeCompare(b.name),
    );
    return children.map((entry) => entry.id);
  }
}

/** First visible character (sans leading `#`/`@`/`!`), uppercased, for fallbacks. */
function initialOf(name: string): string {
  const stripped = name.replace(/^[#@!]+/, '').trim();
  return (stripped[0] ?? '?').toUpperCase();
}
