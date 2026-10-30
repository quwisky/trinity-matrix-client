import {
  DestroyRef,
  Injectable,
  Injector,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import {
  NEVER,
  Observable,
  Subject,
  concat,
  defer,
  finalize,
  map,
  of,
  switchMap,
  takeUntil,
  tap,
  throwError,
} from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  SESSION_ENGINE,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import { plainEqual } from '@trinity/util/matrix';
import { compareOrder } from './space-child-order';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  assertRoomLibraryGovernance,
} from './room-library-governance-policy';
import type { CreateRoomRequest, HierarchyEntry } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { RoomListStore } from './room-list-store';
import { initialOf } from './room-projection';
import { SpaceLinkFeeds, joinedChildIds, linkKey } from './space-link-feeds';
import { unwrapOwned } from './unwrap-owned';

/**
 * Safety cap on hierarchy pages followed, so a pathological hierarchy can't fan out unbounded
 * requests. 5 pages ≈ 500 children, well beyond what the rail shows usefully.
 */
const HIERARCHY_MAX_PAGES = 5;

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
 * Read model over the active Account's room list for Matrix **Spaces** (the server rail): the
 * joined spaces and, per space, the ordered ids of its joined child rooms, from
 * {@link RoomListStore} and each space's child links.
 *
 * {@link openSpace} also fetches a space's *full* child set on demand (`/hierarchy`, MSC2946)
 * so the UI can list, and {@link joinRoom}, children not yet joined. The hierarchy is a network
 * read, so it is patched into signals from the fetch result, with the per-child `joined` flag
 * recomputed live against the room list.
 *
 * Membership results from the writes land in the joined read model through the room list.
 */
@Injectable({ providedIn: 'root' })
export class SpacesService {
  private readonly engine = inject(ROOM_LIST_ENGINE);
  private readonly store = inject(RoomListStore);
  private readonly session = inject(SessionStateService);
  private readonly governance = inject(ROOM_LIBRARY_GOVERNANCE_POLICY);
  private readonly injector = inject(Injector);

  private readonly links = new SpaceLinkFeeds(this.engine);

  /** The active Account's room list, or null while no Account is active and live. */
  private readonly activeList = computed(() => {
    const accountId = this.session.activeAccountId();
    const generation = accountId
      ? this.session.status(accountId)?.generation
      : undefined;
    return accountId && generation !== undefined
      ? { accountId, generation, rows: this.store.rooms(accountId)() }
      : null;
  });

  /** The user's joined spaces, sorted by name; live as the client syncs. */
  readonly spaces = computed<SpaceSummary[]>(
    () => {
      const list = this.activeList();
      if (!list) return [];
      const { accountId, generation, rows } = list;
      const joined = new Map(
        rows.filter((r) => r.membership === 'join').map((r) => [r.roomId, r]),
      );
      const open = new Set<string>();
      const spaces = [...joined.values()]
        .filter((r) => r.isSpace)
        .map((space): SpaceSummary => {
          open.add(linkKey(accountId, generation, space.roomId));
          return {
            id: space.roomId,
            accountId,
            name: space.displayName,
            initial: initialOf(space.displayName),
            avatarMxc: space.avatarMxc,
            childRoomIds: joinedChildIds(
              this.links.linksOf(accountId, generation, space.roomId),
              joined,
            ),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      // A space that left the list closes here; an Account that left closes on the session.
      untracked(() => this.links.close((feed) => !open.has(feed.key)));
      return spaces;
    },
    { equal: plainEqual },
  );

  /**
   * Every room the active Account has joined. The hierarchy projection derives each child's
   * `joined` flag from it live (a not-joined child flips as its membership syncs back)
   * without re-fetching the hierarchy.
   */
  private readonly joinedRoomIds = computed<ReadonlySet<string>>(
    () =>
      new Set(
        (this.activeList()?.rows ?? [])
          .filter((r) => r.membership === 'join')
          .map((r) => r.roomId),
      ),
    { equal: sameIds },
  );

  /** Which space's hierarchy is currently loaded ({@link openSpace}); null on Home. */
  private readonly _openSpaceId = signal<string | null>(null);
  /**
   * The active Account a space was opened as; undefined while none is open, null while it
   * waits for a first Account to become active.
   */
  private openedAs: string | null | undefined;
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
  /** How many {@link leaveSpace} requests are in flight, per Account-and-space pair. */
  private readonly _leaving = signal<ReadonlyMap<string, number>>(new Map());

  /**
   * The open space's full child set, with each child's `joined` flag derived live
   * against the room list (so a join/leave is reflected without a re-fetch).
   */
  readonly openSpaceChildren = computed<SpaceChildRoom[]>(() => {
    const joined = this.joinedRoomIds();
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

  constructor() {
    // An Account switch ends the open space: its hierarchy was read as the previous Account.
    // The first Account to become active takes over a space opened before any was.
    effect(() => {
      const active = this.session.activeAccountId();
      untracked(() => {
        if (this.openedAs === null) this.openedAs = active;
        else if (this.openedAs !== undefined && this.openedAs !== active) {
          this.resetHierarchy();
        }
      });
    });
    // Closes the links of an Account that stopped being active or live even when nothing
    // reads `spaces` any more.
    inject(SESSION_ENGINE)
      .session()
      .pipe(takeUntilDestroyed())
      .subscribe(() =>
        untracked(() => {
          const active = this.session.activeAccountId();
          this.links.close(
            (feed) =>
              feed.accountId !== active ||
              this.session.status(feed.accountId)?.generation !==
                feed.generation,
          );
        }),
      );
    inject(DestroyRef).onDestroy(() => this.links.close(() => true));
  }

  /**
   * Retained by the Room Library session lifetime. The store keeps each live Account's room
   * list itself, so this only acknowledges at once.
   */
  runProjection(): Observable<void> {
    return concat(of(undefined), NEVER);
  }

  /** Cancel any in-flight hierarchy fetch and clear the open-space child model. */
  private resetHierarchy(): void {
    this.hierarchyCancelled.next();
    this.openedAs = undefined;
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
   * {@link openSpaceChildren} via `/hierarchy`, replacing any previously open space;
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
      if (!spaceId) {
        this.openedAs = undefined;
        return of(void 0);
      }
      const accountId = this.session.activeAccountId();
      this.openedAs = accountId;
      // The hierarchy is read as the active Account, so it waits until that Account has
      // joined the space. A restored space can be named before the Account's first sync
      // brings it. In the mixed view the active Account can be showing a space only another
      // Account holds: its own `/hierarchy` read would fail for a private space, and joining
      // a child from here would join as the wrong Account, so it lists the joined children
      // alone. A left space never fetches.
      return this.held(accountId, spaceId).pipe(
        switchMap((holder) => {
          this.openedAs = holder;
          this._childrenLoading.set(true);
          return this.fetchHierarchy(holder, spaceId);
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
   * appears once the room list lists the new room. Cold.
   */
  createSpace(
    accountId: string,
    options: CreateSpaceOptions,
  ): Observable<string> {
    return defer(() =>
      this.engine
        .createRoom(accountId, createRequest(options, 'space', null))
        .pipe(
          unwrapOwned('Account unavailable.'),
          map((created) => created.roomId),
        ),
    );
  }

  /**
   * Create a normal room encrypted from the first event and link it into `spaceId`, resolving
   * the new room id. Linked both ways: `m.space.child` on the space and a canonical
   * `m.space.parent` on the child, both carrying our homeserver in `via` so a remote server
   * can route to the room. Cold.
   */
  createRoomInSpace(
    spaceId: string,
    options: CreateRoomInSpaceOptions,
  ): Observable<string> {
    return defer(() => {
      const accountId = this.session.activeAccountId();
      if (!accountId) {
        return throwError(() => new Error('Not signed in.'));
      }
      assertRoomLibraryGovernance(
        this.governance.authorize(
          { accountId, roomId: spaceId },
          'curate-space',
        ),
      );
      return this.engine
        .createRoom(accountId, createRequest(options, 'room', spaceId))
        .pipe(
          unwrapOwned(),
          map((created) => created.roomId),
        );
    });
  }

  /**
   * Leave a space room. Only the space is left; its child rooms stay joined. The rail drops
   * the pill once the room list does.
   */
  leaveSpace(accountId: string, spaceId: string): Observable<void> {
    return defer(() => {
      if (!this.session.accountIds().includes(accountId)) {
        return throwError(() => new Error('Account unavailable.'));
      }
      const key = leavingKey(accountId, spaceId);
      this.countLeave(key, 1);
      return this.engine.leave(accountId, spaceId).pipe(
        unwrapOwned('Account unavailable.'),
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
   * not resolve on our homeserver alone). The result reaches the room list and flips
   * {@link SpaceChildRoom.joined} live. Cold.
   */
  joinRoom(
    accountId: string,
    roomId: string,
    via?: string[],
  ): Observable<void> {
    return defer(() =>
      this.engine.join(accountId, roomId, via ?? []).pipe(
        unwrapOwned('Account unavailable.'),
        map(() => void 0),
      ),
    );
  }

  /**
   * Unlink a child from a space by sending an empty `m.space.child` (no `via`), the spec's
   * tombstone for a removed child. We stay joined to the room. The child's `m.space.parent` is
   * intentionally left untouched: clearing it needs power in the child room and is not required
   * to remove it from the space. Cold.
   */
  removeRoomFromSpace(spaceId: string, childId: string): Observable<void> {
    return defer(() => {
      const accountId = this.session.activeAccountId();
      if (!accountId) {
        return throwError(() => new Error('Not signed in.'));
      }
      assertRoomLibraryGovernance(
        this.governance.authorize(
          { accountId, roomId: spaceId },
          'curate-space',
        ),
      );
      return this.engine.setSpaceChild(accountId, spaceId, childId, null).pipe(
        unwrapOwned(),
        map(() => void 0),
      );
    });
  }

  /**
   * Emits the Account, then completes, once `accountId` holds `spaceId` as a joined space;
   * with no Account, whichever Account is active then.
   */
  private held(accountId: string | null, spaceId: string): Observable<string> {
    const holder = (): string | null => {
      const id = accountId ?? this.session.activeAccountId();
      const space = id ? this.store.room(id, spaceId) : null;
      return space?.isSpace && space.membership === 'join' ? id : null;
    };
    const now = untracked(holder);
    if (now) return of(now);
    return new Observable<string>((subscriber) => {
      // An effect re-reads the room list on every run, so no change between runs is missed.
      const watch = effect(
        () => {
          const id = holder();
          if (!id) return;
          untracked(() => {
            subscriber.next(id);
            subscriber.complete();
          });
        },
        { injector: this.injector },
      );
      return () => watch.destroy();
    });
  }

  /** A space's direct children, projected and excluding the space root itself. Cold. */
  private fetchHierarchy(
    accountId: string,
    spaceId: string,
  ): Observable<SpaceChildBase[]> {
    return this.engine
      .spaceHierarchy(accountId, spaceId, { maxPages: HIERARCHY_MAX_PAGES })
      .pipe(
        unwrapOwned('Account unavailable.'),
        map((entries) => projectHierarchy(accountId, spaceId, entries)),
      );
  }
}

function createRequest(
  options: CreateSpaceOptions | CreateRoomInSpaceOptions,
  kind: CreateRoomRequest['kind'],
  parentSpaceId: string | null,
): CreateRoomRequest {
  return {
    name: options.name.trim(),
    topic: options.topic?.trim() || null,
    isPublic: options.isPublic === true,
    kind,
    parentSpaceId,
  };
}

/**
 * Project a `/hierarchy` response into ordered child view models. The link metadata (`via`,
 * `suggested`, `order`) lives in the *space root's* children state, not on the child summary,
 * so it is read from the root entry and joined onto each non-root room. Ordered like the
 * joined children: child link `order`, then name.
 */
function projectHierarchy(
  accountId: string,
  spaceId: string,
  entries: readonly HierarchyEntry[],
): SpaceChildBase[] {
  const root = entries.find((e) => e.roomId === spaceId);
  const links = new Map(
    (root?.childrenState ?? []).map((link) => [link.childId, link]),
  );
  return entries
    .filter((e) => e.roomId !== spaceId)
    .map((e) => {
      const link = links.get(e.roomId);
      const name = e.name || e.canonicalAlias || e.roomId;
      const base: SpaceChildBase = {
        accountId,
        roomId: e.roomId,
        name,
        initial: initialOf(name),
        ...(e.topic ? { topic: e.topic } : {}),
        avatarMxc: e.avatarMxc,
        memberCount: e.joinedMemberCount,
        joinRule: e.joinRule ?? '',
        suggested: link?.suggested ?? false,
        isSpace: e.isSpace,
        via: [...(link?.via ?? [])],
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

/** One Account's leave of one space, as a single set key. */
function leavingKey(accountId: string, spaceId: string): string {
  return JSON.stringify([accountId, spaceId]);
}

/**
 * Whether two id sets hold the same ids, so a room list change that altered no membership
 * does not re-derive the hierarchy projection and everything downstream of it.
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
