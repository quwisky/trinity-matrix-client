import { Injectable, inject } from '@angular/core';
import { EventType, type MatrixClient } from 'matrix-js-sdk';
import { Observable, defer, from, map, switchMap, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { liveRoomState } from '@trinity/util-matrix';
import {
  compareOrder,
  isValidOrder,
  orderBetween,
  spreadOrders,
} from './space-child-order';

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
 * Writes to a space's `m.space.child` links — the curation half of Spaces.
 *
 * Separate from `SpacesService` rather than added to it: that service is past the 500-line
 * refactor threshold already, and it is a *read model* projecting sync into signals, while
 * this is a small set of one-shot writes. Splitting along that seam keeps each coherent and
 * gives the eventual full extraction somewhere to land. The read side stays where it is,
 * so nothing that consumes `spaces()` or `openSpaceChildren()` has to change.
 *
 * **Every write re-sends the whole child event.** Matrix state events are replaced, not
 * merged, so a curation write that omitted `via` would strip the routing servers and leave
 * the child unjoinable for anyone whose homeserver has not already seen it — the failure
 * this class is most careful about. {@link currentLink} reads the live state first and the
 * writes carry it forward.
 */
@Injectable({ providedIn: 'root' })
export class SpaceChildrenService {
  private readonly matrix = inject(MatrixClientService);

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

  /** Every child link currently on `spaceId`, ordered the way the spec sorts them. */
  childLinks(spaceId: string): SpaceChildLink[] {
    const state = this.spaceState(spaceId);
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
    return from(
      this.matrix.instance.sendStateEvent(
        spaceId,
        EventType.SpaceChild,
        content,
        link.childId,
      ),
    ).pipe(map(() => void 0));
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
