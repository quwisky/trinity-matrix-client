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
import { MsgType, type MatrixClient } from 'matrix-js-sdk';
import {
  decryptAttachment,
  displaySafeMime,
  encryptAttachment,
  mimeEssence,
} from '@trinity/util/matrix';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { fetchMediaBytes } from '@trinity/util/matrix';
import type { EncryptedFileInfo, MediaPayload } from '@trinity/util/matrix';
import type { MediaHints } from './media-pipeline.models';

/** Which rendition of an attachment to resolve. */
export type MediaVariant = 'thumbnail' | 'full';

/**
 * Everything {@link TimelineService} needs to build an outgoing media event from a
 * just-uploaded attachment. `mxc` is set for plaintext, `file` for encrypted (its
 * `url` already filled with the upload's `mxc://`); the `MsgType` stays inside core.
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

/** A client-rendered thumbnail blob plus its scaled dimensions. */
interface GeneratedThumbnail {
  blob: Blob;
  w: number;
  h: number;
}

/** The `content.info` thumbnail fields produced by {@link MediaService.uploadThumbnail}. */
type ThumbnailInfo = Pick<
  UploadedMedia['info'],
  'thumbnail_url' | 'thumbnail_file' | 'thumbnail_info'
>;

/** Probed dimensions/duration plus an optional rendered thumbnail for a picked file. */
interface MediaAnalysis {
  dims: { w?: number; h?: number; durationMs?: number };
  thumbnail: GeneratedThumbnail | null;
}

/**
 * Max edge (px) for both a server-generated thumbnail (when the event ships none)
 * and a client-rendered thumbnail produced at upload time.
 */
const THUMBNAIL_PX = 480;

/** Encoding for client-rendered thumbnails. */
const THUMBNAIL_MIME = 'image/jpeg';
const THUMBNAIL_QUALITY = 0.8;
/** PNG sources re-encode as WebP instead, which keeps their transparency. */
const THUMBNAIL_ALPHA_MIME = 'image/webp';

/**
 * Long edge (px) of the thumbnail rendered from a decrypted original that arrived
 * without one: 2x the 320 px the timeline displays, for HiDPI screens.
 */
const DECRYPTED_THUMBNAIL_PX = 640;

/**
 * The only types a thumbnail is rendered from. Anything else (GIF, WebP, AVIF, HEIF,
 * SVG, BMP, ICO, TIFF, ...) may be animated, vector, or carry an alpha channel that a
 * JPEG re-encode would flatten to black, so it is shown as sent.
 */
const DOWNSCALED_MIMES = new Set(['image/jpeg', 'image/jpg', 'image/png']);

/** How long to wait for an audio/video element to report its metadata. */
const METADATA_TIMEOUT_MS = 5000;

/** Seek offset (s) for the video poster frame — past any black/blank first frame. */
const POSTER_SEEK_SECONDS = 1;

/** How long to wait for the poster seek+decode before giving up (keeps the dims). */
const POSTER_TIMEOUT_MS = 3000;

/** Cap on cached object URLs; pinned (on-screen) entries are never evicted. */
const CACHE_LIMIT = 64;

/**
 * Cap on the blob bytes behind the cached URLs, enforced alongside {@link CACHE_LIMIT}.
 * The count alone says nothing about memory: 64 thumbnails are a few MB, but 64 full-size
 * photos (2-10 MB each) or videos are hundreds. 96 MB holds a dozen full-size photos or a
 * few hundred thumbnails, enough to scroll back through a conversation without refetching,
 * and still leaves a phone WebView room for the rest of the app. Pinned entries (on screen,
 * so the budget can be exceeded by what the user is actually looking at) are exempt.
 */
const CACHE_BYTE_LIMIT = 96 * 1024 * 1024;

interface CacheEntry {
  url: string;
  blob: Blob;
  /** `blob.size` recorded at creation, so the running total never re-reads blobs. */
  bytes: number;
}

interface MediaSource {
  mxc: string | null;
  file: EncryptedFileInfo | null;
  mimeType: string;
  /** Server-thumbnail dimensions, or null to download the resource as-is. */
  resize: { w: number; h: number } | null;
  /** Decrypted image to shrink to this long edge (px) before it is cached, or undefined. */
  downscaleTo?: number;
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
  /** Sum of {@link CacheEntry.bytes} over {@link cache}. */
  private cachedBytes = 0;
  /** In-flight resolutions, keyed like {@link cache}, so concurrent subscribers
   * to the same bytes share one fetch+decrypt instead of racing. */
  private readonly inFlight = new Map<string, Observable<string>>();
  /** Object URLs currently bound on screen — exempt from eviction. */
  private readonly pinned = new Set<string>();
  /** Fires on {@link releaseAll} to cancel in-flight resolutions before teardown. */
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
   * Resolve a cached `blob:` URL for the thumbnail or full rendition of a media
   * attachment. Re-resolving the same source+variant returns the cached URL
   * without re-fetching.
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
    // Share one fetch+decrypt across concurrent resolves of the same bytes — two
    // rows showing the same attachment, or an encrypted image's thumbnail and
    // lightbox (which resolve identical ciphertext) — instead of each fetching,
    // decrypting, and storing (the loser of which would leak its object URL).
    const pending = this.inFlight.get(key);
    if (pending) {
      return pending;
    }
    const obs = defer(() => this.fetchBlob(client, source)).pipe(
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
    client: MatrixClient = this.matrix.instance,
  ): Observable<{ blob: Blob; filename: string }> {
    const source = this.sourceFor(media, 'full');
    return defer(() => this.fetchBlob(client, source)).pipe(
      map((blob) => ({ blob, filename: media.filename })),
    );
  }

  /**
   * Upload a picked file to the media repo, encrypting it first for E2EE rooms,
   * and return the descriptor {@link TimelineService} turns into an event. In an
   * encrypted room the ciphertext is uploaded with no filename/MIME (those leak),
   * and `info.url` is filled with the resulting `mxc://`; otherwise the original
   * file is uploaded as-is. `progress` reports an upload fraction in [0, 1].
   * `hints` (from a camera capture) win over the probe, which then fills only
   * what they leave out.
   */
  uploadMedia(
    file: File,
    encrypt: boolean,
    progress?: (fraction: number) => void,
    abortController?: AbortController,
    client: MatrixClient = this.matrix.instance,
    hints?: MediaHints,
  ): Observable<UploadedMedia> {
    return defer(() =>
      from(
        this.doUpload(client, file, encrypt, progress, abortController, hints),
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
  ): Promise<UploadedMedia> {
    abortController?.signal.throwIfAborted();
    const msgtype = msgTypeFor(file.type);
    // What the capturing host already measured wins; the WebView probe runs only for what is
    // missing, and not at all when nothing is. For E2EE rooms the thumbnail is the *only* one
    // the timeline can show — the server can't scale an encrypted original.
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

    if (encrypt) {
      const { data, info } = await encryptAttachment(await file.arrayBuffer());
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

    const res = await client.uploadContent(file, {
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
      info: mediaInfo(file, file.size, dims, thumb),
    };
  }

  /**
   * Upload a freshly-rendered thumbnail — encrypting it for E2EE rooms with its
   * own key/iv/hash — and return the `content.info` thumbnail fields, or null when
   * there is no thumbnail. A thumbnail is an enhancement, never a gate: any failure
   * here resolves to null so the attachment still sends. Uploaded before the main
   * resource (it is small) so the `progress` callback tracks the dominant bytes.
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
    const { blob, w, h } = thumbnail;
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
      return null; // a thumbnail upload failure must never block the attachment
    }
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
    // Cancel in-flight resolutions first: with shareReplay(refCount:false) their
    // fetch+decrypt would otherwise run to completion and re-`store()` a fresh
    // object URL into the just-cleared cache, leaking decrypted bytes past teardown.
    this.release$.next();
    for (const { url } of this.cache.values()) {
      URL.revokeObjectURL(url);
    }
    this.cache.clear();
    this.cachedBytes = 0;
    this.inFlight.clear();
    this.pinned.clear();
    // Re-probe authed-media support on the next request: after a logout→login the
    // new account's homeserver may differ (e.g. legacy vs authenticated-only), and
    // a stale `false` would keep requesting the unauthenticated endpoint (401/404
    // with no fallback), breaking all media for the session.
    this.authedMedia = new WeakMap();
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
      // only — encrypted originals have no server-side thumbnail, so those images
      // are shrunk client-side after decryption instead).
      return {
        mxc: media.mxc,
        file: media.file,
        mimeType: media.mimeType,
        resize: media.file ? null : { w: THUMBNAIL_PX, h: THUMBNAIL_PX },
        ...(media.file && needsDownscale(media)
          ? { downscaleTo: DECRYPTED_THUMBNAIL_PX }
          : {}),
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
   * `full` — so they must share one cache entry (and one decrypt), not two. The
   * exception is a downscaled thumbnail, which is a different blob from the original.
   */
  private cacheKey(client: MatrixClient, source: MediaSource): string {
    const id = source.mxc ?? source.file?.url ?? '';
    let clientId = this.clientIds.get(client);
    if (clientId === undefined) {
      clientId = ++this.nextClientId;
      this.clientIds.set(client, clientId);
    }
    if (source.downscaleTo) {
      return `${clientId}|${id}|thumb${source.downscaleTo}`;
    }
    return source.resize
      ? `${clientId}|${id}|${source.resize.w}x${source.resize.h}`
      : `${clientId}|${id}|orig`;
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
    if (source.file) {
      // Encrypted attachment: download the ciphertext (always the full resource —
      // an encrypted original carries no server-side thumbnail) and decrypt it with
      // the event's per-file AES-CTR key. decryptAttachment verifies the SHA-256
      // hash and rejects on a mismatch, so tampered bytes never reach the DOM.
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
   * Fetch raw media bytes, choosing authenticated vs. legacy media based on
   * homeserver support and falling back to the legacy endpoint if an
   * authenticated request fails (older servers that advertise v1.11 but still
   * serve legacy media).
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

  /** Probe (once per exact client/account) whether its homeserver supports authenticated media. */
  private supportsAuthedMedia(client: MatrixClient): Observable<boolean> {
    let probe = this.authedMedia.get(client);
    if (!probe) {
      // `shareReplay(1)` runs the version probe once and replays the result to
      // every later subscriber — the Observable equivalent of the cached promise.
      probe = from(client.isVersionSupported('v1.11')).pipe(
        catchError(() => of(false)),
        shareReplay(1),
      );
      this.authedMedia.set(client, probe);
    }
    return probe;
  }

  /** Store a freshly-fetched blob under a cache key and return its object URL. */
  private store(key: string, blob: Blob): string {
    // Defensive: if an unpinned entry already sits at this key, revoke it before
    // replacing so its object URL can't leak. Pinned (on-screen) URLs are left for
    // their owner to release.
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

/** Map a MIME type to the Matrix message type for an attachment. */
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

/** Build `content.info`: mimetype/size plus probed dims/duration and a thumbnail. */
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

/**
 * Dimensions, duration and thumbnail for an upload. Hints from the host win; `analyzeMedia`
 * fills only what they leave out and is skipped when they leave out nothing.
 */
async function describeMedia(
  file: File,
  hints: MediaHints | undefined,
): Promise<MediaAnalysis> {
  const known = analysisFromHints(hints);
  if (isCompleteFor(file, known)) {
    return known;
  }
  const probed = await analyzeMedia(file);
  return {
    dims: {
      w: known.dims.w ?? probed.dims.w,
      h: known.dims.h ?? probed.dims.h,
      durationMs: known.dims.durationMs ?? probed.dims.durationMs,
    },
    thumbnail: known.thumbnail ?? probed.thumbnail,
  };
}

/** The usable part of host hints: a whole size pair, a duration, a bounded thumbnail. */
function analysisFromHints(hints: MediaHints | undefined): MediaAnalysis {
  if (!hints) {
    return { dims: {}, thumbnail: null };
  }
  const w = positiveInteger(hints.width);
  const h = positiveInteger(hints.height);
  const durationMs = positiveInteger(hints.durationMs);
  const hinted = hints.thumbnail;
  const thumbW = positiveInteger(hinted?.w);
  const thumbH = positiveInteger(hinted?.h);
  // A host thumbnail larger than the bound a rendered one gets counts as missing, so a
  // full-size frame never ships as a "thumbnail".
  const thumbnail =
    hinted &&
    hinted.blob.size > 0 &&
    thumbW !== undefined &&
    thumbH !== undefined &&
    Math.max(thumbW, thumbH) <= THUMBNAIL_PX
      ? { blob: hinted.blob, w: thumbW, h: thumbH }
      : null;
  return {
    dims: {
      ...(w !== undefined && h !== undefined ? { w, h } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    },
    thumbnail,
  };
}

/** Whether hints already say everything analysis would for this kind of file. */
function isCompleteFor(file: File, known: MediaAnalysis): boolean {
  const sized = known.dims.w !== undefined && known.dims.h !== undefined;
  if (file.type.startsWith('video/')) {
    return (
      sized && known.dims.durationMs !== undefined && known.thumbnail !== null
    );
  }
  if (file.type.startsWith('image/')) {
    return sized && known.thumbnail !== null;
  }
  return false;
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : undefined;
}

/**
 * Probe a picked file's intrinsic dimensions/duration and, for images, render a
 * downscaled thumbnail. Best-effort: anything undecodable yields empty dims and a
 * null thumbnail so the upload still proceeds. Audio/video duration is reported in
 * milliseconds to match the Matrix `info.duration` field.
 */
async function analyzeMedia(file: File): Promise<MediaAnalysis> {
  if (file.type.startsWith('image/')) {
    return analyzeImage(file);
  }
  if (file.type.startsWith('video/')) {
    return analyzeVideo(file);
  }
  if (file.type.startsWith('audio/')) {
    return { dims: await probeAudioDuration(file), thumbnail: null };
  }
  return { dims: {}, thumbnail: null };
}

/** Decode an image once: derive its dimensions and a scaled thumbnail. */
async function analyzeImage(file: File): Promise<MediaAnalysis> {
  // SVG can't be safely rasterized to a thumbnail and renders as a file card
  // anyway; createImageBitmap is absent outside a real browser/WebView.
  if (
    file.type === 'image/svg+xml' ||
    typeof createImageBitmap !== 'function'
  ) {
    return { dims: {}, thumbnail: null };
  }
  let bitmap: ImageBitmap;
  try {
    // `from-image` applies EXIF orientation during decode, so the thumbnail and
    // the recorded dimensions match the full image's orientation on every engine
    // (some older WebViews default to `none`).
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return { dims: {}, thumbnail: null }; // undecodable — omit rather than fail
  }
  try {
    const dims = { w: bitmap.width, h: bitmap.height };
    let thumbnail: GeneratedThumbnail | null = null;
    try {
      thumbnail = await renderThumbnail(bitmap);
    } catch {
      thumbnail = null; // thumbnail is best-effort — a render error must not fail the send
    }
    return { dims, thumbnail };
  } finally {
    bitmap.close();
  }
}

/**
 * Draw a decoded image onto a downscaled canvas and encode it as a JPEG. Returns
 * null when the image is already within the thumbnail bound (its original is a
 * fine thumbnail) or no 2D canvas is available.
 */
async function renderThumbnail(
  bitmap: ImageBitmap,
): Promise<GeneratedThumbnail | null> {
  if (typeof document === 'undefined') {
    return null;
  }
  const { w, h } = fitWithin(bitmap.width, bitmap.height, THUMBNAIL_PX);
  if (w >= bitmap.width && h >= bitmap.height) {
    return null; // already small — the original doubles as its own thumbnail
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return null;
  }
  ctx.drawImage(bitmap, 0, 0, w, h);
  const blob = await canvasToBlob(canvas, THUMBNAIL_MIME, THUMBNAIL_QUALITY);
  return blob ? { blob, w, h } : null;
}

/** Whether an attachment is a JPEG/PNG the event does not already say fits the thumbnail. */
function needsDownscale({ mimeType, width, height }: MediaPayload): boolean {
  const known = width && height ? Math.max(width, height) : Infinity;
  return (
    DOWNSCALED_MIMES.has(mimeEssence(mimeType)) &&
    known > DECRYPTED_THUMBNAIL_PX
  );
}

/** Whether PNG bytes carry an `acTL` (animation control) chunk before the first `IDAT`. */
function isAnimatedPng(bytes: ArrayBuffer): boolean {
  const view = new DataView(bytes);
  for (let at = 8; at + 8 <= view.byteLength;) {
    const type = String.fromCharCode(
      ...new Uint8Array(bytes, at + 4, 4), // chunk header: 4-byte length, 4-byte type
    );
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    at += 12 + view.getUint32(at); // header + data + CRC
  }
  return false;
}

/**
 * Shrink a decrypted image to at most `maxEdge` px on its long edge. Best-effort:
 * an image already that small, or any decode/resize/encode failure, yields the
 * original so a thumbnail never fails because it could not be shrunk.
 */
async function downscaleImage(blob: Blob, maxEdge: number): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') {
    return blob;
  }
  let decoded: ImageBitmap | undefined;
  let resized: ImageBitmap | undefined;
  const isPng = blob.type.toLowerCase() === 'image/png';
  try {
    if (isPng && isAnimatedPng(await blob.arrayBuffer())) {
      return blob; // an animated PNG would freeze on its first frame
    }
    // `from-image` applies EXIF orientation, as in analyzeImage.
    decoded = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const { w, h } = fitWithin(decoded.width, decoded.height, maxEdge);
    if (w >= decoded.width && h >= decoded.height) {
      return blob;
    }
    resized = await createImageBitmap(decoded, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high',
    });
    // The full-size bitmap is the big one: free it before the encode, not after.
    decoded.close();
    decoded = undefined;
    const encoded = await encodeBitmap(
      resized,
      w,
      h,
      isPng ? THUMBNAIL_ALPHA_MIME : THUMBNAIL_MIME,
    );
    return encoded && encoded.size < blob.size ? encoded : blob;
  } catch {
    return blob;
  } finally {
    decoded?.close();
    resized?.close();
  }
}

/** Draw a bitmap on an off-screen (else regular) canvas and encode it; null if it cannot. */
async function encodeBitmap(
  bitmap: ImageBitmap,
  w: number,
  h: number,
  type: string,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(w, h);
    const context = canvas.getContext('2d');
    if (!context) {
      return null;
    }
    context.drawImage(bitmap, 0, 0, w, h);
    return canvas.convertToBlob({ type, quality: THUMBNAIL_QUALITY });
  }
  if (typeof document === 'undefined') {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const context = canvas.getContext('2d');
  if (!context) {
    return null;
  }
  context.drawImage(bitmap, 0, 0, w, h);
  return canvasToBlob(canvas, type, THUMBNAIL_QUALITY);
}

/** Scale (w, h) to fit within a max edge, preserving aspect; never upscales. */
function fitWithin(
  w: number,
  h: number,
  max: number,
): { w: number; h: number } {
  if (w <= max && h <= max) {
    return { w, h };
  }
  const scale = Math.min(max / w, max / h);
  // Clamp to >= 1 so an extreme aspect ratio (e.g. 10000×1) can't round an edge
  // to 0 and yield a degenerate (zero-area) thumbnail descriptor.
  return {
    w: Math.max(1, Math.round(w * scale)),
    h: Math.max(1, Math.round(h * scale)),
  };
}

/** Promise wrapper around the callback-style `HTMLCanvasElement.toBlob`. */
function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => {
    if (typeof canvas.toBlob !== 'function') {
      resolve(null);
      return;
    }
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

/** A media element's duration in ms, or undefined when unknown/zero/infinite. */
function durationMsOf(el: HTMLMediaElement): number | undefined {
  return Number.isFinite(el.duration) && el.duration > 0
    ? Math.round(el.duration * 1000)
    : undefined;
}

/**
 * Load an audio file's metadata off-screen to read its duration (ms). Resolves to
 * empty (never rejects) on error, or if metadata doesn't arrive within
 * {@link METADATA_TIMEOUT_MS}, so a corrupt file can't stall the send.
 */
function probeAudioDuration(file: File): Promise<{ durationMs?: number }> {
  return new Promise((resolve) => {
    if (
      typeof document === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      resolve({});
      return;
    }
    let url: string;
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve({});
      return;
    }
    const el = document.createElement('audio');
    let settled = false;
    const finish = (result: { durationMs?: number }) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      el.onloadedmetadata = null;
      el.onerror = null;
      try {
        el.removeAttribute('src');
        el.load();
      } catch {
        /* element teardown is best-effort */
      }
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const timer = setTimeout(() => finish({}), METADATA_TIMEOUT_MS);
    el.preload = 'metadata';
    el.onloadedmetadata = () => finish({ durationMs: durationMsOf(el) });
    el.onerror = () => finish({});
    el.src = url;
  });
}

/**
 * Load a video off-screen to read its dimensions/duration and capture a poster
 * frame. Best-effort and non-blocking: metadata resolves first and is preserved
 * even if the poster seek/decode fails or times out ({@link POSTER_TIMEOUT_MS});
 * the whole probe is bounded by {@link METADATA_TIMEOUT_MS} so a corrupt file
 * can't stall the send.
 */
function analyzeVideo(file: File): Promise<MediaAnalysis> {
  const EMPTY: MediaAnalysis = { dims: {}, thumbnail: null };
  return new Promise((resolve) => {
    if (
      typeof document === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      resolve(EMPTY);
      return;
    }
    let url: string;
    try {
      url = URL.createObjectURL(file);
    } catch {
      resolve(EMPTY);
      return;
    }
    const video = document.createElement('video');
    let settled = false;
    const finish = (result: MediaAnalysis) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(metaTimer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.onseeked = null;
      try {
        video.removeAttribute('src');
        video.load();
      } catch {
        /* element teardown is best-effort */
      }
      URL.revokeObjectURL(url);
      resolve(result);
    };
    const metaTimer = setTimeout(() => finish(EMPTY), METADATA_TIMEOUT_MS);
    // `auto` so seeking can decode a frame to draw (metadata alone may not).
    video.preload = 'auto';
    video.muted = true;
    video.onerror = () => finish(EMPTY); // before metadata → total failure
    video.onloadedmetadata = () => {
      // Metadata arrived: retire the metadata timeout so it can't later fire and
      // discard the dims we now hold (a slow load + a longer poster wait could
      // otherwise let metaTimer win the race). The poster timeout governs from here.
      clearTimeout(metaTimer);
      const dims = {
        w: video.videoWidth || undefined,
        h: video.videoHeight || undefined,
        durationMs: durationMsOf(video),
      };
      // Metadata is in hand; a poster failure from here must NOT discard it.
      const posterTimer = setTimeout(
        () => finish({ dims, thumbnail: null }),
        POSTER_TIMEOUT_MS,
      );
      const finishWithPoster = (thumbnail: GeneratedThumbnail | null) => {
        clearTimeout(posterTimer);
        finish({ dims, thumbnail });
      };
      const capture = () =>
        drawPoster(video).then(finishWithPoster, () => finishWithPoster(null));
      video.onerror = () => finishWithPoster(null);
      video.onseeked = capture;
      // Seek a little past the start (clamped for short clips) to skip a black
      // opening frame; an unknown duration falls back to the first frame.
      const seekTo =
        Number.isFinite(video.duration) && video.duration > 0
          ? Math.min(POSTER_SEEK_SECONDS, video.duration / 2)
          : 0;
      if (seekTo === video.currentTime) {
        // No position change → no 'seeked' fires; capture the current frame now.
        capture();
      } else {
        try {
          video.currentTime = seekTo;
        } catch {
          finishWithPoster(null);
        }
      }
    };
    video.src = url;
  });
}

/** Draw the video's current frame onto a downscaled canvas and encode it as JPEG. */
function drawPoster(
  video: HTMLVideoElement,
): Promise<GeneratedThumbnail | null> {
  if (
    typeof document === 'undefined' ||
    !video.videoWidth ||
    !video.videoHeight
  ) {
    return Promise.resolve(null);
  }
  const { w, h } = fitWithin(video.videoWidth, video.videoHeight, THUMBNAIL_PX);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return Promise.resolve(null);
  }
  ctx.drawImage(video, 0, 0, w, h);
  return canvasToBlob(canvas, THUMBNAIL_MIME, THUMBNAIL_QUALITY).then((blob) =>
    blob ? { blob, w, h } : null,
  );
}
