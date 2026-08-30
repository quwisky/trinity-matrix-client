import { Injectable, computed, inject, signal } from '@angular/core';
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
import {
  Observable,
  Subject,
  defer,
  finalize,
  from,
  map,
  of,
  switchMap,
  takeUntil,
  tap,
} from 'rxjs';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import {
  roomEncryptionInitialState,
  visibilityOptions,
} from '@trinity/util/matrix';
import { spaceChildIdsOf } from './room-projection';
import { compareOrder } from './space-child-order';
import { RoomActionPermissionsService } from './room-action-permissions.service';

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
  /** The signed-in account this space belongs to (its user id) — for the mixed view. */
  accountId: string;
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
 * Mirrors {@link RoomLibraryService}'s patterns: components never touch `matrix-js-sdk`
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
  private readonly actionPermissions = inject(RoomActionPermissionsService);

  private readonly _spaces = signal<SpaceSummary[]>([]);
  /** The user's joined spaces, sorted by name; live as the client syncs. */
  readonly spaces = this._spaces.asReadonly();

  /**
   * Every room this account has joined, as of the last refresh.
   *
   * The hierarchy projection reads this to derive each child's `joined` flag live (a
   * not-joined child flips the moment its membership syncs back) without re-fetching the
   * hierarchy. It replaces a bump counter that meant the same thing indirectly: this is
   * the actual question `openSpaceChildren` asks, `refresh()` already has the answer in
   * hand from its own `getRooms()` pass, and a set of ids is inspectable in a debugger
   * where an incrementing integer is not.
   */
  private readonly _joinedRoomIds = signal<ReadonlySet<string>>(new Set(), {
    equal: sameIds,
  });

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

  /** Cancels the previous cold hierarchy command when selection or Account changes. */
  private readonly hierarchyCancelled = new Subject<void>();

  /**
   * The open space's full child set, with each child's `joined` flag derived live
   * against the synced client (so a join/leave is reflected without a re-fetch).
   */
  readonly openSpaceChildren = computed<SpaceChildRoom[]>(() => {
    // Reading the set rather than the client keeps the whole derivation inside signals.
    // The old form reached for `matrix.instance` here, which during an account switch can
    // already be the NEXT account's client while `_childrenBase` still holds the previous
    // account's hierarchy — two sources, one frame apart.
    const joined = this._joinedRoomIds();
    return this._childrenBase().map((base) => ({
      ...base,
      joined: joined.has(base.roomId),
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
   * State-event listener scoped to `m.space.child`: every state event flows through
   * here, so filter to the child links to avoid refreshing on unrelated state
   * (avatars, topics, membership of unrelated rooms, …). These are rare admin
   * actions (not a sync burst), so they refresh immediately rather than coalescing.
   */
  private readonly onStateEvent = (event: MatrixEvent): void => {
    if (event.getType() === SPACE_CHILD_EVENT) {
      // Via the projection's scheduler so it coalesces with the sync burst that
      // typically accompanies it.
      this.projection.schedule();
    }
  };

  /**
   * The sync projection: client-keyed listeners, coalesced rebuilds, re-projection on an
   * account switch. Listens to the same events as {@link RoomLibraryService} — which is the
   * point of sharing {@link projectFromClient} rather than mirroring it by hand.
   */
  private readonly projection = projectFromClient({
    id: 'rooms.spaces',
    matrix: this.matrix,
    events: [
      ClientEvent.Sync,
      ClientEvent.Room,
      // A space (or child) being (re)named affects sort order and labels.
      RoomEvent.Name,
      // Joining/leaving a space or a child room changes what is shown.
      RoomEvent.MyMembership,
    ],
    // refresh() writes signals, which schedule change detection on their own.
    rebuild: () => this.refresh(),
    // `m.space.child` add/remove/reorder arrives as a room state event, and the handler
    // has to read the event to tell it apart from every other state change — so it is
    // bound by hand rather than listed above.
    bind: (client) => client.on(RoomStateEvent.Events, this.onStateEvent),
    unbind: (client) => client.off(RoomStateEvent.Events, this.onStateEvent),
    reset: () => {
      this._spaces.set([]);
      this._joinedRoomIds.set(new Set());
      this.resetHierarchy();
    },
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

  /** Cancel any in-flight hierarchy fetch and clear the open-space child model. */
  private resetHierarchy(): void {
    this.hierarchyCancelled.next();
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
   * The spaces that directly contain `roomId`, from the live {@link spaces} signal — the
   * inverse of {@link childRoomIds}, and reactive for the same reason.
   *
   * Deliberately NOT read off the room's own `m.space.parent`: `removeRoomFromSpace`
   * leaves that event in place on purpose, so an unlinked room still advertises its former
   * parent. Granting a `restricted` join rule on the strength of it would hand join rights
   * to a space that no longer contains the room.
   *
   * Direct parents only. MSC3083 membership does not transit the hierarchy, so a
   * grandparent's members are not admitted by allowing the parent.
   */
  parentSpaceIds(roomId: string): string[] {
    if (!roomId) {
      return [];
    }
    return this.spaces()
      .filter((space) => space.childRoomIds.includes(roomId))
      .map((space) => space.id);
  }

  /**
   * Load `spaceId`'s full child set (rooms + sub-spaces, joined or not) into
   * {@link openSpaceChildren} via `getRoomHierarchy`, replacing any previously open
   * space. Pass `null` (Home) to clear it. Idempotent enough to call on every space
   * selection: a prior in-flight fetch is cancelled. Errors land in
   * {@link childrenError}; progress in {@link childrenLoading}. Cold and finite: selection
   * changes only when subscribed, errors update the signal and also reach the subscriber.
   */
  openSpace(spaceId: string | null): Observable<void> {
    return defer(() => {
      this.hierarchyCancelled.next();
      this._openSpaceId.set(spaceId);
      this._childrenBase.set([]);
      this._childrenError.set(null);
      if (!spaceId || !this.matrix.isInitialized) {
        this._childrenLoading.set(false);
        return of(void 0);
      }
      this._childrenLoading.set(true);
      return this.fetchHierarchy(spaceId).pipe(
        takeUntil(this.hierarchyCancelled),
        tap({
          next: (children) => {
            if (this._openSpaceId() === spaceId) {
              this._childrenBase.set(children);
            }
          },
          error: (error: unknown) => {
            if (this._openSpaceId() === spaceId) {
              this._childrenError.set(
                error instanceof Error ? error.message : String(error),
              );
            }
          },
        }),
        map(() => void 0),
        finalize(() => {
          if (this._openSpaceId() === spaceId) {
            this._childrenLoading.set(false);
          }
        }),
      );
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
      this.actionPermissions.assert(
        this.actionPermissions.room(spaceId).curateSpace,
      );
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
    return defer(() => {
      this.actionPermissions.assert(
        this.actionPermissions.room(spaceId).curateSpace,
      );
      return from(
        this.matrix.instance.sendStateEvent(
          spaceId,
          EventType.SpaceChild,
          {},
          childId,
        ),
      ).pipe(map(() => void 0));
    });
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
          compareOrder(a.order, b.order) ||
          a.base.name.localeCompare(b.base.name),
      )
      .map((entry) => entry.base);
  }

  private refresh(): void {
    if (!this.matrix.isInitialized) {
      return;
    }
    const client = this.matrix.instance;
    const rooms = client.getRooms();
    this._spaces.set(
      rooms
        .filter((r) => r.isSpaceRoom() && r.getMyMembership() === 'join')
        .map((r) => this.toSpace(client, r))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
    // Every joined room, spaces included: a child of the open space may be either, and
    // `openSpaceChildren` derives its `joined` flag from this. The signal's structural
    // equality means an ordinary sync that changed no membership stops here rather than
    // re-deriving four downstream computeds.
    this._joinedRoomIds.set(
      new Set(
        rooms
          .filter((r) => r.getMyMembership() === 'join')
          .map((r) => r.roomId),
      ),
    );
  }

  private toSpace(client: MatrixClient, room: Room): SpaceSummary {
    const name = room.name || room.roomId;
    return {
      id: room.roomId,
      accountId: this.matrix.activeUserId() ?? client.getUserId?.() ?? '',
      name,
      initial: initialOf(name),
      avatarMxc: room.getMxcAvatarUrl(),
      childRoomIds: spaceChildIdsOf(client, room),
    };
  }
}

/**
 * Whether two id sets hold the same ids, so a sync that changed no membership does not
 * re-derive the hierarchy projection and everything downstream of it.
 */
function sameIds(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) {
    return false;
  }
  for (const id of a) {
    if (!b.has(id)) {
      return false;
    }
  }
  return true;
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
