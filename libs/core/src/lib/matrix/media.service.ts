import { Injectable, inject } from '@angular/core';
import {
  Observable,
  Subject,
  catchError,
  defer,
  finalize,
  from,
  map,
  of,
  shareReplay,
  switchMap,
  takeUntil,
  throwError,
} from 'rxjs';
import { decryptAttachment } from './attachment-crypto';
import { MatrixClientService } from './matrix-client.service';
import type { EncryptedFileInfo, MediaPayload } from './media.model';

/** Which rendition of an attachment to resolve. */
export type MediaVariant = 'thumbnail' | 'full';

/** Max edge (px) for a server-generated thumbnail when the event ships none. */
const THUMBNAIL_PX = 480;

/** Cap on cached object URLs; pinned (on-screen) entries are never evicted. */
const CACHE_LIMIT = 64;

interface CacheEntry {
  url: string;
  blob: Blob;
}

interface MediaSource {
  mxc: string | null;
  file: EncryptedFileInfo | null;
  mimeType: string;
  /** Server-thumbnail dimensions, or null to download the resource as-is. */
  resize: { w: number; h: number } | null;
}

/**
 * Resolves Matrix media (`mxc://` plaintext or encrypted `content.file`) into
 * `blob:` object URLs the UI can bind to `<img>`/`<video>`/`<a download>`.
 *
 * Owns the SDK + attachment-crypto boundary so no component touches
 * `matrix-js-sdk` directly, and owns the object-URL lifecycle: a bounded cache
 * keyed by source+variant, where URLs currently on screen are {@link pin}ned and
 * never evicted, and {@link releaseAll} revokes everything on room close / logout.
 *
 * Resolves both plaintext (`mxc`) and encrypted (`content.file`) attachments:
 * encrypted bytes are downloaded as ciphertext and decrypted in-memory with the
 * event's per-file AES-CTR key via the in-tree {@link decryptAttachment} helper,
 * which also verifies the SHA-256 hash so a tampered blob never reaches the DOM.
 */
@Injectable({ providedIn: 'root' })
export class MediaService {
  private readonly matrix = inject(MatrixClientService);

  /** Insertion-ordered cache of resolved object URLs (oldest first for LRU). */
  private readonly cache = new Map<string, CacheEntry>();
  /** In-flight resolutions, keyed like {@link cache}, so concurrent subscribers
   * to the same bytes share one fetch+decrypt instead of racing. */
  private readonly inFlight = new Map<string, Observable<string>>();
  /** Object URLs currently bound on screen — exempt from eviction. */
  private readonly pinned = new Set<string>();
  /** Fires on {@link releaseAll} to cancel in-flight resolutions before teardown. */
  private readonly release$ = new Subject<void>();
  /** Cached probe of whether the homeserver supports authenticated media. */
  private authedMedia: Observable<boolean> | null = null;

  /**
   * Resolve a cached `blob:` URL for the thumbnail or full rendition of a media
   * attachment. Re-resolving the same source+variant returns the cached URL
   * without re-fetching.
   */
  resolveMedia(media: MediaPayload, variant: MediaVariant): Observable<string> {
    const source = this.sourceFor(media, variant);
    const key = this.cacheKey(source);
    const hit = this.cache.get(key);
    if (hit) {
      return of(hit.url);
    }
    // Share one fetch+decrypt across concurrent resolves of the same bytes — two
    // rows showing the same attachment, or an encrypted image's thumbnail and
    // lightbox (which resolve identical ciphertext) — instead of each fetching,
    // decrypting, and storing (the loser of which would leak its object URL).
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
    const obs = defer(() => this.fetchBlob(source)).pipe(
      // Cancel on releaseAll BEFORE store(): a late completion must not insert a
      // fresh object URL into the cache that teardown just cleared.
      takeUntil(this.release$),
      map((blob) => this.store(key, blob)),
      finalize(() => this.inFlight.delete(key)),
      shareReplay(1),
    );
    this.inFlight.set(key, obs);
    return obs;
  }

  /** Resolve the full-resolution bytes + filename for a download/save. */
  downloadMedia(
    media: MediaPayload,
  ): Observable<{ blob: Blob; filename: string }> {
    const source = this.sourceFor(media, 'full');
    return defer(() => this.fetchBlob(source)).pipe(
      map((blob) => ({ blob, filename: media.filename })),
    );
  }

  /** Mark an object URL as on screen so it is exempt from cache eviction. */
  pin(url: string | null): void {
    if (url) {
      this.pinned.add(url);
    }
  }

  /** Release a previously {@link pin}ned URL (it becomes eligible for eviction). */
  unpin(url: string | null): void {
    if (url) {
      this.pinned.delete(url);
    }
  }

  /** Revoke every cached object URL and clear the cache (room close / logout). */
  releaseAll(): void {
    // Cancel in-flight resolutions first: with shareReplay(refCount:false) their
    // fetch+decrypt would otherwise run to completion and re-`store()` a fresh
    // object URL into the just-cleared cache, leaking decrypted bytes past teardown.
    this.release$.next();
    for (const { url } of this.cache.values()) {
      URL.revokeObjectURL(url);
    }
    this.cache.clear();
    this.inFlight.clear();
    this.pinned.clear();
  }

  /** Pick the bytes to fetch for a variant, preferring an event-supplied thumbnail. */
  private sourceFor(media: MediaPayload, variant: MediaVariant): MediaSource {
    if (variant === 'thumbnail') {
      if (media.thumbnailMxc || media.thumbnailFile) {
        return {
          mxc: media.thumbnailMxc,
          file: media.thumbnailFile,
          mimeType: media.thumbnailMimeType ?? media.mimeType,
          resize: null,
        };
      }
      // No bundled thumbnail: ask the server to scale the original (plaintext
      // only — encrypted originals have no server-side thumbnail).
      return {
        mxc: media.mxc,
        file: media.file,
        mimeType: media.mimeType,
        resize: media.file ? null : { w: THUMBNAIL_PX, h: THUMBNAIL_PX },
      };
    }
    return {
      mxc: media.mxc,
      file: media.file,
      mimeType: media.mimeType,
      resize: null,
    };
  }

  /**
   * Key on the bytes actually fetched, not the requested variant: a server-scaled
   * thumbnail genuinely differs from the original, but an encrypted attachment with
   * no bundled thumbnail resolves the *same* ciphertext for both `thumbnail` and
   * `full` — so they must share one cache entry (and one decrypt), not two.
   */
  private cacheKey(source: MediaSource): string {
    const id = source.mxc ?? source.file?.url ?? '';
    return source.resize
      ? `${id}|${source.resize.w}x${source.resize.h}`
      : `${id}|orig`;
  }

  /** Fetch (and decrypt, when encrypted) the bytes for a source into a typed Blob. */
  private fetchBlob(source: MediaSource): Observable<Blob> {
    if (source.file) {
      // Encrypted attachment: download the ciphertext (always the full resource —
      // an encrypted original carries no server-side thumbnail) and decrypt it with
      // the event's per-file AES-CTR key. decryptAttachment verifies the SHA-256
      // hash and rejects on a mismatch, so tampered bytes never reach the DOM.
      const file = source.file;
      return this.fetchBytes(file.url, null).pipe(
        switchMap((ciphertext) => from(decryptAttachment(ciphertext, file))),
        map((plaintext) => new Blob([plaintext], { type: source.mimeType })),
      );
    }
    if (!source.mxc) {
      return throwError(() => new Error('Media has no source'));
    }
    return this.fetchBytes(source.mxc, source.resize).pipe(
      map((buffer) => new Blob([buffer], { type: source.mimeType })),
    );
  }

  /**
   * Fetch raw media bytes, choosing authenticated vs. legacy media based on
   * homeserver support and falling back to the legacy endpoint if an
   * authenticated request fails (older servers that advertise v1.11 but still
   * serve legacy media).
   */
  private fetchBytes(
    mxc: string,
    resize: { w: number; h: number } | null,
  ): Observable<ArrayBuffer> {
    const client = this.matrix.instance;
    return this.supportsAuthedMedia().pipe(
      switchMap((authed) => {
        const token = client.getAccessToken();
        const url = this.httpUrl(mxc, resize, authed && !!token);
        return this.doFetch(url, authed ? token : null).pipe(
          // Older servers advertise v1.11 but still serve legacy media: on a
          // failed authenticated request, retry the unauthenticated endpoint.
          switchMap((res) =>
            !res.ok && authed
              ? this.doFetch(this.httpUrl(mxc, resize, false), null)
              : of(res),
          ),
        );
      }),
      switchMap((res) =>
        res.ok
          ? from(res.arrayBuffer())
          : throwError(() => new Error(`Media fetch failed (${res.status})`)),
      ),
    );
  }

  private httpUrl(
    mxc: string,
    resize: { w: number; h: number } | null,
    useAuthentication: boolean,
  ): string {
    const client = this.matrix.instance;
    const url = resize
      ? client.mxcUrlToHttp(
          mxc,
          resize.w,
          resize.h,
          'scale',
          false,
          true,
          useAuthentication,
        )
      : client.mxcUrlToHttp(
          mxc,
          undefined,
          undefined,
          undefined,
          false,
          true,
          useAuthentication,
        );
    if (!url) {
      throw new Error('Could not resolve media URL');
    }
    return url;
  }

  private doFetch(url: string, token: string | null): Observable<Response> {
    return from(
      fetch(
        url,
        token ? { headers: { Authorization: `Bearer ${token}` } } : {},
      ),
    );
  }

  /** Probe (once, cached) whether the homeserver supports authenticated media. */
  private supportsAuthedMedia(): Observable<boolean> {
    if (!this.authedMedia) {
      // `shareReplay(1)` runs the version probe once and replays the result to
      // every later subscriber — the Observable equivalent of the cached promise.
      this.authedMedia = from(
        this.matrix.instance.isVersionSupported('v1.11'),
      ).pipe(
        catchError(() => of(false)),
        shareReplay(1),
      );
    }
    return this.authedMedia;
  }

  /** Store a freshly-fetched blob under a cache key and return its object URL. */
  private store(key: string, blob: Blob): string {
    // Defensive: if an unpinned entry already sits at this key, revoke it before
    // replacing so its object URL can't leak. Pinned (on-screen) URLs are left for
    // their owner to release.
    const prev = this.cache.get(key);
    if (prev && !this.pinned.has(prev.url)) {
      URL.revokeObjectURL(prev.url);
    }
    const url = URL.createObjectURL(blob);
    this.cache.set(key, { url, blob });
    this.evict();
    return url;
  }

  /** Evict the oldest unpinned entries until the cache is within its limit. */
  private evict(): void {
    while (this.cache.size > CACHE_LIMIT) {
      let removed = false;
      for (const [key, entry] of this.cache) {
        if (!this.pinned.has(entry.url)) {
          this.cache.delete(key);
          URL.revokeObjectURL(entry.url);
          removed = true;
          break;
        }
      }
      if (!removed) {
        break; // everything left is pinned (on screen)
      }
    }
  }
}
