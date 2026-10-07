import { Injectable, inject } from '@angular/core';
import {
  Observable,
  catchError,
  defer,
  from,
  map,
  of,
  shareReplay,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { fetchMediaBytes } from '@trinity/util/matrix';

/** Default avatar edge (px) requested from the server thumbnailer. */
const AVATAR_PX = 96;
/** Oversample the thumbnail so small avatars stay sharp on hi-DPI screens. */
const DPR = 2;

/**
 * Resolves `mxc://` avatars to `blob:` URLs the UI can bind to `<img>`, fetching
 * with the access token so they load on authenticated-media (v1.11+) homeservers —
 * a plain `<img src=mxcUrlToHttp(...)>` can't send the bearer header and 401s there.
 *
 * We always attempt the authenticated endpoint and rely on {@link fetchMediaBytes}'s
 * built-in authed→legacy fallback, rather than probing `v1.11` first: a probe that
 * transiently failed would cache `authed=false` and then break every avatar on the
 * very authenticated-media-only servers this exists for.
 *
 * Avatars are small and reused across the app (sidebar, members, every timeline
 * sender), so successful resolutions are cached keyed by mxc+size+account and revoked
 * together on logout/login ({@link releaseAll}). Within a session the cache is an LRU
 * capped at {@link AVATAR_CACHE_LIMIT}; evicting revokes the object URL, but never one a
 * subscriber still holds (see {@link CacheEntry.holders}).
 *
 * A failure is remembered only for {@link FAILURE_COOLDOWN_MS}. Never remembering it
 * pins nothing to initials for the session — the original reason — but it also means a
 * list that recreates its rows as you scroll starts a fresh attempt per row per
 * recreation, and each attempt is now several requests with backoff behind it. While a
 * device is offline that is a stampede against a network that is not there. Retrying
 * after a short pause keeps both properties: the avatar recovers on its own, and it
 * costs one attempt per avatar per cooldown rather than one per render.
 */
/** How long a failed avatar resolution is remembered before it may be retried. */
const FAILURE_COOLDOWN_MS = 30_000;

/**
 * Cap on cached avatar object URLs. What one screen shows at once: a timeline window of
 * roughly 40 rows (viewport plus 800px overscan) with at most as many distinct senders, a
 * virtualised member list of ~50 rows, a sidebar of ~100 room and space rows, and a handful
 * of account badges. That is about 200 at the very most, and those are held by their
 * subscribers regardless of the cap. 256 therefore keeps every avatar a user flicks between
 * warm, while bounding a long session (hundreds of rooms and members seen) at 256 thumbnails
 * of ~10-30 KB each, a few MB, instead of one per avatar ever seen.
 */
const AVATAR_CACHE_LIMIT = 256;

interface CacheEntry {
  /** Shared fetch+blob, replayed to every subscriber. */
  readonly resolved: Observable<string | null>;
  /** The object URL once resolved; null while in flight or after a failure. */
  url: string | null;
  /** Subscribers currently showing this entry's URL; it is never evicted while above 0. */
  holders: number;
}

@Injectable({ providedIn: 'root' })
export class AvatarService {
  private readonly matrix = inject(MatrixClientService);

  /** Resolutions keyed by `mxc|size|account`, least recently used first. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Keys that failed, and the moment (ms epoch) they may be attempted again. */
  private readonly retryAfter = new Map<string, number>();

  /**
   * Resolve an `mxc://` avatar to a cached `blob:` URL, or null when unset/failed.
   *
   * Each subscription looks the entry up afresh, so an entry evicted since the last
   * subscribe is fetched again instead of replaying a revoked URL. The subscription holds
   * the entry for as long as it stays subscribed (the avatar component keeps it until the
   * input changes or it is destroyed) and, to keep that hold alive, never completes: a
   * completing observable would release the hold the moment the URL arrived.
   */
  resolve(
    mxc: string | null,
    sizePx = AVATAR_PX,
    accountId?: string,
  ): Observable<string | null> {
    if (!mxc) {
      return of(null);
    }
    // Key by account too: the same mxc fetched through a different homeserver is a
    // different request, and sharing one entry would defeat the point of routing a
    // foreign account's media through its own client.
    const key = `${mxc}|${sizePx}|${accountId ?? ''}`;
    return new Observable<string | null>((subscriber) => {
      const entry = this.entryFor(key, mxc, sizePx, accountId);
      if (!entry) {
        subscriber.next(null); // still cooling off — show the initial without another attempt
        return;
      }
      entry.holders++;
      const sub = entry.resolved.subscribe({
        next: (url) => subscriber.next(url),
      });
      return () => {
        sub.unsubscribe();
        entry.holders--;
        this.evict();
      };
    });
  }

  /** Upload avatar bytes through the owning Account's media repository. */
  upload(file: File, accountId: string): Observable<string> {
    return defer(() => {
      const client = this.matrix.clientFor(accountId);
      if (!client) {
        throw new Error('The owning account is no longer available.');
      }
      return from(
        client.uploadContent(file, {
          name: file.name,
          type: file.type || 'application/octet-stream',
        }),
      ).pipe(map((response) => response.content_uri));
    });
  }

  /** Revoke every cached avatar object URL and clear the cache (logout/login). */
  releaseAll(): void {
    for (const { url } of this.cache.values()) {
      if (url) {
        URL.revokeObjectURL(url);
      }
    }
    this.cache.clear();
    // A new session may be a different account on a different homeserver, so nothing
    // that failed under the old one should still be serving initials from a cooldown.
    this.retryAfter.clear();
  }

  /** Revoke every resolved avatar no subscriber is showing (the app went to the background). */
  releaseUnpinned(): void {
    for (const [key, entry] of this.cache) {
      if (entry.url && entry.holders === 0) {
        this.cache.delete(key);
        URL.revokeObjectURL(entry.url);
      }
    }
  }

  /** The live entry for a key (touched as most recent), a new fetch, or null in cooldown. */
  private entryFor(
    key: string,
    mxc: string,
    sizePx: number,
    accountId: string | undefined,
  ): CacheEntry | null {
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key);
      this.cache.set(key, hit);
      return hit;
    }
    const coolingUntil = this.retryAfter.get(key);
    if (coolingUntil !== undefined) {
      if (Date.now() < coolingUntil) {
        return null;
      }
      this.retryAfter.delete(key);
    }
    const edge = Math.ceil(sizePx * DPR);
    const client =
      (accountId ? this.matrix.clientFor(accountId) : null) ??
      this.matrix.instance;
    const entry: CacheEntry = {
      url: null,
      holders: 0,
      resolved: fetchMediaBytes(client, mxc, { w: edge, h: edge }, true).pipe(
        map((bytes) => {
          // releaseAll cannot cancel a fetch already in flight. If this one lands after
          // it, the entry is no longer cached, so no later releaseAll or eviction would
          // ever find its URL: don't create one.
          if (this.cache.get(key) !== entry) {
            return null;
          }
          entry.url = URL.createObjectURL(new Blob([bytes]));
          this.evict();
          return entry.url;
        }),
        // An avatar is decorative — on failure fall back to initials (null), and drop the
        // cache entry so a transient failure can be retried, but not before the cooldown.
        catchError(() => {
          // A failure from a released entry says nothing about a newer one for this key.
          if (this.cache.get(key) === entry) {
            this.cache.delete(key);
            this.retryAfter.set(key, Date.now() + FAILURE_COOLDOWN_MS);
          }
          return of<string | null>(null);
        }),
        shareReplay(1),
      ),
    };
    this.cache.set(key, entry);
    return entry;
  }

  /** Revoke least recently used unheld URLs until at most {@link AVATAR_CACHE_LIMIT} remain. */
  private evict(): void {
    let resolved = 0;
    for (const { url } of this.cache.values()) {
      resolved += url ? 1 : 0;
    }
    for (const [key, entry] of this.cache) {
      if (resolved <= AVATAR_CACHE_LIMIT) {
        return;
      }
      if (entry.url && entry.holders === 0) {
        this.cache.delete(key);
        URL.revokeObjectURL(entry.url);
        resolved--;
      }
    }
  }
}
