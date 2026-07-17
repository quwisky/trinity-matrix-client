import { Injectable, NgZone, computed, inject, signal } from '@angular/core';
import {
  ClientEvent,
  EventType,
  RoomEvent,
  RoomStateEvent,
  RoomType,
  type HierarchyRoom,
  type MatrixClient,
  type MatrixEvent,
  type Room,
} from 'matrix-js-sdk';
import { Observable, Subscription, defer, from, map, switchMap } from 'rxjs';
import {
  MatrixClientService,
  reprojectOnAccountSwitch,
} from '@trinity/data-access-matrix-client';
import {
  liveRoomState,
  roomEncryptionInitialState,
  visibilityOptions,
} from '@trinity/util-matrix';

/** Children fetched per `getRoomHierarchy` page. */
const HIERARCHY_LIMIT = 100;

/**
 * Safety cap on hierarchy pages we follow via `next_batch`. A space with more
 * than `HIERARCHY_LIMIT * HIERARCHY_MAX_PAGES` joinable children is well beyond
 * what the rail shows usefully; stop there so a pathological/looping hierarchy
 * can't fan out unbounded requests. 5 pages ≈ 500 children.
 */
const HIERARCHY_MAX_PAGES = 5;

/** State-event type that links a child room into a Space (`m.space.child`). */
const SPACE_CHILD_EVENT = 'm.space.child';

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
 * A room (or sub-space) linked into a space via `m.space.child`, as projected from
 * the server's space hierarchy (`getRoomHierarchy`, MSC2946). Unlike
 * {@link SpaceSummary.childRoomIds} — which only sees *joined* children — this
 * surfaces the space's *full* child set, including rooms we have not joined yet, so
 * the UI can offer a Join action.
 */
export interface SpaceChildRoom {
  roomId: string;
  name: string;
  /** Uppercased first character (sans sigil), for the avatar initials fallback. */
  initial: string;
  /** Child room topic, when the hierarchy summary carries one. */
  topic?: string;
  /** Raw `mxc://` avatar; the avatar component resolves it (authed). */
  avatarMxc: string | null;
  /** Joined-member count from the hierarchy summary (`num_joined_members`). */
  memberCount: number;
  /**
   * The child's join rule (`public`/`knock`/…). The hierarchy summary only reports
   * it for publicly-previewable rooms, so it is `''` when the server omits it.
   */
  joinRule: string;
  /** Whether the `m.space.child` link flags this child as `suggested`. */
  suggested: boolean;
  /** Whether the child is itself a Space (`room_type: m.space`) vs a normal room. */
  isSpace: boolean;
  /** Servers to route a join through (the `m.space.child` `via`). */
  via: string[];
  /** Whether we are currently joined to this child (live, recomputed on sync). */
  joined: boolean;
}

/** Everything about a child except its (live-derived) {@link SpaceChildRoom.joined}. */
type SpaceChildBase = Omit<SpaceChildRoom, 'joined'>;

/**
 * Read model over the synced `MatrixClient` for Matrix **Spaces** — the
 * Discord-style server rail. Exposes the user's joined spaces and, per space, the
 * ordered ids of its joined child rooms (so the room list can filter to a space).
 *
 * Mirrors {@link RoomsService}'s patterns: components never touch `matrix-js-sdk`
 * directly, signals recompute as the client syncs, and connection is keyed to the
 * client *instance* (a logout→login swaps in a fresh client) rather than a boolean.
 *
 * Beyond the joined view this also fetches a space's *full* child set on demand via
 * {@link openSpace} (`getRoomHierarchy`, MSC2946) so the UI can list — and
 * {@link joinRoom} — children we have not joined yet, and {@link removeRoomFromSpace}
 * unlinks a child. The hierarchy is a network read, so unlike the sync-driven joined
 * model it is patched into signals from the fetch result (and the per-child `joined`
 * flag is recomputed live against the synced client).
 *
 * Writes: {@link createSpace}, {@link createRoomInSpace}, {@link leaveSpace},
 * {@link joinRoom}, {@link removeRoomFromSpace}. Membership results land in the joined
 * read model through the existing sync listeners. Public-space directory discovery,
 * nested-rail navigation, and child reordering remain deferred follow-ups.
 */
@Injectable({ providedIn: 'root' })
export class SpacesService {
  private readonly matrix = inject(MatrixClientService);
  private readonly zone = inject(NgZone);

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

  /**
   * Ticks on every sync/membership refresh. The hierarchy projection reads it so the
   * per-child `joined` flag re-derives live (e.g. a not-joined child flips to joined
   * the moment its membership syncs back), without re-fetching the hierarchy.
   */
  private readonly _revision = signal(0);

  /** Which space's hierarchy is currently loaded ({@link openSpace}); null on Home. */
  private readonly _openSpaceId = signal<string | null>(null);
  /** Projected children of the open space, minus the live `joined` flag. */
  private readonly _childrenBase = signal<SpaceChildBase[]>([]);
  private readonly _childrenLoading = signal(false);
  private readonly _childrenError = signal<string | null>(null);

  /** Whether the open space's hierarchy fetch is in flight. */
  readonly childrenLoading = this._childrenLoading.asReadonly();
  /**
   * The open space's hierarchy fetch error message, or null. Set when a homeserver
   * does not support `/hierarchy` or the request otherwise fails.
   */
  readonly childrenError = this._childrenError.asReadonly();

  /** In-flight hierarchy subscription, cancelled when the open space changes. */
  private hierarchySub: Subscription | null = null;

  /**
   * The open space's full child set, with each child's `joined` flag derived live
   * against the synced client (so a join/leave is reflected without a re-fetch).
   */
  readonly openSpaceChildren = computed<SpaceChildRoom[]>(() => {
    this._revision(); // re-derive `joined` on sync/membership changes
    const client = this.matrix.isInitialized ? this.matrix.instance : null;
    return this._childrenBase().map((base) => ({
      ...base,
      joined: client?.getRoom(base.roomId)?.getMyMembership() === 'join',
    }));
  });

  /**
   * Open-space children we have *not* joined and that are normal rooms — the
   * "more channels" list the sidebar offers a Join button for.
   */
  readonly notJoinedRooms = computed<SpaceChildRoom[]>(() =>
    this.openSpaceChildren().filter((c) => !c.joined && !c.isSpace),
  );

  /**
   * Open-space children that are themselves Spaces (joined or not). Joined sub-spaces
   * already live in the rail; the sidebar surfaces them so they can be opened, and
   * offers a Join for the rest. (Full nested-rail navigation is deferred.)
   */
  readonly childSpaces = computed<SpaceChildRoom[]>(() =>
    this.openSpaceChildren().filter((c) => c.isSpace),
  );

  /**
   * Stable listener ref so {@link connect}/{@link disconnect} can add and remove it.
   * Coalesced ({@link scheduleRefresh}): a completed /sync fires a burst of
   * Sync/Room/Name/MyMembership events, and rebuilding + re-sorting the whole spaces
   * read model once per event is wasteful — collapse them into a single rebuild.
   */
  private readonly onChange = (): void => this.scheduleRefresh();

  /** Whether a coalesced refresh is already queued for this microtask turn. */
  private refreshScheduled = false;

  /**
   * State-event listener scoped to `m.space.child`: every state event flows through
   * here, so filter to the child links to avoid refreshing on unrelated state
   * (avatars, topics, membership of unrelated rooms, …). These are rare admin
   * actions (not a sync burst), so they refresh immediately rather than coalescing.
   */
  private readonly onStateEvent = (event: MatrixEvent): void => {
    if (event.getType() === SPACE_CHILD_EVENT) {
      // Via scheduleRefresh so this re-enters the zone (it fires outside it) and
      // coalesces with the sync burst that typically accompanies it.
      this.scheduleRefresh();
    }
  };

  constructor() {
    // On an account switch, re-project this service onto the newly-active account's
    // client — but only while it is already wired to one.
    reprojectOnAccountSwitch(
      this.matrix,
      () => this.connectedClient !== null,
      () => this.connect(),
    );
  }

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
    this.refreshScheduled = false;
    this._spaces.set([]);
    this.resetHierarchy();
  }

  /**
   * Coalesce a burst of sync events into a single rebuild: queue {@link refresh} on
   * the microtask after the current task drains, deduped by {@link refreshScheduled},
   * and dropped if {@link disconnect} ran meanwhile. ({@link connect} does the first
   * read synchronously, so consumers see the model immediately.)
   */
  private scheduleRefresh(): void {
    if (this.refreshScheduled) {
      return;
    }
    this.refreshScheduled = true;
    queueMicrotask(() => {
      this.refreshScheduled = false;
      if (this.connectedClient) {
        // Matrix client events (and thus this microtask) run OUTSIDE Angular's zone, so
        // the signal writes in refresh() wouldn't schedule change detection — a joined/
        // left/renamed space would surface only on the next incidental tick. Mirrors
        // RoomsService.scheduleRefresh, which listens to the very same events.
        this.zone.run(() => this.refresh());
      }
    });
  }

  /** Cancel any in-flight hierarchy fetch and clear the open-space child model. */
  private resetHierarchy(): void {
    this.hierarchySub?.unsubscribe();
    this.hierarchySub = null;
    this._openSpaceId.set(null);
    this._childrenBase.set([]);
    this._childrenLoading.set(false);
    this._childrenError.set(null);
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
   * Load `spaceId`'s full child set (rooms + sub-spaces, joined or not) into
   * {@link openSpaceChildren} via `getRoomHierarchy`, replacing any previously open
   * space. Pass `null` (Home) to clear it. Idempotent enough to call on every space
   * selection: a prior in-flight fetch is cancelled. Errors land in
   * {@link childrenError}; progress in {@link childrenLoading}.
   */
  openSpace(spaceId: string | null): void {
    this.hierarchySub?.unsubscribe();
    this.hierarchySub = null;
    this._openSpaceId.set(spaceId);
    this._childrenBase.set([]);
    this._childrenError.set(null);
    if (!spaceId || !this.matrix.isInitialized) {
      this._childrenLoading.set(false);
      return;
    }
    this._childrenLoading.set(true);
    this.hierarchySub = this.fetchHierarchy(spaceId).subscribe({
      next: (children) => {
        // Guard against a late response for a space we have since switched away from.
        if (this._openSpaceId() === spaceId) {
          this._childrenBase.set(children);
          this._childrenLoading.set(false);
        }
      },
      error: (err: unknown) => {
        if (this._openSpaceId() === spaceId) {
          this._childrenLoading.set(false);
          this._childrenError.set(
            err instanceof Error ? err.message : String(err),
          );
        }
      },
    });
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
          ...visibilityOptions(options.isPublic),
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
          ...visibilityOptions(options.isPublic),
          // E2EE-first: enable Megolm before the first message so the room is never
          // briefly unencrypted.
          initial_state: [roomEncryptionInitialState()],
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

  /**
   * Join a child room/space, routing through its `via` servers when known (a remote
   * room may not be resolvable on our homeserver alone). Once joined it lands in the
   * synced read model — a normal room moves into the joined channel list, a space
   * into the rail — and its {@link SpaceChildRoom.joined} flag flips live. Cold: runs
   * on subscribe.
   */
  joinRoom(roomId: string, via?: string[]): Observable<void> {
    return defer(() =>
      from(
        this.matrix.instance.joinRoom(
          roomId,
          via && via.length > 0 ? { viaServers: via } : undefined,
        ),
      ),
    ).pipe(map(() => void 0));
  }

  /**
   * Unlink a child from a space by sending an empty `m.space.child` (no `via`) for it
   * — the spec's tombstone for a removed child. We stay joined to the room; it just
   * leaves the space. The joined channel list drops it once the state change syncs
   * back. The child's `m.space.parent` is intentionally left untouched (clearing it
   * needs power in the child room and is not required to remove from the space).
   * Cold: runs on subscribe.
   */
  removeRoomFromSpace(spaceId: string, childId: string): Observable<void> {
    return defer(() =>
      from(
        this.matrix.instance.sendStateEvent(
          spaceId,
          EventType.SpaceChild,
          {},
          childId,
        ),
      ),
    ).pipe(map(() => void 0));
  }

  /**
   * Fetch a space's direct children (`maxDepth: 1`, `suggestedOnly: false`) and
   * project them to {@link SpaceChildBase}, excluding the space root itself. Cold.
   */
  private fetchHierarchy(spaceId: string): Observable<SpaceChildBase[]> {
    return defer(() =>
      from(this.fetchHierarchyRooms(spaceId)).pipe(
        map((rooms) => this.projectHierarchy(spaceId, rooms)),
      ),
    );
  }

  /**
   * Accumulate a space's children across `getRoomHierarchy` pages, following
   * `next_batch` until it's exhausted (or {@link HIERARCHY_MAX_PAGES} is hit, so
   * a huge/looping hierarchy can't fan out unbounded). Without this, spaces with
   * more than {@link HIERARCHY_LIMIT} children silently dropped the overflow.
   */
  private async fetchHierarchyRooms(spaceId: string): Promise<HierarchyRoom[]> {
    const client = this.matrix.instance;
    const rooms: HierarchyRoom[] = [];
    let fromToken: string | undefined;
    for (let page = 0; page < HIERARCHY_MAX_PAGES; page++) {
      const res = await client.getRoomHierarchy(
        spaceId,
        HIERARCHY_LIMIT,
        1,
        false,
        fromToken,
      );
      rooms.push(...res.rooms);
      if (!res.next_batch) {
        break; // no more pages — full hierarchy fetched
      }
      fromToken = res.next_batch;
    }
    return rooms;
  }

  /**
   * Project a `getRoomHierarchy` response into ordered child view models. The link
   * metadata (`via`, `suggested`, `order`) for each child lives in the *space root's*
   * `children_state`, not on the child summary — so read it from the root entry and
   * join it onto each non-root room. Ordered by the child link `order` then name, to
   * match the joined-children ordering.
   */
  private projectHierarchy(
    spaceId: string,
    rooms: HierarchyRoom[],
  ): SpaceChildBase[] {
    const root = rooms.find((r) => r.room_id === spaceId);
    const links = new Map<
      string,
      { via: string[]; suggested: boolean; order: string }
    >();
    for (const rel of root?.children_state ?? []) {
      if (!rel.state_key) {
        continue;
      }
      const via = Array.isArray(rel.content.via)
        ? rel.content.via.filter((v): v is string => typeof v === 'string')
        : [];
      links.set(rel.state_key, {
        via,
        suggested: rel.content.suggested === true,
        order: typeof rel.content.order === 'string' ? rel.content.order : '',
      });
    }

    return rooms
      .filter((r) => r.room_id !== spaceId)
      .map((r) => {
        const link = links.get(r.room_id);
        const name = r.name || r.canonical_alias || r.room_id;
        const base: SpaceChildBase = {
          roomId: r.room_id,
          name,
          initial: initialOf(name),
          ...(r.topic ? { topic: r.topic } : {}),
          avatarMxc: r.avatar_url ?? null,
          memberCount: r.num_joined_members ?? 0,
          joinRule: r.join_rule ? String(r.join_rule) : '',
          suggested: link?.suggested ?? false,
          isSpace: r.room_type === RoomType.Space,
          via: link?.via ?? [],
        };
        return { base, order: link?.order ?? '' };
      })
      .sort(
        (a, b) =>
          a.order.localeCompare(b.order) ||
          a.base.name.localeCompare(b.base.name),
      )
      .map((entry) => entry.base);
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
    // Nudge the hierarchy projection so each child's `joined` flag re-derives.
    this._revision.update((n) => n + 1);
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
    const children = (
      liveRoomState(space)?.getStateEvents(SPACE_CHILD_EVENT) ?? []
    )
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
