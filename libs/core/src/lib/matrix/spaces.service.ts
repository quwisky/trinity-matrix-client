import { Injectable, inject, signal } from '@angular/core';
import {
  ClientEvent,
  EventType,
  Preset,
  RoomEvent,
  RoomStateEvent,
  RoomType,
  Visibility,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { Observable, defer, from, map, switchMap } from 'rxjs';
import { MatrixClientService } from './matrix-client.service';

/** State-event type that links a child room into a Space (`m.space.child`). */
const SPACE_CHILD_EVENT = 'm.space.child';

/** Megolm group-encryption algorithm enabled on every room we create (E2EE-first). */
const MEGOLM_ALGORITHM = 'm.megolm.v1.aes-sha2';

/** Fields a {@link SpacesService.createSpace} call accepts. */
export interface CreateSpaceOptions {
  name: string;
  topic?: string;
  /** Public (discoverable + publicly joinable) vs the default invite-only space. */
  isPublic?: boolean;
}

/** Fields a {@link SpacesService.createRoomInSpace} call accepts. */
export interface CreateRoomInSpaceOptions {
  name: string;
  topic?: string;
  /** Public (discoverable + publicly joinable) vs the default invite-only room. */
  isPublic?: boolean;
}

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
 * Writes are limited to the first management increment — {@link createSpace},
 * {@link createRoomInSpace}, and {@link leaveSpace}. Their results land in the read
 * model through the existing sync listeners (no manual signal patching). Invites,
 * joining public/invited spaces, surfacing not-yet-joined children, nesting, and
 * reordering remain deferred follow-ups.
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

  /**
   * Create a new Space (a room with `type: m.space`) and resolve its room id. The
   * pill appears in the rail once the client syncs the new room (the existing
   * listeners pick it up); callers select it by id. Cold: the request runs on
   * subscribe.
   */
  createSpace(options: CreateSpaceOptions): Observable<string> {
    return defer(() => {
      const client = this.matrix.instance;
      return from(
        client.createRoom({
          // `creation_content.type` is what marks the room as a Space; the SDK
          // types `creation_content` loosely (`object`), so the field is set here.
          creation_content: { type: RoomType.Space },
          name: options.name.trim(),
          ...(options.topic?.trim() ? { topic: options.topic.trim() } : {}),
          ...this.visibilityOpts(options.isPublic),
        }),
      ).pipe(map((res) => res.room_id));
    });
  }

  /**
   * Create a normal (E2EE) room and link it into `spaceId` as a child, resolving the
   * new room id. The room is created with `m.room.encryption` (Megolm) in its
   * `initial_state` so it is encrypted from the first event, then two-way linked:
   * `m.space.child` on the space (pointing at the child) and `m.space.parent` on the
   * child (pointing back, canonical). Both links carry our homeserver in `via` so a
   * remote server can route to the room. Cold: the work runs on subscribe.
   */
  createRoomInSpace(
    spaceId: string,
    options: CreateRoomInSpaceOptions,
  ): Observable<string> {
    return defer(() => {
      const client = this.matrix.instance;
      const via = serverNameOf(client.getUserId());
      return from(
        client.createRoom({
          name: options.name.trim(),
          ...(options.topic?.trim() ? { topic: options.topic.trim() } : {}),
          ...this.visibilityOpts(options.isPublic),
          // E2EE-first: enable Megolm before the first message so the room is never
          // briefly unencrypted. `initial_state` content is loosely typed (`IContent`).
          initial_state: [
            {
              type: EventType.RoomEncryption,
              state_key: '',
              content: { algorithm: MEGOLM_ALGORITHM },
            },
          ],
        }),
      ).pipe(
        switchMap((res) => {
          const childId = res.room_id;
          // Link the child into the space, then point the child back at the space.
          return from(
            client.sendStateEvent(
              spaceId,
              EventType.SpaceChild,
              { via: [via], suggested: true },
              childId,
            ),
          ).pipe(
            switchMap(() =>
              from(
                client.sendStateEvent(
                  childId,
                  EventType.SpaceParent,
                  { via: [via], canonical: true },
                  spaceId,
                ),
              ),
            ),
            map(() => childId),
          );
        }),
      );
    });
  }

  /**
   * Leave a space room. Only the space itself is left — its child rooms stay joined
   * (leaving the children too is a deferred follow-up). The rail drops the pill once
   * the membership change syncs back through the existing listeners.
   */
  leaveSpace(spaceId: string): Observable<void> {
    return defer(() => from(this.matrix.instance.leave(spaceId))).pipe(
      map(() => void 0),
    );
  }

  /** Shared visibility/preset for create calls: public-discoverable vs invite-only. */
  private visibilityOpts(isPublic?: boolean): {
    visibility: Visibility;
    preset: Preset;
  } {
    return isPublic
      ? { visibility: Visibility.Public, preset: Preset.PublicChat }
      : { visibility: Visibility.Private, preset: Preset.PrivateChat };
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

/**
 * Our homeserver name, derived from the user id (`@user:server.tld` → `server.tld`)
 * for the `via` of `m.space.child`/`m.space.parent` links. Empty when there is no
 * server part — the homeserver will still accept the link, just without routing help.
 */
function serverNameOf(userId: string | null): string {
  const colon = userId?.indexOf(':') ?? -1;
  return colon >= 0 ? userId!.slice(colon + 1) : '';
}
