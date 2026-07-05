import { Injectable, inject } from '@angular/core';
import { Observable, catchError, map, of, shareReplay } from 'rxjs';
import { MatrixClientService } from './matrix-client.service';
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
 * the cache is revoked on logout/login ({@link releaseAll}). Failures are NOT cached
 * (the entry is dropped) so a transient blip doesn't pin an avatar to initials for
 * the whole session. The cache is unbounded within a session, which is fine for
 * small decorative thumbnails cleared on every session change.
 */
@Injectable({ providedIn: 'root' })
export class AvatarService {
  private readonly matrix = inject(MatrixClientService);

  /** Shared resolutions keyed by `mxc|size` (one fetch+blob per avatar). */
  private readonly cache = new Map<string, Observable<string | null>>();
  /** Object URLs created, revoked together on {@link releaseAll}. */
  private readonly urls = new Set<string>();

  /** Resolve an `mxc://` avatar to a cached `blob:` URL, or null when unset/failed. */
  resolve(mxc: string | null, sizePx = AVATAR_PX): Observable<string | null> {
    if (!mxc) {
      return of(null);
    }
    const key = `${mxc}|${sizePx}`;
    const hit = this.cache.get(key);
    if (hit) {
      return hit;
    }
    const edge = Math.ceil(sizePx * DPR);
    const resolved = fetchMediaBytes(
      this.matrix.instance,
      mxc,
      { w: edge, h: edge },
      true,
    ).pipe(
      map((bytes) => this.store(new Blob([bytes]))),
      // An avatar is decorative — on failure fall back to initials (null), and
      // drop the cache entry so a transient failure can be retried later.
      catchError(() => {
        this.cache.delete(key);
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
  }

  private store(blob: Blob): string {
    const url = URL.createObjectURL(blob);
    this.urls.add(url);
    return url;
  }
}
