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
  filter,
  finalize,
  from,
  map,
  of,
  switchMap,
  take,
  takeUntil,
  tap,
  throwError,
} from 'rxjs';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import {
  roomEncryptionInitialState,
  visibilityOptions,
} from '@trinity/util/matrix';
import { isJoinedSpace, spaceChildIdsOf } from './js-sdk/room-info';
import { compareOrder } from './space-child-order';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  assertRoomLibraryGovernance,
} from './room-library-governance-policy';

/** Children fetched per `getRoomHierarchy` page. */
const HIERARCHY_LIMIT = 100;

/**
 * Safety cap on `next_batch` pages followed, so a pathological or looping hierarchy can't fan
 * out unbounded requests. 5 pages ≈ 500 children, well beyond what the rail shows usefully.
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
   * This space's *joined* child room ids, ordered by the `m.space.child` `order` (Unicode code
   * point) then room name. Children we have not joined, and removed/dangling links, are dropped.
   */
  childRoomIds: string[];
}

/**
 * A room (or sub-space) linked into a space via `m.space.child`, projected from the server's
 * space hierarchy (`getRoomHierarchy`, MSC2946). Unlike {@link SpaceSummary.childRoomIds} it
 * includes children we have not joined, so the UI can offer a Join action.
 */
export interface SpaceChildRoom {
  /** Account whose hierarchy produced this row and must handle its actions. */
  accountId: string;
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
 * Read model over the synced `MatrixClient` for Matrix **Spaces** (the server rail): the joined
 * spaces and, per space, the ordered ids of its joined child rooms.
 *
 * {@link openSpace} also fetches a space's *full* child set on demand (`getRoomHierarchy`,
 * MSC2946) so the UI can list, and {@link joinRoom}, children not yet joined. The hierarchy is
 * a network read, so unlike the sync-driven joined model it is patched into signals from the
 * fetch result, with the per-child `joined` flag recomputed live against the synced client.
 *
 * Membership results from the writes land in the joined read model through the sync listeners.
 */
@Injectable({ providedIn: 'root' })
export class SpacesService {
  private readonly matrix = inject(MatrixClientService);
  private readonly governance = inject(ROOM_LIBRARY_GOVERNANCE_POLICY);

  private readonly _spaces = signal<SpaceSummary[]>([]);
  /** The user's joined spaces, sorted by name; live as the client syncs. */
  readonly spaces = this._spaces.asReadonly();

  /**
   * Every room this account has joined, as of the last refresh. The hierarchy projection
   * derives each child's `joined` flag from it live (a not-joined child flips as its
   * membership syncs back) without re-fetching the hierarchy.
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
  /** Each rebuild of the joined model, for a hierarchy waiting for its space to be joined. */
  private readonly refreshed = new Subject<void>();
  /** How many {@link leaveSpace} requests are in flight, per Account-and-space pair. */
  private readonly _leaving = signal<ReadonlyMap<string, number>>(new Map());

  /**
   * The open space's full child set, with each child's `joined` flag derived live
   * against the synced client (so a join/leave is reflected without a re-fetch).
   */
  readonly openSpaceChildren = computed<SpaceChildRoom[]>(() => {
    // Reading the set rather than the client keeps the derivation inside signals: during an
    // account switch `matrix.instance` can already be the NEXT account's client while
    // `_childrenBase` still holds the previous account's hierarchy.
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
   * Open-space children that are themselves Spaces (joined or not). Joined sub-spaces already
   * live in the rail; the sidebar surfaces them so they can be opened, and offers a Join for
   * the rest.
   */
  readonly childSpaces = computed<SpaceChildRoom[]>(() =>
    this.openSpaceChildren().filter((c) => c.isSpace),
  );

  /**
   * Scoped to `m.space.child`: every state event flows through here, so filter to child links
   * rather than refreshing on unrelated state (avatars, topics, other rooms' membership).
   */
  private readonly onStateEvent = (event: MatrixEvent): void => {
    if (event.getType() === SPACE_CHILD_EVENT) {
      // Via the projection's scheduler so it coalesces with the sync burst that
      // typically accompanies it.
      this.projection.schedule();
    }
  };

  /**
   * Listens to the same events as {@link RoomLibraryService} via the shared
   * {@link projectFromClient}.
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
    rebuild: () => this.refresh(),
    // `m.space.child` add/remove/reorder arrives as a room state event the handler must
    // inspect to tell it from other state changes, so it is bound by hand, not listed above.
    bind: (client) => client.on(RoomStateEvent.Events, this.onStateEvent),
    unbind: (client) => client.off(RoomStateEvent.Events, this.onStateEvent),
    reset: () => {
      this._spaces.set([]);
      this._joinedRoomIds.set(new Set());
      this.resetHierarchy();
    },
  });

  /** Cold active-Account projection retained by the Room Library session lifetime. */
  runProjection(): Observable<void> {
    return this.projection.run();
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
   * Ordered joined child-room ids of a space, or `[]` for Home (`null`) or an unknown space.
   * Reads the {@link spaces} signal, so callers inside a `computed`/effect stay reactive.
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
   * Load `spaceId`'s full child set (rooms and sub-spaces, joined or not) into
   * {@link openSpaceChildren} via `getRoomHierarchy`, replacing any previously open space;
   * `null` (Home) clears it. A prior in-flight fetch is cancelled. Errors land in
   * {@link childrenError} and also reach the subscriber; progress in {@link childrenLoading}.
   * Cold.
   *
   * A lifetime, not a one-shot command: for a space the active Account has not joined (a
   * restored space its first sync has yet to bring, or one only another Account holds in
   * the mixed view) it waits for the join before reading the hierarchy. It completes once
   * the hierarchy is read, or when the next call or an Account change cancels it; otherwise
   * its owner ends it. Workspace holds it for each committed view (see
   * `state-and-reactivity.md`).
   */
  openSpace(spaceId: string | null): Observable<void> {
    return defer(() => {
      this.hierarchyCancelled.next();
      this._openSpaceId.set(spaceId);
      this._childrenBase.set([]);
      this._childrenError.set(null);
      this._childrenLoading.set(false);
      if (!spaceId) return of(void 0);
      // The hierarchy is read as the active Account, so it waits until that Account has
      // joined the space. A restored space can be named before the Account's first sync
      // brings it. In the mixed view the active Account can be showing a space only another
      // Account holds: its own `/hierarchy` read would fail for a private space, and joining
      // a child from here would join as the wrong Account, so it lists the joined children
      // alone. A left space never fetches.
      const joined = this.activeHolds(spaceId)
        ? of(void 0)
        : this.refreshed.pipe(
            filter(() => this.activeHolds(spaceId)),
            take(1),
          );
      return joined.pipe(
        switchMap(() => {
          this._childrenLoading.set(true);
          return this.fetchHierarchy(spaceId);
        }),
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
   * Create a new Space (a room with `type: m.space`), resolving its room id. The rail pill
   * appears once the client syncs the new room. Cold.
   */
  createSpace(
    accountId: string,
    options: CreateSpaceOptions,
  ): Observable<string> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) return throwError(() => new Error('Account unavailable.'));
      return from(
        client.createRoom({
          // `creation_content.type` marks the room as a Space; the SDK types
          // `creation_content` loosely (`object`), so the field is set here.
          creation_content: { type: RoomType.Space },
          name: options.name.trim(),
          ...(options.topic?.trim() ? { topic: options.topic.trim() } : {}),
          ...visibilityOptions(options.isPublic),
        }),
      ).pipe(map((res) => res.room_id));
    });
  }

  /**
   * Create a normal room encrypted from the first event (Megolm `m.room.encryption` in
   * `initial_state`) and link it into `spaceId`, resolving the new room id. Linked both ways:
   * `m.space.child` on the space and a canonical `m.space.parent` on the child, both carrying
   * our homeserver in `via` so a remote server can route to the room. Cold.
   */
  createRoomInSpace(
    spaceId: string,
    options: CreateRoomInSpaceOptions,
  ): Observable<string> {
    return defer(() => {
      const client = this.matrix.instance;
      const accountId = client.getUserId();
      if (!accountId) {
        return throwError(() => new Error('Not signed in.'));
      }
      assertRoomLibraryGovernance(
        this.governance.authorize(
          { accountId, roomId: spaceId },
          'curate-space',
        ),
      );
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
   * Leave a space room. Only the space is left; its child rooms stay joined. The rail drops
   * the pill once the membership change syncs back.
   */
  leaveSpace(accountId: string, spaceId: string): Observable<void> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) return throwError(() => new Error('Account unavailable.'));
      const key = leavingKey(accountId, spaceId);
      this.countLeave(key, 1);
      return from(client.leave(spaceId)).pipe(
        map(() => void 0),
        finalize(() => this.countLeave(key, -1)),
      );
    });
  }

  /**
   * Whether a {@link leaveSpace} this app started for that Account and space is still in
   * flight. The sync that drops the space can arrive before the request settles, and the
   * leave flow navigates away itself once it does, so Workspace leaves that space alone
   * meanwhile. Every leave of a space has to go through {@link leaveSpace} for this to hold.
   */
  isLeaving(accountId: string, spaceId: string): boolean {
    return this._leaving().has(leavingKey(accountId, spaceId));
  }

  private countLeave(key: string, change: 1 | -1): void {
    this._leaving.update((counts) => {
      const next = new Map(counts);
      const count = (next.get(key) ?? 0) + change;
      if (count > 0) next.set(key, count);
      else next.delete(key);
      return next;
    });
  }

  /**
   * Join a child room/space, routing through its `via` servers when known (a remote room may
   * not resolve on our homeserver alone). The result reaches the read model through sync and
   * flips {@link SpaceChildRoom.joined} live. Cold.
   */
  joinRoom(
    accountId: string,
    roomId: string,
    via?: string[],
  ): Observable<void> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) return throwError(() => new Error('Account unavailable.'));
      return from(
        client.joinRoom(
          roomId,
          via && via.length > 0 ? { viaServers: via } : undefined,
        ),
      ).pipe(map(() => void 0));
    });
  }

  /**
   * Unlink a child from a space by sending an empty `m.space.child` (no `via`), the spec's
   * tombstone for a removed child. We stay joined to the room. The child's `m.space.parent` is
   * intentionally left untouched: clearing it needs power in the child room and is not required
   * to remove it from the space. Cold.
   */
  removeRoomFromSpace(spaceId: string, childId: string): Observable<void> {
    return defer(() => {
      const client = this.matrix.instance;
      const accountId = client.getUserId();
      if (!accountId) {
        return throwError(() => new Error('Not signed in.'));
      }
      assertRoomLibraryGovernance(
        this.governance.authorize(
          { accountId, roomId: spaceId },
          'curate-space',
        ),
      );
      return from(
        client.sendStateEvent(spaceId, EventType.SpaceChild, {}, childId),
      ).pipe(map(() => void 0));
    });
  }

  /** Whether the active Account holds a space (see {@link isJoinedSpace}). */
  private activeHolds(spaceId: string): boolean {
    if (!this.matrix.isInitialized) return false;
    const space = this.matrix.instance.getRoom(spaceId);
    return !!space && isJoinedSpace(space);
  }

  /**
   * Fetch a space's direct children (`maxDepth: 1`, `suggestedOnly: false`) and project them,
   * excluding the space root itself. Cold.
   */
  private fetchHierarchy(spaceId: string): Observable<SpaceChildBase[]> {
    return defer(() => {
      const client = this.matrix.instance;
      const accountId = client.getUserId();
      if (!accountId) throw new Error('Account unavailable.');
      return from(this.fetchHierarchyRooms(client, spaceId)).pipe(
        map((rooms) => this.projectHierarchy(accountId, spaceId, rooms)),
      );
    });
  }

  /**
   * Accumulate a space's children across `getRoomHierarchy` pages via `next_batch`, up to
   * {@link HIERARCHY_MAX_PAGES} so a huge or looping hierarchy can't fan out unbounded. A single
   * page would silently drop the overflow of spaces with more than {@link HIERARCHY_LIMIT}
   * children.
   */
  private async fetchHierarchyRooms(
    client: MatrixClient,
    spaceId: string,
  ): Promise<HierarchyRoom[]> {
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
   * Project a `getRoomHierarchy` response into ordered child view models. The link metadata
   * (`via`, `suggested`, `order`) lives in the *space root's* `children_state`, not on the child
   * summary, so it is read from the root entry and joined onto each non-root room. Ordered like
   * the joined children: child link `order`, then name.
   */
  private projectHierarchy(
    accountId: string,
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
          accountId,
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
    // Every joined room, spaces included (a child of the open space may be either):
    // `openSpaceChildren` derives its `joined` flag from this. Structural equality stops an
    // ordinary sync that changed no membership here, rather than re-deriving the downstream
    // computeds.
    this._joinedRoomIds.set(
      new Set(
        rooms
          .filter((r) => r.getMyMembership() === 'join')
          .map((r) => r.roomId),
      ),
    );
    this.refreshed.next();
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

/** One Account's leave of one space, as a single set key. */
function leavingKey(accountId: string, spaceId: string): string {
  return JSON.stringify([accountId, spaceId]);
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
 * Our homeserver name from the user id (`@user:server.tld` → `server.tld`), for the `via` of
 * `m.space.child`/`m.space.parent` links. Empty when there is no server part; the homeserver
 * still accepts the link, just without routing help.
 */
function serverNameOf(userId: string | null): string {
  const colon = userId?.indexOf(':') ?? -1;
  return colon >= 0 ? userId!.slice(colon + 1) : '';
}
