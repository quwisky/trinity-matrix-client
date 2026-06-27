import { Injectable, inject } from '@angular/core';
import { Observable, defer, from, map, of, tap } from 'rxjs';
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
 * Owns the SDK + (later) attachment-crypto boundary so no component touches
 * `matrix-js-sdk` directly, and owns the object-URL lifecycle: a bounded cache
 * keyed by source+variant, where URLs currently on screen are {@link pin}ned and
 * never evicted, and {@link releaseAll} revokes everything on room close / logout.
 *
 * Phase 1 resolves plaintext media only; encrypted attachments report an error
 * state until the decrypt branch lands (Phase 2).
 */
@Injectable({ providedIn: 'root' })
export class MediaService {
  private readonly matrix = inject(MatrixClientService);

  /** Insertion-ordered cache of resolved object URLs (oldest first for LRU). */
  private readonly cache = new Map<string, CacheEntry>();
  /** Object URLs currently bound on screen — exempt from eviction. */
  private readonly pinned = new Set<string>();
  /** Cached probe of whether the homeserver supports authenticated media. */
  private authedMedia: Promise<boolean> | null = null;

  /**
   * Resolve a cached `blob:` URL for the thumbnail or full rendition of a media
   * attachment. Re-resolving the same source+variant returns the cached URL
   * without re-fetching.
   */
  resolveMedia(media: MediaPayload, variant: MediaVariant): Observable<string> {
    const source = this.sourceFor(media, variant);
    const key = this.cacheKey(source, variant);
    const hit = this.cache.get(key);
    if (hit) {
      return of(hit.url);
    }
    return defer(() => from(this.fetchBlob(source))).pipe(
      map((blob) => this.store(key, blob)),
    );
  }

  /** Resolve the full-resolution bytes + filename for a download/save. */
  downloadMedia(
    media: MediaPayload,
  ): Observable<{ blob: Blob; filename: string }> {
    const source = this.sourceFor(media, 'full');
    return defer(() => from(this.fetchBlob(source))).pipe(
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
    for (const { url } of this.cache.values()) {
      URL.revokeObjectURL(url);
    }
    this.cache.clear();
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

  private cacheKey(source: MediaSource, variant: MediaVariant): string {
    return `${source.mxc ?? source.file?.url ?? ''}|${variant}`;
  }

  /** Fetch (and later decrypt) the bytes for a source into a typed Blob. */
  private async fetchBlob(source: MediaSource): Promise<Blob> {
    if (source.file) {
      // Phase 2 slots the attachment-decrypt here; until then surface an error
      // rather than rendering ciphertext.
      throw new Error('Encrypted media is not supported yet');
    }
    if (!source.mxc) {
      throw new Error('Media has no source');
    }
    const buffer = await this.fetchBytes(source.mxc, source.resize);
    return new Blob([buffer], { type: source.mimeType });
  }

  /**
   * Fetch raw media bytes, choosing authenticated vs. legacy media based on
   * homeserver support and falling back to the legacy endpoint if an
   * authenticated request fails (older servers that advertise v1.11 but still
   * serve legacy media).
   */
  private async fetchBytes(
    mxc: string,
    resize: { w: number; h: number } | null,
  ): Promise<ArrayBuffer> {
    const client = this.matrix.instance;
    const authed = await this.supportsAuthedMedia();
    const token = client.getAccessToken();

    const url = this.httpUrl(mxc, resize, authed && !!token);
    let res = await this.doFetch(url, authed ? token : null);
    if (!res.ok && authed) {
      const legacy = this.httpUrl(mxc, resize, false);
      res = await this.doFetch(legacy, null);
    }
    if (!res.ok) {
      throw new Error(`Media fetch failed (${res.status})`);
    }
    return res.arrayBuffer();
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

  private doFetch(url: string, token: string | null): Promise<Response> {
    return fetch(
      url,
      token ? { headers: { Authorization: `Bearer ${token}` } } : {},
    );
  }

  /** Probe (once, cached) whether the homeserver supports authenticated media. */
  private supportsAuthedMedia(): Promise<boolean> {
    if (!this.authedMedia) {
      this.authedMedia = this.matrix.instance
        .isVersionSupported('v1.11')
        .catch(() => false);
    }
    return this.authedMedia;
  }

  /** Store a freshly-fetched blob under a cache key and return its object URL. */
  private store(key: string, blob: Blob): string {
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
