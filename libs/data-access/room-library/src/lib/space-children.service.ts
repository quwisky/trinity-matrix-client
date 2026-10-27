import {
  DestroyRef,
  Injectable,
  type Signal,
  inject,
  linkedSignal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  NEVER,
  Observable,
  concat,
  defer,
  last,
  map,
  of,
  switchMap,
  take,
  throwError,
} from 'rxjs';
import {
  SESSION_ENGINE,
  SessionStateService,
} from '@trinity/data-access/matrix-client';
import { plainEqual } from '@trinity/util/matrix';
import type { SpaceChildLink } from './room-list-engine';
import { ROOM_LIST_ENGINE } from './room-list-engine.token';
import { orderBetween, spreadOrders } from './space-child-order';
import {
  ROOM_LIBRARY_GOVERNANCE_POLICY,
  assertRoomLibraryGovernance,
} from './room-library-governance-policy';
import { SpaceLinkFeeds } from './space-link-feeds';
import { unwrapOwned } from './unwrap-owned';

export type { SpaceChildLink } from './room-list-engine';

/** The exact state-event values whose sync echoes complete a curation write. */
export interface SpaceChildWriteReceipt {
  readonly expectedLinks: readonly SpaceChildLink[];
}

/**
 * Live `m.space.child` links and exact-Account curation writes. Writes preserve the whole
 * link because Matrix replaces state rather than merging it.
 */
@Injectable({ providedIn: 'root' })
export class SpaceChildrenService {
  private readonly engine = inject(ROOM_LIST_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly governance = inject(ROOM_LIBRARY_GOVERNANCE_POLICY);

  private readonly feeds = new SpaceLinkFeeds(this.engine);
  private readonly watched = new Map<
    string,
    Signal<readonly SpaceChildLink[]>
  >();

  constructor() {
    // Closes the links of an Account that stopped being active or live, without a read.
    inject(SESSION_ENGINE)
      .session()
      .pipe(takeUntilDestroyed())
      .subscribe(() =>
        untracked(() => {
          const active = this.session.activeAccountId();
          this.feeds.close(
            (feed) =>
              feed.accountId !== active ||
              this.session.status(feed.accountId)?.generation !==
                feed.generation,
          );
        }),
      );
    inject(DestroyRef).onDestroy(() => this.feeds.close(() => true));
  }

  /**
   * A space's child links for the active Account, live; the read every curation surface
   * should use. Memoized per space id and seeded on first read, so a field initializer
   * sees no blank first frame.
   */
  linksFor(spaceId: string): Signal<readonly SpaceChildLink[]> {
    let links = this.watched.get(spaceId);
    if (!links) {
      links = linkedSignal<
        readonly SpaceChildLink[] | null,
        readonly SpaceChildLink[]
      >({
        source: () => {
          const accountId = this.session.activeAccountId();
          const generation = accountId
            ? this.session.status(accountId)?.generation
            : undefined;
          return accountId && generation !== undefined
            ? this.feeds.linksOf(accountId, generation, spaceId)
            : null;
        },
        // With no live Account the last links stay: mounted surfaces would render an
        // empty list as "this space has no rooms", a wrong answer.
        computation: (current, previous) => current ?? previous?.value ?? [],
        equal: plainEqual,
      }).asReadonly();
      this.watched.set(spaceId, links);
    }
    return links;
  }

  /**
   * Retained by the Room Library session lifetime. Link feeds open on first read, so this
   * only acknowledges at once.
   */
  runProjection(): Observable<void> {
    return concat(of(undefined), NEVER);
  }

  /** Read child links from one exact Account without falling through to Active Account. */
  childLinksFor(accountId: string, spaceId: string): readonly SpaceChildLink[] {
    let links: readonly SpaceChildLink[] = [];
    // shortcut: an engine that emits after subscribe reads empty here; becomes a stream
    // when SpaceContentsService reads through the engine.
    this.engine
      .spaceChildLinks(accountId, spaceId)
      .pipe(take(1))
      .subscribe((current) => (links = current));
    return links;
  }

  /**
   * Link an already-joined room into `spaceId`.
   *
   * Only the space's `m.space.child` is written, deliberately not the room's `m.space.parent`:
   * that needs power in the ROOM, which the curator often lacks, and a failure there would
   * leave the child half-linked after the link that matters succeeded. The parent event is
   * advisory; the child event is what puts the room in the space.
   */
  addExistingRoom(
    accountId: string,
    spaceId: string,
    childId: string,
  ): Observable<void> {
    return defer(() => {
      if (!this.isLive(accountId)) {
        return throwError(() => new Error('Not signed in.'));
      }
      assertRoomLibraryGovernance(
        this.governance.authorize(
          { accountId, roomId: spaceId },
          'curate-space',
        ),
      );
      return this.currentLinks(accountId, spaceId).pipe(
        switchMap((links) => {
          if (links.some((link) => link.childId === childId)) {
            // Already a child. Re-sending would be harmless but would reset any curation
            // the link already carries, so treat it as a no-op.
            return of(undefined);
          }
          const lastOrder =
            links.length > 0 ? links[links.length - 1].order : '';
          return this.engine
            .setSpaceChild(accountId, spaceId, childId, {
              via: [viaFor(accountId, childId)],
              suggested: false,
              // Appended, not inserted, so an admin's arrangement is undisturbed. A null gap
              // just means the new child sorts as unordered, which the spec puts last.
              order: orderBetween(lastOrder, '') ?? '',
            })
            .pipe(
              unwrapOwned(),
              map(() => undefined),
            );
        }),
      );
    });
  }

  /**
   * Unlink one child from an exact Account's Space without changing membership in either
   * Room. Matrix removes a child link by replacing it with an empty state event.
   */
  removeExistingRoom(
    accountId: string,
    spaceId: string,
    childId: string,
  ): Observable<void> {
    return defer(() => {
      if (!this.isLive(accountId)) {
        return throwError(() => new Error('Account unavailable.'));
      }
      assertRoomLibraryGovernance(
        this.governance.authorize(
          { accountId, roomId: spaceId },
          'curate-space',
        ),
      );
      return this.engine.setSpaceChild(accountId, spaceId, childId, null).pipe(
        unwrapOwned('Account unavailable.'),
        map(() => undefined),
      );
    });
  }

  /** Flag an exact Account's child as `suggested`, preserving its routing and order. */
  setSuggested(
    accountId: string,
    spaceId: string,
    childId: string,
    suggested: boolean,
  ): Observable<SpaceChildWriteReceipt> {
    return this.rewriteLink(accountId, spaceId, childId, (link) => ({
      ...link,
      suggested,
    }));
  }

  /**
   * Move `childId` directly before `beforeChildId`, or to the end when that is `null`.
   *
   * Normally one write: a key is minted between the two neighbours. When no such key exists
   * (neighbours with no gap, or a key another client wrote that this one cannot do arithmetic
   * against) the whole sibling list is renumbered, which is several writes; {@link spreadOrders}
   * leaves room so the next move is a single write again.
   */
  moveChildBefore(
    accountId: string,
    spaceId: string,
    childId: string,
    beforeChildId: string | null,
  ): Observable<SpaceChildWriteReceipt> {
    return defer(() => {
      if (!this.isLive(accountId)) {
        return throwError(() => new Error('Account unavailable.'));
      }
      return this.currentLinks(accountId, spaceId).pipe(
        switchMap((links) => {
          const moving = links.find((link) => link.childId === childId);
          if (!moving) {
            return throwError(
              () => new Error('That room is not in this space.'),
            );
          }
          const remaining = links.filter((link) => link.childId !== childId);
          const target = beforeChildId
            ? remaining.findIndex((link) => link.childId === beforeChildId)
            : remaining.length;
          if (target === -1) {
            return throwError(
              () => new Error('That room is not in this space.'),
            );
          }
          const prev = target > 0 ? remaining[target - 1].order : '';
          const next = target < remaining.length ? remaining[target].order : '';
          const minted = orderBetween(prev, next);
          if (minted !== null) {
            return this.writeLink(accountId, spaceId, {
              ...moving,
              order: minted,
            });
          }
          // No gap: renumber every sibling in the order they should end up in.
          const reordered = [
            ...remaining.slice(0, target),
            moving,
            ...remaining.slice(target),
          ];
          const keys = spreadOrders(reordered.length);
          return this.writeAll(
            accountId,
            spaceId,
            reordered.map((link, index) => ({ ...link, order: keys[index] })),
          );
        }),
      );
    });
  }

  private isLive(accountId: string): boolean {
    return this.session.accountIds().includes(accountId);
  }

  private currentLinks(
    accountId: string,
    spaceId: string,
  ): Observable<readonly SpaceChildLink[]> {
    return this.engine.spaceChildLinks(accountId, spaceId).pipe(take(1));
  }

  /** Read-modify-write one child link, so `via` always survives. */
  private rewriteLink(
    accountId: string,
    spaceId: string,
    childId: string,
    change: (link: SpaceChildLink) => SpaceChildLink,
  ): Observable<SpaceChildWriteReceipt> {
    return defer(() => {
      if (!this.isLive(accountId)) {
        return throwError(() => new Error('Account unavailable.'));
      }
      return this.currentLinks(accountId, spaceId).pipe(
        switchMap((links) => {
          const link = links.find((candidate) => candidate.childId === childId);
          return link
            ? this.writeLink(accountId, spaceId, change(link))
            : throwError(() => new Error('That room is not in this space.'));
        }),
      );
    });
  }

  private writeLink(
    accountId: string,
    spaceId: string,
    link: SpaceChildLink,
  ): Observable<SpaceChildWriteReceipt> {
    return defer(() => {
      assertRoomLibraryGovernance(
        this.governance.authorize(
          { accountId, roomId: spaceId },
          'curate-space',
        ),
      );
      const { childId, via, suggested, order } = link;
      return this.engine
        .setSpaceChild(accountId, spaceId, childId, {
          via: [...via],
          suggested,
          order,
        })
        .pipe(
          unwrapOwned('Account unavailable.'),
          map(() => ({ expectedLinks: [link] })),
        );
    });
  }

  /** Write links one after another, so a renumber cannot interleave with itself. */
  private writeAll(
    accountId: string,
    spaceId: string,
    links: readonly SpaceChildLink[],
  ): Observable<SpaceChildWriteReceipt> {
    return concat(
      ...links.map((link) => this.writeLink(accountId, spaceId, link)),
    ).pipe(
      last(),
      map(() => ({ expectedLinks: links })),
    );
  }
}

/**
 * The server to route a join through, preferring the child room's own server over ours.
 * A `via` naming only our homeserver is useless for a room we do not host.
 */
function viaFor(accountId: string, childId: string): string {
  const fromChild = childId.includes(':')
    ? childId.split(':').slice(1).join(':')
    : '';
  if (fromChild) {
    return fromChild;
  }
  return accountId.includes(':') ? accountId.split(':').slice(1).join(':') : '';
}
