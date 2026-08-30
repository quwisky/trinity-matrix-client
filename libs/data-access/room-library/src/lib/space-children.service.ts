import {
  Injectable,
  type Signal,
  type WritableSignal,
  inject,
  signal,
} from '@angular/core';
import {
  EventType,
  type MatrixClient,
  type MatrixEvent,
  type RoomState,
  RoomStateEvent,
} from 'matrix-js-sdk';
import { Observable, defer, from, map, switchMap, throwError } from 'rxjs';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import { liveRoomState } from '@trinity/util/matrix';
import {
  compareOrder,
  isValidOrder,
  orderBetween,
  spreadOrders,
} from './space-child-order';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  assertRoomLibraryGovernance,
} from './room-library-governance-policy';

/** The `m.space.child` content this client writes and reads back. */
interface SpaceChildContent {
  via: string[];
  suggested?: boolean;
  order?: string;
}

/** A child link as it currently stands, for deciding what a curation write should say. */
export interface SpaceChildLink {
  childId: string;
  via: string[];
  suggested: boolean;
  order: string;
}

/**
 * A space's `m.space.child` links — the curation half of Spaces: a live read model
 * ({@link linksFor}) plus the writes that change it.
 *
 * Separate from `SpacesService` rather than added to it: that service is past the 500-line
 * refactor threshold already, and its read surfaces answer different questions —
 * `spaces().childRoomIds` is joined-children-only and carries no `suggested`/`via`, and
 * `openSpaceChildren()` comes from the `/hierarchy` network fetch, which no state listener
 * re-fetches and which is therefore stale for curation changes by construction. Neither can
 * drive a curation UI, which needs every link exactly as the space's state has it.
 *
 * **Every write re-sends the whole child event.** Matrix state events are replaced, not
 * merged, so a curation write that omitted `via` would strip the routing servers and leave
 * the child unjoinable for anyone whose homeserver has not already seen it — the failure
 * this class is most careful about. {@link currentLink} reads the live state first and the
 * writes carry it forward.
 *
 * **The writes deliberately keep reading live state, not {@link linksFor}.** They are
 * read-modify-write against what the SDK holds *now*, and they must stay correct before
 * anything has called {@link connect} — a dialog opened from a menu writes on its first
 * interaction.
 */
@Injectable({ providedIn: 'root' })
export class SpaceChildrenService {
  private readonly matrix = inject(MatrixClientService);
  private readonly governance = inject(ROOM_LIBRARY_GOVERNANCE_POLICY);

  /** One signal per space whose links someone is watching, keyed by space id. */
  private readonly links = new Map<
    string,
    WritableSignal<readonly SpaceChildLink[]>
  >();

  /**
   * Every state event in every room flows through here, so filter hard: to `m.space.child`,
   * and to a space someone is actually watching. Scheduling for an unwatched room would
   * rebuild every watched one for nothing.
   *
   * Bound by hand rather than listed in `events` because the handler has to read the event
   * to tell a child link from every other state change.
   */
  private readonly onStateEvent = (event: MatrixEvent): void => {
    const roomId = event.getRoomId();
    if (
      event.getType() === EventType.SpaceChild &&
      roomId &&
      this.links.has(roomId)
    ) {
      // Through the projection's scheduler so a reorder — which `writeAll` sends as one
      // state event PER SIBLING — echoes back as a single rebuild.
      this.projection.schedule();
    }
  };

  private readonly projection = projectFromClient({
    id: 'rooms.space-children',
    matrix: this.matrix,
    bind: (client) => client.on(RoomStateEvent.Events, this.onStateEvent),
    unbind: (client) => client.off(RoomStateEvent.Events, this.onStateEvent),
    // Takes the `client` argument rather than re-reading `matrix.instance`: a rebuild
    // coalesced from account A's events can drain after the active client is already B.
    // (Most services here still re-read the instance; project-from-client.ts says new
    // code should not.)
    rebuild: (client) => {
      for (const [spaceId, state] of this.links) {
        state.set(readLinksFrom(client, spaceId));
      }
    },
    // No `reset`: disconnect must NOT clear these. The surfaces holding them are still
    // mounted, and an empty list renders as "this space has no rooms" — a wrong answer
    // rather than a missing one. The last known links are the honest thing to show until
    // a reconnect re-seeds them.
  });

  /**
   * A space's child links, live — the read every curation surface should use.
   *
   * Memoized per space id, so several surfaces watching one space share a signal, and
   * seeded synchronously from current state so a caller may read it in a field initializer
   * without a blank first frame.
   */
  linksFor(spaceId: string): Signal<readonly SpaceChildLink[]> {
    let state = this.links.get(spaceId);
    if (!state) {
      state = signal<readonly SpaceChildLink[]>(
        readLinksFrom(this.readClient(), spaceId),
        // Structural: an `m.space.child` write that changes nothing this projection
        // exposes (or a rebuild triggered by a sibling space) must not tick consumers.
        { equal: sameLinks },
      );
      this.links.set(spaceId, state);
    }
    return state.asReadonly();
  }

  /**
   * Attach the state listener and seed every watched space. Idempotent per client;
   * re-running after a re-login rewires onto the new one.
   */
  connect(): void {
    this.projection.connect();
  }

  /** Detach the state listener. Watched signals keep their last value — see the projection. */
  disconnect(): void {
    this.projection.disconnect();
  }

  /**
   * The client to read through: the one the listeners are on, falling back to the active
   * instance so {@link linksFor} still seeds before {@link connect}.
   */
  private readClient(): MatrixClient | null {
    return (
      this.projection.client() ??
      (this.matrix.isInitialized ? this.matrix.instance : null)
    );
  }

  /**
   * Whether the signed-in user may curate `spaceId` — i.e. send `m.space.child` in it.
   *
   * Derived from live power levels the same way `RoomSettingsService.editableFields` is,
   * so the UI can hide curation controls rather than offering actions the server rejects.
   */
  canCurate(spaceId: string): boolean {
    const state = this.spaceState(spaceId);
    const userId = this.matrix.isInitialized
      ? this.matrix.instance.getUserId()
      : null;
    if (!state || !userId) {
      return false;
    }
    return !!state.maySendStateEvent(EventType.SpaceChild, userId);
  }

  /**
   * Every child link currently on `spaceId`, read straight from live state.
   *
   * The write paths' read half. A surface that renders links wants {@link linksFor}.
   */
  childLinks(spaceId: string): SpaceChildLink[] {
    return readChildLinks(this.spaceState(spaceId));
  }

  /** The current link for one child, or `null` when it is not in the space. */
  currentLink(spaceId: string, childId: string): SpaceChildLink | null {
    return (
      this.childLinks(spaceId).find((link) => link.childId === childId) ?? null
    );
  }

  /**
   * Link an already-joined room into `spaceId`.
   *
   * The counterpart of `SpacesService.removeRoomFromSpace`, and the reason a room no
   * longer has to be *born* in a space to belong to one.
   *
   * Only the space's `m.space.child` is written — deliberately not the room's
   * `m.space.parent`. That second event needs power in the ROOM, which the person
   * curating a space very often does not have, and a failure there would leave the child
   * half-linked after the link that matters had already succeeded. The parent event is
   * advisory; the child event is what puts the room in the space.
   */
  addExistingRoom(spaceId: string, childId: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      assertRoomLibraryGovernance(
        this.governance.authorize(spaceId, 'curate-space'),
      );
      const client = this.matrix.instance;
      if (this.currentLink(spaceId, childId)) {
        // Already a child. Re-sending would be harmless but would reset any curation the
        // link already carries, so treat it as a no-op.
        return from(Promise.resolve()).pipe(map(() => void 0));
      }
      const links = this.childLinks(spaceId);
      const last = links.length > 0 ? links[links.length - 1].order : '';
      const content: SpaceChildContent = {
        via: [viaFor(client, childId)],
        // Appended, not inserted: adding a room should not disturb an admin's existing
        // arrangement. A null gap here just means the new child sorts as unordered, which
        // the spec already puts last — exactly where it belongs.
        ...(orderBetween(last, '')
          ? { order: orderBetween(last, '') as string }
          : {}),
      };
      return from(
        client.sendStateEvent(spaceId, EventType.SpaceChild, content, childId),
      ).pipe(map(() => void 0));
    });
  }

  /** Flag (or unflag) a child as `suggested`, preserving its routing and order. */
  setSuggested(
    spaceId: string,
    childId: string,
    suggested: boolean,
  ): Observable<void> {
    return this.rewriteLink(spaceId, childId, (link) => ({
      ...link,
      suggested,
    }));
  }

  /**
   * Move `childId` so it sits directly before `beforeChildId` in the space's arrangement,
   * or at the end when that is `null`.
   *
   * One write in the ordinary case: a key is minted strictly between the two children the
   * moved one lands among, and nothing else is touched. When no such key can exist —
   * neighbouring keys with no gap, or a key some other client wrote that this one cannot
   * do arithmetic against — the whole sibling list is renumbered instead, which is several
   * writes but is the only way to make room. {@link spreadOrders} spaces the new keys out
   * so the next move is a single write again.
   */
  moveChildBefore(
    spaceId: string,
    childId: string,
    beforeChildId: string | null,
  ): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      const links = this.childLinks(spaceId);
      const moving = links.find((link) => link.childId === childId);
      if (!moving) {
        return throwError(() => new Error('That room is not in this space.'));
      }
      const remaining = links.filter((link) => link.childId !== childId);
      const target = beforeChildId
        ? remaining.findIndex((link) => link.childId === beforeChildId)
        : remaining.length;
      if (target === -1) {
        return throwError(() => new Error('That room is not in this space.'));
      }
      const prev = target > 0 ? remaining[target - 1].order : '';
      const next = target < remaining.length ? remaining[target].order : '';
      const minted = orderBetween(prev, next);
      if (minted !== null) {
        return this.writeLink(spaceId, { ...moving, order: minted });
      }
      // No gap: renumber every sibling in the order they should end up in.
      const reordered = [
        ...remaining.slice(0, target),
        moving,
        ...remaining.slice(target),
      ];
      const keys = spreadOrders(reordered.length);
      return this.writeAll(
        spaceId,
        reordered.map((link, index) => ({ ...link, order: keys[index] })),
      );
    });
  }

  /** Read-modify-write one child link, so `via` always survives. */
  private rewriteLink(
    spaceId: string,
    childId: string,
    change: (link: SpaceChildLink) => SpaceChildLink,
  ): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      const link = this.currentLink(spaceId, childId);
      if (!link) {
        return throwError(() => new Error('That room is not in this space.'));
      }
      return this.writeLink(spaceId, change(link));
    });
  }

  private writeLink(spaceId: string, link: SpaceChildLink): Observable<void> {
    const content: SpaceChildContent = {
      via: link.via,
      ...(link.suggested ? { suggested: true } : {}),
      ...(link.order ? { order: link.order } : {}),
    };
    return defer(() => {
      assertRoomLibraryGovernance(
        this.governance.authorize(spaceId, 'curate-space'),
      );
      return from(
        this.matrix.instance.sendStateEvent(
          spaceId,
          EventType.SpaceChild,
          content,
          link.childId,
        ),
      ).pipe(map(() => void 0));
    });
  }

  /** Write links one after another, so a renumber cannot interleave with itself. */
  private writeAll(
    spaceId: string,
    links: readonly SpaceChildLink[],
  ): Observable<void> {
    return links.reduce<Observable<void>>(
      (chain, link) =>
        chain.pipe(switchMap(() => this.writeLink(spaceId, link))),
      from(Promise.resolve()).pipe(map(() => void 0)),
    );
  }

  private spaceState(spaceId: string) {
    if (!this.matrix.isInitialized) {
      return null;
    }
    const room = this.matrix.instance.getRoom(spaceId);
    return room ? liveRoomState(room) : null;
  }
}

/**
 * The child links a space's state currently declares, ordered the way the spec sorts them.
 *
 * Kept here rather than in `room-projection.ts` beside `spaceChildIdsOf`: it has one owner,
 * so the move would buy no reuse, and it would park this spec-correct code-point
 * {@link compareOrder} next to that file's `localeCompare` — an invitation to "unify" them
 * and change visible sidebar ordering as a side effect.
 */
function readChildLinks(state: RoomState | null | undefined): SpaceChildLink[] {
  if (!state) {
    return [];
  }
  return (
    state
      .getStateEvents(EventType.SpaceChild)
      .map((event) => {
        const content = event.getContent();
        const via = Array.isArray(content['via'])
          ? (content['via'] as unknown[]).filter(
              (server): server is string => typeof server === 'string',
            )
          : [];
        const order =
          typeof content['order'] === 'string' ? content['order'] : '';
        return {
          childId: event.getStateKey() ?? '',
          via,
          suggested: content['suggested'] === true,
          // An order the spec rejects must be treated as no order at all, or this client
          // sorts by a key every other client ignores.
          order: isValidOrder(order) ? order : '',
        };
      })
      // An empty `via` is the spec's tombstone for a removed child, not a live link.
      .filter((link) => link.childId && link.via.length > 0)
      .sort(
        (a, b) =>
          compareOrder(a.order, b.order) || (a.childId < b.childId ? -1 : 1),
      )
  );
}

/** The links a space declares right now, or none when the room is unknown. */
function readLinksFrom(
  client: MatrixClient | null,
  spaceId: string,
): SpaceChildLink[] {
  const room = client?.getRoom(spaceId);
  return readChildLinks(room ? liveRoomState(room) : undefined);
}

/**
 * Whether two link lists say the same thing, so an unrelated rebuild does not tick every
 * consumer. Compares `via` element-wise: it is what keeps a child joinable, so a change
 * there matters even though nothing renders it.
 */
function sameLinks(
  a: readonly SpaceChildLink[],
  b: readonly SpaceChildLink[],
): boolean {
  return (
    a.length === b.length &&
    a.every((link, index) => {
      const other = b[index];
      return (
        link.childId === other.childId &&
        link.suggested === other.suggested &&
        link.order === other.order &&
        link.via.length === other.via.length &&
        link.via.every((server, i) => server === other.via[i])
      );
    })
  );
}

/**
 * The server to route a join through, preferring the child room's own server over ours.
 * A `via` naming only our homeserver is useless for a room we do not host.
 */
function viaFor(client: MatrixClient, childId: string): string {
  const fromChild = childId.includes(':')
    ? childId.split(':').slice(1).join(':')
    : '';
  if (fromChild) {
    return fromChild;
  }
  const userId = client.getUserId() ?? '';
  return userId.includes(':') ? userId.split(':').slice(1).join(':') : '';
}
