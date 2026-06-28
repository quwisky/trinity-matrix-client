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
import { MsgType } from 'matrix-js-sdk';
import { decryptAttachment, encryptAttachment } from './attachment-crypto';
import { MatrixClientService } from './matrix-client.service';
import type { EncryptedFileInfo, MediaPayload } from './media.model';

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

/** How long to wait for an audio/video element to report its metadata. */
const METADATA_TIMEOUT_MS = 5000;

/** Seek offset (s) for the video poster frame — past any black/blank first frame. */
const POSTER_SEEK_SECONDS = 1;

/** How long to wait for the poster seek+decode before giving up (keeps the dims). */
const POSTER_TIMEOUT_MS = 3000;

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

  /**
   * Upload a picked file to the media repo, encrypting it first for E2EE rooms,
   * and return the descriptor {@link TimelineService} turns into an event. In an
   * encrypted room the ciphertext is uploaded with no filename/MIME (those leak),
   * and `info.url` is filled with the resulting `mxc://`; otherwise the original
   * file is uploaded as-is. `progress` reports an upload fraction in [0, 1].
   */
  uploadMedia(
    file: File,
    encrypt: boolean,
    progress?: (fraction: number) => void,
  ): Observable<UploadedMedia> {
    return defer(() => from(this.doUpload(file, encrypt, progress)));
  }

  private async doUpload(
    file: File,
    encrypt: boolean,
    progress?: (fraction: number) => void,
  ): Promise<UploadedMedia> {
    const client = this.matrix.instance;
    const msgtype = msgTypeFor(file.type);
    // Probe dimensions/duration and (for images) render a downscaled thumbnail
    // before the main upload. For E2EE rooms this is the *only* thumbnail the
    // timeline can show — the server can't scale an encrypted original — so
    // without it every image row would fetch and decrypt the full-size bytes.
    const { dims, thumbnail } = await analyzeMedia(file);
    const thumb = await this.uploadThumbnail(thumbnail, encrypt);
    const onProgress = progress
      ? (p: { loaded: number; total: number }) =>
          progress(p.total ? p.loaded / p.total : 0)
      : undefined;

    if (encrypt) {
      const { data, info } = await encryptAttachment(await file.arrayBuffer());
      const res = await client.uploadContent(new Blob([data]), {
        // Don't leak the plaintext filename/MIME on an encrypted upload.
        includeFilename: false,
        type: 'application/octet-stream',
        progressHandler: onProgress,
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
    thumbnail: GeneratedThumbnail | null,
    encrypt: boolean,
  ): Promise<ThumbnailInfo | null> {
    if (!thumbnail) {
      return null;
    }
    const client = this.matrix.instance;
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
        });
        info.url = res.content_uri;
        return { thumbnail_file: info, thumbnail_info };
      }
      const res = await client.uploadContent(blob, {
        name: 'thumbnail',
        type: blob.type,
      });
      return { thumbnail_url: res.content_uri, thumbnail_info };
    } catch {
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
