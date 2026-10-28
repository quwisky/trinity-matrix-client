import { Injectable, inject, untracked } from '@angular/core';
import {
  Observable,
  catchError,
  defer,
  filter,
  from,
  map,
  of,
  shareReplay,
  switchMap,
} from 'rxjs';
import { unwrapEngineResult } from '@trinity/util/matrix';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { MEDIA_ENGINE } from './media-engine.token';
import { withoutImageMetadata } from './image-metadata/strip-file-metadata';

/** Default avatar edge (px) requested from the server thumbnailer. */
const AVATAR_PX = 96;
/** Oversample the thumbnail so small avatars stay sharp on hi-DPI screens. */
const DPR = 2;

/**
 * Resolves `mxc://` avatars to URLs the UI can bind to `<img>`, through the media engine: a
 * plain `<img src=mxcUrlToHttp(...)>` can't send the bearer header and 401s on
 * authenticated-media (v1.11+) homeservers.
 *
 * Resolutions are cached by mxc+size+account and released together on logout/login
 * ({@link releaseAll}); within a session the cache is an LRU capped at
 * {@link AVATAR_CACHE_LIMIT}. Evicting releases the URL, but never one a subscriber
 * still holds (see {@link CacheEntry.holders}).
 *
 * A failure is remembered only for {@link FAILURE_COOLDOWN_MS}. Forgetting it at once would
 * start several backed-off requests per row per recreation in a scrolling list, a stampede
 * while offline; remembering it for good would pin the avatar to initials for the session.
 * The pause lets it recover on its own at one attempt per avatar per cooldown.
 */
/** How long a failed avatar resolution is remembered before it may be retried. */
const FAILURE_COOLDOWN_MS = 30_000;

/**
 * Cap on cached avatar object URLs. One screen shows about 200 at most (a ~40-row timeline
 * window, ~50 member rows, ~100 sidebar rows, a few account badges) and subscribers hold
 * those regardless of the cap. 256 keeps every avatar a user flicks between warm while
 * bounding a long session at a few MB (256 thumbnails of ~10-30 KB).
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
  private readonly engine = inject(MEDIA_ENGINE);
  private readonly session = inject(SessionStateService);

  /** Resolutions keyed by `mxc|size|account`, least recently used first. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Keys that failed, and the moment (ms epoch) they may be attempted again. */
  private readonly retryAfter = new Map<string, number>();

  /**
   * Resolve an `mxc://` avatar to a cached URL, or null when unset/failed.
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
    // Key by account too: the same mxc through a different homeserver is a different request.
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

  /**
   * Upload avatar bytes through the owning Account's media repository. A profile photo is
   * readable well beyond one room, so it leaves without its location, camera and capture
   * time, like any other photo.
   */
  upload(file: File, accountId: string): Observable<string> {
    return defer(() => from(withoutImageMetadata(file))).pipe(
      switchMap((upload) =>
        this.engine.upload(accountId, upload, {
          filename: file.name,
          mimeType: file.type || 'application/octet-stream',
          encrypt: false,
        }),
      ),
      filter((update) => update.kind === 'done'),
      map((update) => update.result),
      unwrapEngineResult(),
      map((uploaded) => {
        if (uploaded.kind !== 'plain')
          throw new Error('Avatar upload was encrypted.');
        return uploaded.mxc;
      }),
    );
  }

  /** Release every cached avatar URL and clear the cache (logout/login). */
  releaseAll(): void {
    this.release(
      [...this.cache.values()].flatMap(({ url }) => (url ? [url] : [])),
    );
    this.cache.clear();
    // A new session may be a different account on a different homeserver, so nothing
    // that failed under the old one should still be serving initials from a cooldown.
    this.retryAfter.clear();
  }

  /** Release every resolved avatar no subscriber is showing (the app went to the background). */
  releaseUnpinned(): void {
    const released: string[] = [];
    for (const [key, entry] of this.cache) {
      if (entry.url && entry.holders === 0) {
        this.cache.delete(key);
        released.push(entry.url);
      }
    }
    this.release(released);
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
    const entry: CacheEntry = {
      url: null,
      holders: 0,
      resolved: defer(() =>
        this.engine.content(
          // A named account that is no longer live reads through the active one; read
          // untracked, as a subscriber may sit inside an effect.
          untracked(
            () =>
              (accountId && this.session.status(accountId)
                ? accountId
                : null) ??
              this.session.activeAccountId() ??
              '',
          ),
          {
            source: { kind: 'plain', mxc },
            format: {
              kind: 'thumbnail',
              width: edge,
              height: edge,
              method: 'scale',
              animated: false,
            },
            mimeType: 'application/octet-stream',
            downscaleTo: null,
          },
        ),
      ).pipe(
        unwrapEngineResult(),
        map(({ url }) => {
          // releaseAll cannot cancel a fetch already in flight. If this one lands after
          // it, the entry is no longer cached, so no later releaseAll or eviction would
          // ever find its URL: release it at once.
          if (this.cache.get(key) !== entry) {
            this.release([url]);
            return null;
          }
          entry.url = url;
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

  /** Release least recently used unheld URLs until at most {@link AVATAR_CACHE_LIMIT} remain. */
  private evict(): void {
    let resolved = 0;
    for (const { url } of this.cache.values()) {
      resolved += url ? 1 : 0;
    }
    const evicted: string[] = [];
    for (const [key, entry] of this.cache) {
      if (resolved <= AVATAR_CACHE_LIMIT) {
        break;
      }
      if (entry.url && entry.holders === 0) {
        this.cache.delete(key);
        evicted.push(entry.url);
        resolved--;
      }
    }
    this.release(evicted);
  }

  private release(urls: readonly string[]): void {
    if (urls.length > 0) this.engine.release(urls).subscribe();
  }
}
