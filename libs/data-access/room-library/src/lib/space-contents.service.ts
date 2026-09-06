import { Injectable, Injector, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  ClientEvent,
  RoomEvent,
  RoomStateEvent,
  RoomType,
  type HierarchyRoom,
  type MatrixClient,
  type MatrixEvent,
  type RoomState,
} from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  defer,
  from,
  map,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { roomAvatarMxc } from '@trinity/util/matrix';
import { directMapOf, initialOf } from './room-projection';
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
  private readonly injector = inject(Injector);

  /** Observe one immutable target and reattach if its Account client is replaced. */
  observe(target: SpaceContentsTarget): Observable<SpaceContentsSnapshot> {
    const accountIds = toObservable(this.matrix.accountIds, {
      injector: this.injector,
    });
    return accountIds.pipe(switchMap(() => this.observeCurrentClient(target)));
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

  private observeCurrentClient(
    target: SpaceContentsTarget,
  ): Observable<SpaceContentsSnapshot> {
    const client = this.matrix.clientFor(target.accountId);
    if (!client) return of(this.unavailableSnapshot(target));
    const invalidations = new Observable<void>((subscriber) => {
      const publish = (): void => subscriber.next();
      const onState = (event: MatrixEvent, state?: RoomState): void => {
        if (
          event.getRoomId() === target.spaceId ||
          state?.roomId === target.spaceId
        ) {
          publish();
        }
      };
      client.on(RoomStateEvent.Events, onState);
      client.on(ClientEvent.Room, publish);
      client.on(RoomEvent.Name, publish);
      client.on(RoomEvent.MyMembership, publish);
      publish();
      return () => {
        client.off(RoomStateEvent.Events, onState);
        client.off(ClientEvent.Room, publish);
        client.off(RoomEvent.Name, publish);
        client.off(RoomEvent.MyMembership, publish);
      };
    });
    return invalidations.pipe(switchMap(() => this.load(target, client)));
  }

  private load(
    target: SpaceContentsTarget,
    client: MatrixClient,
  ): Observable<SpaceContentsSnapshot> {
    const local = this.localSnapshot(target, client);
    if (local.availability !== 'available') return of(local);
    return from(fetchHierarchyRooms(client, target.spaceId)).pipe(
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
          ? 'This Account is no longer available.'
          : 'This Space is no longer joined for the opening Account.',
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
