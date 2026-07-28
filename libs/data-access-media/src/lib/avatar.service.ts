import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, shareReplay } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { fetchMediaBytes } from '@trinity/util-matrix';

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
 * sender), so successful resolutions are cached for the session keyed by mxc+size;
 * the cache is revoked on logout/login ({@link releaseAll}). The cache is unbounded
 * within a session, which is fine for small decorative thumbnails cleared on every
 * session change.
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

@Injectable({ providedIn: 'root' })
export class AvatarService {
  private readonly matrix = inject(MatrixClientService);

  /** Shared resolutions keyed by `mxc|size` (one fetch+blob per avatar). */
  private readonly cache = new Map<string, Observable<string | null>>();
  /** Object URLs created, revoked together on {@link releaseAll}. */
  private readonly urls = new Set<string>();
  /** Keys that failed, and the moment (ms epoch) they may be attempted again. */
  private readonly retryAfter = new Map<string, number>();

  /** Resolve an `mxc://` avatar to a cached `blob:` URL, or null when unset/failed. */
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
    const hit = this.cache.get(key);
    if (hit) {
      return hit;
    }
    const coolingUntil = this.retryAfter.get(key);
    if (coolingUntil !== undefined) {
      if (Date.now() < coolingUntil) {
        return of(null); // still cooling off — show the initial without another attempt
      }
      this.retryAfter.delete(key);
    }
    const edge = Math.ceil(sizePx * DPR);
    const client =
      (accountId ? this.matrix.clientFor(accountId) : null) ??
      this.matrix.instance;
    const resolved = fetchMediaBytes(
      client,
      mxc,
      { w: edge, h: edge },
      true,
    ).pipe(
      map((bytes) => this.store(new Blob([bytes]))),
      // An avatar is decorative — on failure fall back to initials (null), and drop the
      // cache entry so a transient failure can be retried, but not before the cooldown.
      catchError(() => {
        this.cache.delete(key);
        this.retryAfter.set(key, Date.now() + FAILURE_COOLDOWN_MS);
        return of<string | null>(null);
      }),
      shareReplay(1),
    );
    this.cache.set(key, resolved);
    return resolved;
  }

  /** Revoke every cached avatar object URL and clear the cache (logout/login). */
  releaseAll(): void {
    for (const url of this.urls) {
      URL.revokeObjectURL(url);
    }
    this.urls.clear();
    this.cache.clear();
    // A new session may be a different account on a different homeserver, so nothing
    // that failed under the old one should still be serving initials from a cooldown.
    this.retryAfter.clear();
  }

  private store(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  }
}
