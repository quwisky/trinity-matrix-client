import { signal, untracked } from '@angular/core';
import { Subscription } from 'rxjs';
import type {
  RoomInfo,
  RoomListEngine,
  SpaceChildLink,
} from './room-list-engine';
import { compareOrder } from './space-child-order';

/** One open `spaceChildLinks` subscription and the links it last emitted. */
export interface LinkFeed {
  readonly key: string;
  readonly accountId: string;
  readonly generation: number;
  links: readonly SpaceChildLink[];
  subscription: Subscription;
}

/** The key of one Account generation's links of one space. */
export function linkKey(
  accountId: string,
  generation: number,
  spaceId: string,
): string {
  return JSON.stringify([accountId, generation, spaceId]);
}

/**
 * Space child-link subscriptions keyed by Account, its generation and the space, opened on
 * first read. Their owner closes them; nothing here closes on its own.
 */
export class SpaceLinkFeeds {
  private readonly feeds = new Map<string, LinkFeed>();
  /** Bumped by link emissions after the first, which arrive outside any reactive read. */
  private readonly version = signal(0);
  private opening = false;

  constructor(private readonly engine: RoomListEngine) {}

  /** The links last emitted for one space, subscribing on first read. */
  linksOf(
    accountId: string,
    generation: number,
    spaceId: string,
  ): readonly SpaceChildLink[] {
    this.version();
    return untracked(() => {
      const key = linkKey(accountId, generation, spaceId);
      let feed = this.feeds.get(key);
      if (!feed) {
        const opened: LinkFeed = {
          key,
          accountId,
          generation,
          links: [],
          subscription: Subscription.EMPTY,
        };
        this.feeds.set(key, opened);
        this.opening = true;
        try {
          opened.subscription = this.engine
            .spaceChildLinks(accountId, spaceId)
            .subscribe((links) => {
              opened.links = links;
              if (!this.opening) this.version.update((v) => v + 1);
            });
        } finally {
          this.opening = false;
        }
        feed = opened;
      }
      return feed.links;
    });
  }

  close(predicate: (feed: LinkFeed) => boolean): void {
    for (const [key, feed] of this.feeds) {
      if (!predicate(feed)) continue;
      feed.subscription.unsubscribe();
      this.feeds.delete(key);
    }
  }
}

/**
 * A space's joined child ids, ordered by link `order` (code point, unordered last) then room
 * name — not the engine's child-id tie-break, which would reorder the rail.
 */
export function joinedChildIds(
  links: readonly SpaceChildLink[],
  joined: ReadonlyMap<string, RoomInfo>,
): string[] {
  return links
    .flatMap((link) => {
      const child = joined.get(link.childId);
      return child ? [{ link, name: child.displayName }] : [];
    })
    .sort(
      (a, b) =>
        compareOrder(a.link.order, b.link.order) ||
        a.name.localeCompare(b.name),
    )
    .map((entry) => entry.link.childId);
}
