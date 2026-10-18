import { Injectable, inject } from '@angular/core';
import {
  Observable,
  Subject,
  catchError,
  defer,
  finalize,
  from,
  map,
  merge,
  of,
  shareReplay,
  switchMap,
  takeUntil,
  throwError,
} from 'rxjs';
import { MsgType, type MatrixClient } from 'matrix-js-sdk';
import {
  decryptAttachment,
  displaySafeMime,
  encryptAttachment,
} from '@trinity/util/matrix';
import {
  MatrixClientService,
  serverAdvertises,
  type ServerSupportQuery,
} from '@trinity/data-access/matrix-client';
import { fetchMediaBytes } from '@trinity/util/matrix';
import type { EncryptedFileInfo, MediaPayload } from '@trinity/util/matrix';
import type { ImageMetadataPolicy, MediaHints } from './media-pipeline.models';
import {
  bytesWithoutMediaMetadata,
  withoutImageMetadata,
  withoutMediaMetadata,
} from './image-metadata/strip-file-metadata';
import { DEVICE_PIXEL_RATIO, displayThumbnailEdge } from './thumbnail-size';
import {
  describeMedia,
  downscaleImage,
  needsDownscale,
  type GeneratedThumbnail,
} from './media-processing';

/** Which rendition of an attachment to resolve. */
export type MediaVariant = 'thumbnail' | 'full';

/**
 * Everything {@link TimelineService} needs to build an outgoing media event from an uploaded
 * attachment. `mxc` is set for plaintext, `file` for encrypted (its `url` already filled).
 */
export interface UploadedMedia {
  msgtype: MsgType;
  /** Filename / caption fallback (`content.body`). */
  body: string;
  /** `content.url` for plaintext uploads, else null. */
  mxc: string | null;
  /** `content.file` (encrypted, `url` filled) for E2EE uploads, else null. */
  file: EncryptedFileInfo | null;
  /** `content.info` — dimensions, duration, and a client-generated thumbnail. */
  info: {
    mimetype: string;
    size: number;
    w?: number;
    h?: number;
    /** Duration in milliseconds (audio/video). */
    duration?: number;
    /** Plaintext thumbnail (`mxc://`), set for unencrypted rooms. */
    thumbnail_url?: string;
    /** Encrypted thumbnail descriptor, set for E2EE rooms. */
    thumbnail_file?: EncryptedFileInfo;
    /** Thumbnail mimetype + scaled dimensions/size. */
    thumbnail_info?: {
      mimetype: string;
      w?: number;
      h?: number;
      size?: number;
    };
  };
}

/** The `content.info` thumbnail fields produced by {@link MediaService.uploadThumbnail}. */
type ThumbnailInfo = Pick<
  UploadedMedia['info'],
  'thumbnail_url' | 'thumbnail_file' | 'thumbnail_info'
>;

/** Cap on cached object URLs; pinned (on-screen) entries are never evicted. */
const CACHE_LIMIT = 64;

/**
 * Cap on the blob bytes behind the cached URLs, alongside {@link CACHE_LIMIT}. The count says
 * nothing about memory: 64 thumbnails are a few MB, 64 full-size photos or videos are hundreds.
 * 96 MB holds a dozen full-size photos or a few hundred thumbnails and leaves a phone WebView
 * room for the rest of the app. Pinned (on-screen) entries are exempt.
 */
const CACHE_BYTE_LIMIT = 96 * 1024 * 1024;

interface CacheEntry {
  url: string;
  blob: Blob;
  /** `blob.size` recorded at creation, so the running total never re-reads blobs. */
  bytes: number;
}

/** A resolution under way, shared by everyone resolving the same bytes meanwhile. */
interface InFlight {
  readonly result: Observable<string>;
  waiters: number;
  /** Abandons the resolution before it stores anything (see {@link MediaService.drop}). */
  readonly cancel: Subject<void>;
}

/** The bytes to resolve: exactly one of an encrypted file or a plaintext `mxc://`. */
type MediaSource =
  | {
      readonly kind: 'encrypted';
      readonly file: EncryptedFileInfo;
      readonly mimeType: string;
      /** Decrypted image to shrink to this long edge (px) before it is cached, or undefined. */
      readonly downscaleTo?: number;
    }
  | {
      readonly kind: 'plain';
      readonly mxc: string | null;
      readonly mimeType: string;
      /** Server-thumbnail dimensions, or null to download the resource as-is. */
      readonly resize: { w: number; h: number } | null;
    };

/** Authenticated media arrived in spec v1.11; servers advertised MSC3916's stable flag before that. */
const AUTHENTICATED_MEDIA = {
  version: 'v1.11',
  unstableFeature: 'org.matrix.msc3916.stable',
} as const satisfies ServerSupportQuery;

/**
 * Resolves Matrix media (`mxc://` plaintext or encrypted `content.file`) into `blob:` object
 * URLs the UI can bind to `<img>`/`<video>`/`<a download>`.
 *
 * Owns the SDK and attachment-crypto boundary and the object-URL lifecycle: a bounded cache
 * keyed by source+variant, where on-screen URLs are {@link pin}ned and never evicted, and
 * {@link releaseAll} revokes everything on room close / logout. Encrypted bytes are downloaded
 * as ciphertext and decrypted in memory with the event's per-file AES-CTR key;
 * {@link decryptAttachment} verifies the SHA-256 hash, so a tampered blob never reaches the DOM.
 */
@Injectable({ providedIn: 'root' })
export class MediaService {
  private readonly matrix = inject(MatrixClientService);
  private readonly devicePixelRatio = inject(DEVICE_PIXEL_RATIO);

  /** Insertion-ordered cache of resolved object URLs (oldest first, for LRU). */
  private readonly cache = new Map<string, CacheEntry>();
  private cachedBytes = 0;
  /** In-flight resolutions keyed like {@link cache}, so concurrent subscribers share one fetch. */
  private readonly inFlight = new Map<string, InFlight>();
  /**
   * How many views have each object URL bound on screen; a URL with a count is exempt from
   * eviction. Counted, not a set: the same blob URL can be shown in two places at once (a
   * sticker in two messages, an image in its row and its lightbox), and one of them leaving
   * must not expose the URL the other still shows.
   */
  private readonly pinned = new Map<string, number>();
  private readonly release$ = new Subject<void>();
  /** Cached authenticated-media probe per exact client/account. */
  private authedMedia = new WeakMap<MatrixClient, Observable<boolean>>();
  /** Upload limit per exact client; a failed lookup is dropped so the next caller retries. */
  private readonly uploadLimits = new WeakMap<
    MatrixClient,
    Observable<number | null>
  >();
  /** Stable cache namespace per live client so identical MXCs cannot cross Accounts. */
  private readonly clientIds = new WeakMap<MatrixClient, number>();
  private nextClientId = 0;

  /**
   * Resolve a cached `blob:` URL for the thumbnail or full rendition of an attachment; the same
   * source+variant is not refetched.
   */
  resolveMedia(
    media: MediaPayload,
    variant: MediaVariant,
    client: MatrixClient = this.matrix.instance,
  ): Observable<string> {
    const source = this.sourceFor(media, variant);
    const key = this.cacheKey(client, source);
    const hit = this.cache.get(key);
    if (hit) {
      // Re-insert so the Map's insertion order is recency order (LRU, not FIFO).
      this.cache.delete(key);
      this.cache.set(key, hit);
      return of(hit.url);
    }
    // Share one fetch+decrypt across concurrent resolves of the same bytes (two rows showing one
    // attachment, or an encrypted image's thumbnail and lightbox, which resolve identical
    // ciphertext); separate stores would leak the loser's object URL.
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending.result;
    }
    const cancel = new Subject<void>();
    const shared = defer(() => this.fetchBlob(client, source)).pipe(
      // Cancel on releaseAll or a drop BEFORE store(): a late completion must not insert
      // a fresh object URL into a cache that no longer wants it.
      takeUntil(merge(this.release$, cancel)),
      map((blob) => this.store(key, blob)),
      finalize(() => {
        if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
      }),
      shareReplay(1),
    );
    const entry: InFlight = {
      waiters: 0,
      cancel,
      // Count who is still waiting, so a drop cancels only a resolve nobody else needs.
      result: defer(() => {
        entry.waiters++;
        return shared.pipe(finalize(() => entry.waiters--));
      }),
    };
    this.inFlight.set(key, entry);
    return entry.result;
  }

  /** Resolve the full-resolution bytes + filename for a download/save. */
  downloadMedia(
    media: MediaPayload,
    client: MatrixClient = this.matrix.instance,
  ): Observable<{ blob: Blob; filename: string }> {
    const source = this.sourceFor(media, 'full');
    return defer(() => this.fetchBlob(client, source)).pipe(
      map((blob) => ({ blob, filename: media.filename })),
    );
  }

  /**
   * Upload a picked file to the media repo, encrypting it first for E2EE rooms, and return the
   * descriptor {@link TimelineService} turns into an event. A JPEG, PNG, WebP or HEIF image
   * first loses its identifying metadata (location, camera, capture time; orientation is
   * kept), and an MP4/MOV/3GP movie its location and device, on the plaintext before any
   * encryption; anything else, or a file whose structure is in doubt, goes up as picked. An
   * encrypted upload sends the ciphertext with no filename/MIME (those leak) and `info.url`
   * is filled with the resulting `mxc://`. `progress` reports a fraction in [0, 1].
   * `hints` (from a camera capture) win over the probe, which fills only what they leave out.
   * `imageMetadata: 'keep'` (the person's opt-in for message attachments) skips stripping, so
   * a photo or video goes up byte for byte; a host-supplied thumbnail is still stripped, being
   * a derived preview.
   */
  uploadMedia(
    file: File,
    encrypt: boolean,
    progress?: (fraction: number) => void,
    abortController?: AbortController,
    client: MatrixClient = this.matrix.instance,
    hints?: MediaHints,
    imageMetadata: ImageMetadataPolicy = 'strip',
  ): Observable<UploadedMedia> {
    return defer(() =>
      from(
        this.doUpload(
          client,
          file,
          encrypt,
          progress,
          abortController,
          hints,
          imageMetadata,
        ),
      ),
    );
  }

  /**
   * The homeserver's upload limit in bytes (`m.upload.size`), or null when the server does
   * not state one or cannot be asked. A null never blocks a send; the server stays the judge.
   */
  uploadLimit(
    client: MatrixClient = this.matrix.instance,
  ): Observable<number | null> {
    const cached = this.uploadLimits.get(client);
    if (cached) {
      return cached;
    }
    const limit = this.supportsAuthedMedia(client).pipe(
      switchMap((authed) => from(client.getMediaConfig(authed))),
      map((config) => {
        const size = config['m.upload.size'];
        return typeof size === 'number' && Number.isFinite(size) && size > 0
          ? size
          : null;
      }),
      catchError(() => {
        this.uploadLimits.delete(client);
        return of(null);
      }),
      shareReplay(1),
    );
    this.uploadLimits.set(client, limit);
    return limit;
  }

  private async doUpload(
    client: MatrixClient,
    file: File,
    encrypt: boolean,
    progress?: (fraction: number) => void,
    abortController?: AbortController,
    hints?: MediaHints,
    imageMetadata: ImageMetadataPolicy = 'strip',
  ): Promise<UploadedMedia> {
    abortController?.signal.throwIfAborted();
    const msgtype = msgTypeFor(file.type);
    // Host-measured values win; the WebView probe runs only for what is missing. For E2EE rooms
    // the thumbnail is the only one the timeline can show: the server can't scale an encrypted
    // original.
    const { dims, thumbnail } = await describeMedia(file, hints);
    abortController?.signal.throwIfAborted();
    const thumb = await this.uploadThumbnail(
      client,
      thumbnail,
      encrypt,
      abortController,
    );
    const onProgress = progress
      ? (p: { loaded: number; total: number }) =>
          progress(p.total ? p.loaded / p.total : 0)
      : undefined;

    // Stripping happens on the plaintext, before encryption; anything it cannot handle with
    // certainty uploads as picked. Keeping metadata (the opt-in) uploads the file untouched,
    // never a partial strip.
    const keep = imageMetadata === 'keep';
    if (encrypt) {
      const plaintext = keep
        ? await file.arrayBuffer()
        : await bytesWithoutMediaMetadata(file);
      abortController?.signal.throwIfAborted();
      const { data, info } = await encryptAttachment(plaintext);
      abortController?.signal.throwIfAborted();
      const res = await client.uploadContent(new Blob([data]), {
        // Don't leak the plaintext filename/MIME on an encrypted upload.
        includeFilename: false,
        type: 'application/octet-stream',
        progressHandler: onProgress,
        ...(abortController ? { abortController } : {}),
      });
      info.url = res.content_uri;
      return {
        msgtype,
        body: file.name || 'attachment',
        mxc: null,
        file: info,
        info: mediaInfo(file, data.byteLength, dims, thumb),
      };
    }

    const upload = keep ? file : await withoutMediaMetadata(file);
    abortController?.signal.throwIfAborted();
    const res = await client.uploadContent(upload, {
      name: file.name,
      type: file.type || 'application/octet-stream',
      progressHandler: onProgress,
      ...(abortController ? { abortController } : {}),
    });
    return {
      msgtype,
      body: file.name || 'attachment',
      mxc: res.content_uri,
      file: null,
      info: mediaInfo(file, upload.size, dims, thumb),
    };
  }

  /**
   * Upload a freshly-rendered thumbnail (encrypted with its own key/iv/hash for E2EE rooms)
   * and return the `content.info` thumbnail fields, or null when there is none. Any failure
   * resolves to null: a thumbnail is never a gate for sending. Uploaded before the main
   * resource (it is small) so `progress` tracks the dominant bytes.
   */
  private async uploadThumbnail(
    client: MatrixClient,
    thumbnail: GeneratedThumbnail | null,
    encrypt: boolean,
    abortController?: AbortController,
  ): Promise<ThumbnailInfo | null> {
    if (!thumbnail) {
      return null;
    }
    const { w, h } = thumbnail;
    // A host-rendered thumbnail (native camera capture) is an image file of its own: it loses
    // its metadata like any photo before it goes up, encrypted or not, even when the person
    // keeps the video's own, being a derived preview. One rendered on a canvas has none and
    // comes back unchanged.
    const blob = await withoutImageMetadata(
      new File([thumbnail.blob], 'thumbnail', { type: thumbnail.blob.type }),
    );
    const thumbnail_info = { mimetype: blob.type, w, h, size: blob.size };
    try {
      if (encrypt) {
        const { data, info } = await encryptAttachment(
          await blob.arrayBuffer(),
        );
        const res = await client.uploadContent(new Blob([data]), {
          includeFilename: false,
          type: 'application/octet-stream',
          ...(abortController ? { abortController } : {}),
        });
        info.url = res.content_uri;
        return { thumbnail_file: info, thumbnail_info };
      }
      const res = await client.uploadContent(blob, {
        name: 'thumbnail',
        type: blob.type,
        ...(abortController ? { abortController } : {}),
      });
      return { thumbnail_url: res.content_uri, thumbnail_info };
    } catch (error: unknown) {
      if (abortController?.signal.aborted) throw error;
      return null;
    }
  }

  /**
   * Mark an object URL as on screen so it is exempt from cache eviction. Pins are counted:
   * each view that binds the URL pins it once and {@link unpin}s it once.
   */
  pin(url: string | null): void {
    if (url) {
      this.pinned.set(url, (this.pinned.get(url) ?? 0) + 1);
    }
  }

  /**
   * Release one {@link pin} of a URL; it becomes eligible for eviction once no pin remains.
   * An unpin without a matching pin does nothing.
   */
  unpin(url: string | null): void {
    if (!url) return;
    const count = this.pinned.get(url) ?? 0;
    if (count > 1) {
      this.pinned.set(url, count - 1);
    } else {
      this.pinned.delete(url);
    }
  }

  /**
   * Free one rendition now rather than when the LRU gets to it: for full-size media that has
   * been closed (a lightbox image, a played clip).
   *
   * `url` is the object URL the caller resolved and pinned, or null when it has none yet. Its
   * pin is released; only if no other view still pins it is the URL revoked and the entry
   * removed, and only while the cache still holds it for `rendition`, so a URL from before a
   * {@link releaseAll} cannot revoke its successor. A resolve of `rendition` still in flight
   * is cancelled when no subscriber is waiting for it any more, so the dropping caller must
   * unsubscribe from its own resolve first. An observable returned by {@link resolveMedia}
   * before the drop is spent by it: subscribing later completes without a URL, so resolve
   * again.
   */
  drop(
    url: string | null,
    rendition: {
      media: MediaPayload;
      variant: MediaVariant;
      client?: MatrixClient;
    },
  ): void {
    const key = this.cacheKey(
      rendition.client ?? this.matrix.instance,
      this.sourceFor(rendition.media, rendition.variant),
    );
    if (url) {
      this.unpin(url);
      const entry = this.cache.get(key);
      if (entry?.url === url && !this.pinned.has(url)) {
        this.cache.delete(key);
        this.cachedBytes -= entry.bytes;
        URL.revokeObjectURL(url);
      }
    }
    const pending = this.inFlight.get(key);
    if (pending && pending.waiters === 0) {
      this.inFlight.delete(key);
      pending.cancel.next();
    }
  }

  /**
   * Revoke every cached URL that is not on screen, so a hidden app holds only what it
   * shows. Unlike {@link releaseAll}, in-flight work and pins survive: the next use of a
   * released source simply fetches it again.
   */
  releaseUnpinned(): void {
    for (const [key, entry] of this.cache) {
      if (this.pinned.has(entry.url)) continue;
      this.cache.delete(key);
      this.cachedBytes -= entry.bytes;
      URL.revokeObjectURL(entry.url);
    }
  }

  /** Revoke every cached object URL and clear the cache (room close / logout). */
  releaseAll(): void {
    // Cancel in-flight resolutions first: with shareReplay(refCount:false) their fetch+decrypt
    // would otherwise finish and re-`store()` an object URL into the cleared cache, leaking
    // decrypted bytes past teardown.
    this.release$.next();
    for (const { url } of this.cache.values()) {
      URL.revokeObjectURL(url);
    }
    this.cache.clear();
    this.cachedBytes = 0;
    this.inFlight.clear();
    this.pinned.clear();
    // Re-probe authed-media support on the next request: after logout→login the new homeserver
    // may differ, and a stale `false` would keep requesting the unauthenticated endpoint
    // (401/404 with no fallback), breaking all media for the session.
    this.authedMedia = new WeakMap();
  }

  private sourceFor(media: MediaPayload, variant: MediaVariant): MediaSource {
    if (variant === 'thumbnail') {
      const mimeType = media.thumbnailMimeType ?? media.mimeType;
      if (media.thumbnailFile) {
        return { kind: 'encrypted', file: media.thumbnailFile, mimeType };
      }
      if (media.thumbnailMxc) {
        return {
          kind: 'plain',
          mxc: media.thumbnailMxc,
          mimeType,
          resize: null,
        };
      }
      // No bundled thumbnail: ask the server to scale the original (plaintext only; encrypted
      // originals have no server-side thumbnail and are shrunk client-side after decryption).
      // Sizes follow the current screen; resolved thumbnails are not refetched when it changes,
      // and the edge is part of the cache key so buckets never mix.
      const edge = displayThumbnailEdge(this.devicePixelRatio());
      if (media.file) {
        return {
          kind: 'encrypted',
          file: media.file,
          mimeType: media.mimeType,
          ...(needsDownscale(media, edge) ? { downscaleTo: edge } : {}),
        };
      }
      return {
        kind: 'plain',
        mxc: media.mxc,
        mimeType: media.mimeType,
        resize: { w: edge, h: edge },
      };
    }
    return media.file
      ? { kind: 'encrypted', file: media.file, mimeType: media.mimeType }
      : {
          kind: 'plain',
          mxc: media.mxc,
          mimeType: media.mimeType,
          resize: null,
        };
  }

  /**
   * Key on the bytes actually fetched, not the requested variant: an encrypted attachment with
   * no bundled thumbnail resolves the same ciphertext for `thumbnail` and `full`, so they share
   * one cache entry (and one decrypt). Server-scaled and downscaled thumbnails differ from the
   * original and carry their size bucket, so a 1x and a 2x thumbnail are separate entries.
   *
   * Encrypted bytes are keyed by everything their decryption and hash check used, not the
   * URL alone: two events can name one `file.url` with different keys and hashes, and each
   * must get its own decrypt and hash check (or its failure), never the other's cached bytes.
   * Plaintext and encrypted entries never share a key, and the display type is part of both,
   * since it becomes the Blob's type. The parts are JSON-encoded so no field's content can
   * shift into its neighbour.
   */
  private cacheKey(client: MatrixClient, source: MediaSource): string {
    let clientId = this.clientIds.get(client);
    if (clientId === undefined) {
      clientId = ++this.nextClientId;
      this.clientIds.set(client, clientId);
    }
    if (source.kind === 'encrypted') {
      const { file } = source;
      return JSON.stringify([
        'e',
        clientId,
        file.url,
        file.hashes?.['sha256'] ?? '',
        file.key?.k ?? '',
        file.iv,
        file.v ?? '',
        displaySafeMime(source.mimeType),
        source.downscaleTo ? `thumb${source.downscaleTo}` : 'orig',
      ]);
    }
    return JSON.stringify([
      'p',
      clientId,
      source.mxc ?? '',
      displaySafeMime(source.mimeType),
      source.resize ? `${source.resize.w}x${source.resize.h}` : 'orig',
    ]);
  }

  /**
   * Fetch (and decrypt, when encrypted) the bytes for a source into a Blob. Attachments display
   * only safe media types: the declared type is kept only when it is a known image, video or
   * audio type, otherwise the Blob is opaque and its filename carries the extension.
   */
  private fetchBlob(
    client: MatrixClient,
    source: MediaSource,
  ): Observable<Blob> {
    if (source.kind === 'encrypted') {
      // Encrypted: download the full ciphertext (an encrypted original has no server-side
      // thumbnail) and decrypt it with the event's per-file AES-CTR key. decryptAttachment
      // verifies the SHA-256 hash and rejects on a mismatch, so tampered bytes never reach the DOM.
      const file = source.file;
      return this.fetchBytes(client, file.url, null).pipe(
        switchMap((ciphertext) => from(decryptAttachment(ciphertext, file))),
        map(
          (plaintext) =>
            new Blob([plaintext], { type: displaySafeMime(source.mimeType) }),
        ),
        switchMap((blob) =>
          source.downscaleTo
            ? from(downscaleImage(blob, source.downscaleTo))
            : of(blob),
        ),
      );
    }
    if (!source.mxc) {
      return throwError(() => new Error('Media has no source'));
    }
    return this.fetchBytes(client, source.mxc, source.resize).pipe(
      map(
        (buffer) =>
          new Blob([buffer], { type: displaySafeMime(source.mimeType) }),
      ),
    );
  }

  /**
   * Fetch raw media bytes via authenticated or legacy media, by homeserver support, falling
   * back to the legacy endpoint if an authenticated request fails (older servers that
   * advertise v1.11 but still serve legacy media).
   */
  private fetchBytes(
    client: MatrixClient,
    mxc: string,
    resize: { w: number; h: number } | null,
  ): Observable<ArrayBuffer> {
    return this.supportsAuthedMedia(client).pipe(
      switchMap((authed) => fetchMediaBytes(client, mxc, resize, authed)),
    );
  }

  /** Whether this client's homeserver supports authenticated media, cached unless unknown. */
  private supportsAuthedMedia(client: MatrixClient): Observable<boolean> {
    let probe = this.authedMedia.get(client);
    if (!probe) {
      const answer: Observable<boolean> = serverAdvertises(
        client,
        AUTHENTICATED_MEDIA,
      ).pipe(
        map((supported) => {
          if (supported !== null) return supported;
          // Unknown: ask again next time, and try authenticated media, which falls back to
          // legacy; legacy does not fall back, and servers may have turned it off.
          if (this.authedMedia.get(client) === answer) {
            this.authedMedia.delete(client);
          }
          return true;
        }),
        shareReplay(1),
      );
      probe = answer;
      this.authedMedia.set(client, probe);
    }
    return probe;
  }

  private store(key: string, blob: Blob): string {
    // Defensive: revoke an unpinned entry already at this key before replacing it so its object
    // URL can't leak. Pinned (on-screen) URLs are left for their owner to release.
    const prev = this.cache.get(key);
    if (prev) {
      this.cachedBytes -= prev.bytes;
      if (!this.pinned.has(prev.url)) {
        URL.revokeObjectURL(prev.url);
      }
    }
    const url = URL.createObjectURL(blob);
    this.cache.set(key, { url, blob, bytes: blob.size });
    this.cachedBytes += blob.size;
    this.evict(key);
    return url;
  }

  /**
   * Evict least recently used unpinned entries until the count and byte caps both hold.
   * `keep` is the entry just stored: its URL has not reached a component to be pinned yet,
   * so a single blob over the byte cap must survive until the next store, not be revoked
   * before it is ever shown.
   */
  private evict(keep: string): void {
    for (const [key, entry] of this.cache) {
      if (
        this.cache.size <= CACHE_LIMIT &&
        this.cachedBytes <= CACHE_BYTE_LIMIT
      ) {
        return;
      }
      if (key !== keep && !this.pinned.has(entry.url)) {
        this.cache.delete(key);
        this.cachedBytes -= entry.bytes;
        URL.revokeObjectURL(entry.url);
      }
    }
    // Falling out of the loop means everything left is pinned (on screen).
  }
}

function msgTypeFor(mime: string): MsgType {
  if (mime.startsWith('image/')) {
    return MsgType.Image;
  }
  if (mime.startsWith('video/')) {
    return MsgType.Video;
  }
  if (mime.startsWith('audio/')) {
    return MsgType.Audio;
  }
  return MsgType.File;
}

function mediaInfo(
  file: File,
  size: number,
  dims: { w?: number; h?: number; durationMs?: number },
  thumbnail: ThumbnailInfo | null,
): UploadedMedia['info'] {
  return {
    mimetype: file.type || 'application/octet-stream',
    size,
    ...(dims.w != null ? { w: dims.w } : {}),
    ...(dims.h != null ? { h: dims.h } : {}),
    ...(dims.durationMs != null ? { duration: dims.durationMs } : {}),
    ...(thumbnail ?? {}),
  };
}
