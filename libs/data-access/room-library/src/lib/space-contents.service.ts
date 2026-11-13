import { Injectable, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  ClientEvent,
  RoomEvent,
  RoomStateEvent,
  RoomType,
  type HierarchyRoom,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomState,
} from 'matrix-js-sdk';
import {
  Observable,
  asyncScheduler,
  catchError,
  defer,
  filter,
  map,
  merge,
  of,
  scan,
  share,
  switchMap,
  throttleTime,
  throwError,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { initialOf, retryTransient, roomAvatarMxc } from '@trinity/util/matrix';
import { directMapOf } from './room-projection';
import { RoomLibraryService } from './room-library.service';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  assertRoomLibraryGovernance,
  type RoomLibraryGovernanceDecision,
} from './room-library-governance-policy';
import {
  SpaceChildrenService,
  type SpaceChildLink,
  type SpaceChildWriteReceipt,
} from './space-children.service';
import { compareOrder } from './space-child-order';
import { SpacesService } from './spaces.service';

const HIERARCHY_LIMIT = 100;
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
  private readonly matrix = inject(MatrixClientService);
  private readonly governance = inject(ROOM_LIBRARY_GOVERNANCE_POLICY);
  private readonly rooms = inject(RoomLibraryService);
  private readonly spaces = inject(SpacesService);
  private readonly children = inject(SpaceChildrenService);
  // Created once: a `toObservable` per `observe()` would outlive its subscriber until this
  // root service is destroyed.
  private readonly accountIds$ = toObservable(this.matrix.accountIds);

  /** Observe one immutable target and reattach if its Account client is replaced. */
  observe(target: SpaceContentsTarget): Observable<SpaceContentsSnapshot> {
    return this.accountIds$.pipe(
      switchMap(() => this.observeCurrentClient(target)),
    );
  }

  /** Read the latest hierarchy once, for explicit retry and post-command refresh. */
  read(target: SpaceContentsTarget): Observable<SpaceContentsSnapshot> {
    return defer(() => {
      const client = this.matrix.clientFor(target.accountId);
      return client
        ? this.load(target, client)
        : of(this.unavailableSnapshot(target));
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

  /**
   * Move one child in the shared Space order through the immutable target. `shownOrder` is
   * the list the move was chosen from, which places the children that have no order.
   */
  moveChildBefore(
    target: SpaceContentsTarget,
    childId: string,
    beforeChildId: string | null,
    shownOrder: readonly string[],
  ): Observable<SpaceChildWriteReceipt> {
    return defer(() =>
      this.children.moveChildBefore(
        target.accountId,
        target.spaceId,
        childId,
        beforeChildId,
        shownOrder,
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

  private observeCurrentClient(
    target: SpaceContentsTarget,
  ): Observable<SpaceContentsSnapshot> {
    const client = this.matrix.clientFor(target.accountId);
    if (!client) return of(this.unavailableSnapshot(target));
    // true: the Space or one of its linked children changed, so its hierarchy is read
    // again. Any other Room only changes the local candidates.
    const invalidations = new Observable<boolean>((subscriber) => {
      const onState = (event: MatrixEvent, state?: RoomState): void => {
        if (
          event.getRoomId() === target.spaceId ||
          state?.roomId === target.spaceId
        ) {
          subscriber.next(true);
        }
      };
      const onRoom = (room: Room): void =>
        subscriber.next(
          room.roomId === target.spaceId ||
            this.children
              .childLinksFor(target.accountId, target.spaceId)
              .some(({ childId }) => childId === room.roomId),
        );
      client.on(RoomStateEvent.Events, onState);
      client.on(ClientEvent.Room, onRoom);
      client.on(RoomEvent.Name, onRoom);
      client.on(RoomEvent.MyMembership, onRoom);
      subscriber.next(true);
      return () => {
        client.off(RoomStateEvent.Events, onState);
        client.off(ClientEvent.Room, onRoom);
        client.off(RoomEvent.Name, onRoom);
        client.off(RoomEvent.MyMembership, onRoom);
      };
    }).pipe(share());
    // Synapse allows each user a burst of 10 hierarchy reads at 5/s, and one sync batch
    // can announce many Rooms. Leading + trailing keeps the first read immediate and the
    // last event reflected while holding the rate under that budget.
    const hierarchy = invalidations.pipe(
      filter(Boolean),
      throttleTime(HIERARCHY_REFRESH_MS, asyncScheduler, {
        leading: true,
        trailing: true,
      }),
      switchMap(() => this.load(target, client)),
    );
    // A sync batch can announce many unrelated Rooms; rebuild the candidates once per burst.
    const local = invalidations.pipe(
      filter((refetch) => !refetch),
      throttleTime(HIERARCHY_REFRESH_MS, asyncScheduler, {
        leading: true,
        trailing: true,
      }),
      map(() => null),
    );
    return merge(hierarchy, local).pipe(
      scan<SpaceContentsSnapshot | null, SpaceContentsSnapshot | null>(
        (last, next) => next ?? (last && this.refreshLocal(last, client)),
        null,
      ),
      filter((snapshot) => snapshot !== null),
    );
  }

  /** Rebuild the local parts of a snapshot, keeping the hierarchy it last read. */
  private refreshLocal(
    last: SpaceContentsSnapshot,
    client: MatrixClient,
  ): SpaceContentsSnapshot {
    const local = this.localSnapshot(last.target, client);
    return local.availability === 'available'
      ? { ...local, items: last.items, hierarchyError: last.hierarchyError }
      : local;
  }

  private load(
    target: SpaceContentsTarget,
    client: MatrixClient,
  ): Observable<SpaceContentsSnapshot> {
    const local = this.localSnapshot(target, client);
    if (local.availability !== 'available') return of(local);
    return defer(() => fetchHierarchyRooms(client, target.spaceId)).pipe(
      retryTransient(),
      map((rooms) => {
        if (this.matrix.clientFor(target.accountId) !== client) {
          return this.unavailableSnapshot(target);
        }
        const current = this.localSnapshot(target, client);
        return {
          ...current,
          items: projectHierarchy(
            target.spaceId,
            client,
            rooms,
            current.curationLinks,
          ),
        };
      }),
      catchError((error: unknown) =>
        of({
          ...this.localSnapshot(target, client),
          hierarchyError: messageOf(error),
        }),
      ),
    );
  }

  private localSnapshot(
    target: SpaceContentsTarget,
    client: MatrixClient,
  ): SpaceContentsSnapshot {
    const space = client.getRoom(target.spaceId);
    const available =
      space?.getMyMembership() === 'join' && space.isSpaceRoom();
    if (!available) return this.unavailableSnapshot(target, Boolean(client));
    const decision = this.managementDecision(target);
    const curationLinks = this.children.childLinksFor(
      target.accountId,
      target.spaceId,
    );
    const linked = new Set(curationLinks.map(({ childId }) => childId));
    const { ids: directIds } = directMapOf(client);
    const candidates = client
      .getRooms()
      .filter(
        (room) =>
          room.roomId !== target.spaceId &&
          room.getMyMembership() === 'join' &&
          !linked.has(room.roomId),
      )
      .map((room): SpaceContentsCandidate => {
        const direct = directIds.has(room.roomId);
        const name = room.name || room.roomId;
        return {
          id: room.roomId,
          name,
          initial: initialOf(name),
          avatarMxc: roomAvatarMxc(room, direct),
          kind: room.isSpaceRoom() ? 'space' : 'room',
          joined: true,
          via: [],
          suggested: false,
          order: '',
          direct,
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

async function fetchHierarchyRooms(
  client: MatrixClient,
  spaceId: string,
): Promise<HierarchyRoom[]> {
  const rooms: HierarchyRoom[] = [];
  const seenTokens = new Set<string>();
  let fromToken: string | undefined;
  for (;;) {
    const response = await client.getRoomHierarchy(
      spaceId,
      HIERARCHY_LIMIT,
      1,
      false,
      fromToken,
    );
    rooms.push(...response.rooms);
    if (!response.next_batch) break;
    if (seenTokens.has(response.next_batch)) {
      throw new Error('The Space hierarchy returned a repeated page token.');
    }
    seenTokens.add(response.next_batch);
    fromToken = response.next_batch;
  }
  return rooms;
}

function projectHierarchy(
  spaceId: string,
  client: MatrixClient,
  rooms: readonly HierarchyRoom[],
  childLinks: readonly SpaceChildLink[],
): SpaceContentsItem[] {
  // Names and membership come from hierarchy, but curation comes from the exact
  // Account's synced room state. That state event is the authoritative echo the UI must
  // wait for before allowing another read-modify-write; a fresh hierarchy request can
  // still race the homeserver's federated hierarchy view.
  const links = new Map(childLinks.map((link) => [link.childId, link]));
  return rooms
    .filter(({ room_id }) => room_id !== spaceId && links.has(room_id))
    .map((room) => {
      const name = room.name || room.canonical_alias || room.room_id;
      const link = links.get(room.room_id) as SpaceChildLink;
      return {
        item: {
          id: room.room_id,
          name,
          initial: initialOf(name),
          avatarMxc: room.avatar_url ?? null,
          kind: room.room_type === RoomType.Space ? 'space' : 'room',
          joined: client.getRoom(room.room_id)?.getMyMembership() === 'join',
          via: link.via,
          suggested: link.suggested,
          order: link.order,
        } satisfies SpaceContentsItem,
        order: link.order,
      };
    })
    .sort(
      (a, b) =>
        compareOrder(a.order, b.order) ||
        a.item.name.localeCompare(b.item.name),
    )
    .map(({ item }) => item);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
