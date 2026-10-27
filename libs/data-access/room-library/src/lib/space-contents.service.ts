import {
  Injectable,
  Injector,
  type Signal,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import {
  Observable,
  asyncScheduler,
  catchError,
  defer,
  map,
  merge,
  of,
  skip,
  switchMap,
  take,
  tap,
  throttleTime,
  throwError,
} from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  EngineRequestError,
  plainEqual,
  retryTransient,
  unwrapEngineResult,
} from '@trinity/util/matrix';
import { initialOf } from './room-projection';
import { RoomLibraryService } from './room-library.service';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  assertRoomLibraryGovernance,
  type RoomLibraryGovernanceDecision,
} from './room-library-governance-policy';
import type { HierarchyEntry } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { RoomListStore } from './room-list-store';
import {
  SpaceChildrenService,
  type SpaceChildLink,
  type SpaceChildWriteReceipt,
} from './space-children.service';
import { compareOrder } from './space-child-order';
import { SpacesService } from './spaces.service';

/** Minimum spacing between hierarchy refreshes triggered by sync invalidations. */
const HIERARCHY_REFRESH_MS = 250;

export interface SpaceContentsTarget {
  readonly accountId: string;
  readonly spaceId: string;
}

export interface SpaceContentsItem {
  readonly id: string;
  readonly name: string;
  readonly initial: string;
  readonly avatarMxc: string | null;
  readonly kind: 'room' | 'space';
  readonly joined: boolean;
  readonly via: readonly string[];
  readonly suggested: boolean;
  readonly order: string;
}

export interface SpaceContentsCandidate extends SpaceContentsItem {
  readonly direct: boolean;
}

export type SpaceContentsAvailability =
  'available' | 'account-unavailable' | 'space-unavailable';

export interface SpaceContentsSnapshot {
  readonly target: SpaceContentsTarget;
  readonly availability: SpaceContentsAvailability;
  readonly unavailableReason: string | null;
  readonly items: readonly SpaceContentsItem[];
  readonly curationLinks: readonly SpaceChildLink[];
  readonly candidates: readonly SpaceContentsCandidate[];
  readonly canManage: boolean;
  readonly managementUnavailableReason: string | null;
  readonly hierarchyError: string | null;
}

export interface CreatedSpaceContent {
  readonly id: string;
  readonly name: string;
  readonly kind: 'room' | 'space';
}

export type CreateSpaceContentResult =
  | { readonly kind: 'linked'; readonly item: CreatedSpaceContent }
  | {
      readonly kind: 'created-unlinked';
      readonly item: CreatedSpaceContent;
      readonly reason: string;
    };

/** Exact Account-and-Space hierarchy reads and parent-owned child-link commands. */
@Injectable({ providedIn: 'root' })
export class SpaceContentsService {
  private readonly engine = inject(ROOM_LIST_ENGINE);
  private readonly store = inject(RoomListStore);
  private readonly session = inject(SessionStateService);
  private readonly governance = inject(ROOM_LIBRARY_GOVERNANCE_POLICY);
  private readonly rooms = inject(RoomLibraryService);
  private readonly spaces = inject(SpacesService);
  private readonly children = inject(SpaceChildrenService);
  private readonly injector = inject(Injector);

  /**
   * Observe one immutable target and reattach when its Account starts a new generation.
   * Subscribe outside a reactive context: the `watch()` effect is created at subscribe time.
   */
  observe(target: SpaceContentsTarget): Observable<SpaceContentsSnapshot> {
    const generation = computed(
      () => this.session.status(target.accountId)?.generation ?? null,
    );
    return watch(generation, this.injector).pipe(
      switchMap((current) =>
        current === null
          ? of(this.unavailableSnapshot(target))
          : this.observeGeneration(target, current),
      ),
    );
  }

  /** Read the latest hierarchy once, for explicit retry and post-command refresh. */
  read(target: SpaceContentsTarget): Observable<SpaceContentsSnapshot> {
    return defer(() => {
      const generation = this.session.status(target.accountId)?.generation;
      if (generation === undefined) return of(this.unavailableSnapshot(target));
      return this.engine.spaceChildLinks(target.accountId, target.spaceId).pipe(
        take(1),
        switchMap((links) => this.load(target, generation, () => links)),
      );
    });
  }

  /** Link an existing joined Room or Space through the parent's state only. */
  link(target: SpaceContentsTarget, childId: string): Observable<void> {
    return defer(() =>
      this.children.addExistingRoom(target.accountId, target.spaceId, childId),
    );
  }

  /** Unlink a child without leaving or deleting it. */
  unlink(target: SpaceContentsTarget, childId: string): Observable<void> {
    return defer(() =>
      this.children.removeExistingRoom(
        target.accountId,
        target.spaceId,
        childId,
      ),
    );
  }

  /** Change one child suggestion through the immutable opening Account and Space. */
  setSuggested(
    target: SpaceContentsTarget,
    childId: string,
    suggested: boolean,
  ): Observable<SpaceChildWriteReceipt> {
    return defer(() =>
      this.children.setSuggested(
        target.accountId,
        target.spaceId,
        childId,
        suggested,
      ),
    );
  }

  /** Move one child in the shared Space order through the immutable target. */
  moveChildBefore(
    target: SpaceContentsTarget,
    childId: string,
    beforeChildId: string | null,
  ): Observable<SpaceChildWriteReceipt> {
    return defer(() =>
      this.children.moveChildBefore(
        target.accountId,
        target.spaceId,
        childId,
        beforeChildId,
      ),
    );
  }

  /**
   * Create first, then link. A rejected second step resolves with the durable created
   * item so the UI can retry only the link and never create a duplicate.
   */
  create(
    target: SpaceContentsTarget,
    kind: CreatedSpaceContent['kind'],
    name: string,
  ): Observable<CreateSpaceContentResult> {
    return defer(() => {
      assertRoomLibraryGovernance(this.managementDecision(target));
      const trimmedName = name.trim();
      if (!trimmedName) {
        return throwError(() => new Error('A name is required.'));
      }
      const create =
        kind === 'space'
          ? this.spaces.createSpace(target.accountId, { name: trimmedName })
          : this.rooms.createRoomFor(target.accountId, { name: trimmedName });
      return create.pipe(
        switchMap((id) => {
          const item: CreatedSpaceContent = { id, name: trimmedName, kind };
          return this.link(target, id).pipe(
            map(() => ({ kind: 'linked', item }) as const),
            catchError((error: unknown) =>
              of({
                kind: 'created-unlinked',
                item,
                reason: messageOf(error),
              } as const),
            ),
          );
        }),
      );
    });
  }

  private observeGeneration(
    target: SpaceContentsTarget,
    generation: number,
  ): Observable<SpaceContentsSnapshot> {
    return defer(() => {
      let links: readonly SpaceChildLink[] = [];
      const rows = this.store.rooms(target.accountId);
      // Only what the snapshot shows; unread counts and previews would refetch for nothing.
      // The governance policy is signal-backed, so a power-level change re-runs this too.
      const shown = computed(
        () => ({
          rows: rows().map((room) => [
            room.roomId,
            room.membership,
            room.isSpace,
            room.displayName,
            room.avatarMxc,
          ]),
          decision: this.managementDecision(target),
        }),
        { equal: plainEqual },
      );
      const invalidations = merge(
        this.engine
          .spaceChildLinks(target.accountId, target.spaceId)
          .pipe(tap((current) => (links = current))),
        watch(shown, this.injector).pipe(skip(1)),
      );
      // Synapse allows each user a burst of 10 hierarchy reads at 5/s, and one sync batch
      // can announce many Rooms. Leading + trailing keeps the first read immediate and the
      // last event reflected while holding the rate under that budget.
      return invalidations.pipe(
        throttleTime(HIERARCHY_REFRESH_MS, asyncScheduler, {
          leading: true,
          trailing: true,
        }),
        switchMap(() => this.load(target, generation, () => links)),
      );
    });
  }

  private load(
    target: SpaceContentsTarget,
    generation: number,
    links: () => readonly SpaceChildLink[],
  ): Observable<SpaceContentsSnapshot> {
    const local = this.localSnapshot(target, links());
    if (local.availability !== 'available') return of(local);
    return this.engine
      .spaceHierarchy(target.accountId, target.spaceId, { maxPages: null })
      .pipe(
        unwrapEngineResult(),
        retryTransient(isTransientFailure),
        map((entries) => {
          if (
            this.session.status(target.accountId)?.generation !== generation
          ) {
            return this.unavailableSnapshot(target);
          }
          const current = this.localSnapshot(target, links());
          return {
            ...current,
            items: this.projectHierarchy(
              target,
              entries,
              current.curationLinks,
            ),
          };
        }),
        catchError((error: unknown) =>
          of({
            ...this.localSnapshot(target, links()),
            hierarchyError: messageOf(error),
          }),
        ),
      );
  }

  private localSnapshot(
    target: SpaceContentsTarget,
    curationLinks: readonly SpaceChildLink[],
  ): SpaceContentsSnapshot {
    const space = this.store.room(target.accountId, target.spaceId);
    const available = space?.membership === 'join' && space.isSpace;
    if (!available) return this.unavailableSnapshot(target, true);
    const decision = this.managementDecision(target);
    const linked = new Set(curationLinks.map(({ childId }) => childId));
    const directIds = new Set(
      Object.values(this.store.directMap(target.accountId)()).flat(),
    );
    const candidates = this.store
      .rooms(target.accountId)()
      .filter(
        (room) =>
          room.roomId !== target.spaceId &&
          room.membership === 'join' &&
          !linked.has(room.roomId),
      )
      .map((room): SpaceContentsCandidate => {
        const name = room.displayName;
        return {
          id: room.roomId,
          name,
          initial: initialOf(name),
          avatarMxc: room.avatarMxc,
          kind: room.isSpace ? 'space' : 'room',
          joined: true,
          via: [],
          suggested: false,
          order: '',
          direct: directIds.has(room.roomId),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
    return {
      target,
      availability: 'available',
      unavailableReason: null,
      items: [],
      curationLinks,
      candidates,
      canManage: decision.kind === 'allowed',
      managementUnavailableReason:
        decision.kind === 'rejected' ? decision.reason : null,
      hierarchyError: null,
    };
  }

  private projectHierarchy(
    target: SpaceContentsTarget,
    entries: readonly HierarchyEntry[],
    childLinks: readonly SpaceChildLink[],
  ): SpaceContentsItem[] {
    // Names and membership come from hierarchy, but curation comes from the exact
    // Account's synced room state. That state event is the authoritative echo the UI must
    // wait for before allowing another read-modify-write; a fresh hierarchy request can
    // still race the homeserver's federated hierarchy view.
    const links = new Map(childLinks.map((link) => [link.childId, link]));
    return entries
      .filter(({ roomId }) => roomId !== target.spaceId && links.has(roomId))
      .map((room) => {
        const name = room.name || room.canonicalAlias || room.roomId;
        const link = links.get(room.roomId) as SpaceChildLink;
        return {
          id: room.roomId,
          name,
          initial: initialOf(name),
          avatarMxc: room.avatarMxc,
          kind: room.isSpace ? 'space' : 'room',
          joined:
            this.store.room(target.accountId, room.roomId)?.membership ===
            'join',
          via: link.via,
          suggested: link.suggested,
          order: link.order,
        } satisfies SpaceContentsItem;
      })
      .sort(
        (a, b) =>
          compareOrder(a.order, b.order) || a.name.localeCompare(b.name),
      );
  }

  private unavailableSnapshot(
    target: SpaceContentsTarget,
    accountAvailable = false,
  ): SpaceContentsSnapshot {
    const availability: SpaceContentsAvailability = accountAvailable
      ? 'space-unavailable'
      : 'account-unavailable';
    return {
      target,
      availability,
      unavailableReason:
        availability === 'account-unavailable'
          ? 'This account is no longer available.'
          : 'This space is no longer joined for this account.',
      items: [],
      curationLinks: [],
      candidates: [],
      canManage: false,
      managementUnavailableReason:
        'Space contents cannot be managed right now.',
      hierarchyError: null,
    };
  }

  private managementDecision(
    target: SpaceContentsTarget,
  ): RoomLibraryGovernanceDecision {
    return this.governance.authorize(
      { accountId: target.accountId, roomId: target.spaceId },
      'curate-space',
    );
  }
}

/**
 * A signal's values as an observable whose effect lives only while subscribed;
 * `toObservable` would keep one per call until this root service's injector is destroyed.
 */
function watch<T>(source: Signal<T>, injector: Injector): Observable<T> {
  return new Observable<T>((subscriber) => {
    const ref = effect(
      () => {
        const value = source();
        untracked(() => subscriber.next(value));
      },
      { injector },
    );
    return () => ref.destroy();
  });
}

function isTransientFailure(error: unknown): boolean {
  return (
    error instanceof EngineRequestError &&
    ['network', 'timeout', 'rate-limit', 'server'].includes(error.failure.kind)
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
