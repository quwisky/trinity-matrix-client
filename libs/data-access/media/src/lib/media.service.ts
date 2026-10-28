import { Injectable, inject } from '@angular/core';
import {
  Observable,
  Subject,
  defer,
  filter,
  finalize,
  firstValueFrom,
  from,
  fromEvent,
  map,
  merge,
  of,
  shareReplay,
  switchMap,
  takeUntil,
  tap,
} from 'rxjs';
import {
  displaySafeMime,
  unwrapEngineResult,
  type EncryptedFileInfo,
  type MediaPayload,
} from '@trinity/util/matrix';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import type {
  MediaContent,
  MediaRequest,
  UploadRequest,
  UploadedContent,
} from './media-engine';
import { MEDIA_ENGINE } from './media-engine.token';
import type { ImageMetadataPolicy, MediaHints } from './media-pipeline.models';
import {
  bytesWithoutMediaMetadata,
  withoutImageMetadata,
  withoutMediaMetadata,
} from './image-metadata/strip-file-metadata';
import { DEVICE_PIXEL_RATIO, displayThumbnailEdge } from './thumbnail-size';
import {
  describeMedia,
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
  msgtype: 'm.image' | 'm.video' | 'm.audio' | 'm.file';
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
  /** The size the engine reported, so the running total never re-reads blobs. */
  bytes: number;
}

/** A resolution under way, shared by everyone resolving the same bytes meanwhile. */
interface InFlight {
  readonly result: Observable<string>;
  waiters: number;
  /** Abandons the resolution before it stores anything (see {@link MediaService.drop}). */
  readonly cancel: Subject<void>;
}

/** The account a request runs on, and the session it ran in, for the cache key. */
interface AccountSession {
  readonly id: string;
  readonly generation: number;
}

/**
 * Resolves Matrix media (`mxc://` plaintext or encrypted `content.file`) into URLs the UI can
 * bind to `<img>`/`<video>`/`<a download>`, through the {@link MediaEngine}.
 *
 * Owns the object-URL lifecycle: a bounded cache keyed by account session, source and variant,
 * where on-screen URLs are {@link pin}ned and never evicted, and {@link releaseAll} releases
 * everything on room close / logout. The engine mints each URL and verifies encrypted bytes
 * against their hash, so a tampered blob never reaches the DOM.
 */
@Injectable({ providedIn: 'root' })
export class MediaService {
  private readonly engine = inject(MEDIA_ENGINE);
  private readonly session = inject(SessionStateService);
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

  /**
   * Resolve a cached URL for the thumbnail or full rendition of an attachment; the same
   * source+variant is not refetched. `accountId` defaults to the active account.
   */
  resolveMedia(
    media: MediaPayload,
    variant: MediaVariant,
    accountId?: string,
  ): Observable<string> {
    const account = this.account(accountId);
    const request = this.requestFor(media, variant);
    const key = this.cacheKey(account, request);
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
    const shared = defer(() => this.engine.content(account.id, request)).pipe(
      unwrapEngineResult(),
      // Cancel on releaseAll or a drop BEFORE store(): unsubscribing stops the engine before it
      // mints a URL, so a late completion cannot insert one into a cache that no longer wants it.
      takeUntil(merge(this.release$, cancel)),
      map((content) => this.store(key, content)),
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
    accountId?: string,
  ): Observable<{ blob: Blob; filename: string }> {
    return defer(() =>
      this.engine.content(
        this.account(accountId).id,
        this.requestFor(media, 'full'),
      ),
    ).pipe(
      unwrapEngineResult(),
      switchMap(({ url }) => from(this.readOnce(url))),
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
   * a derived preview. `accountId` defaults to the active account.
   */
  uploadMedia(
    file: File,
    encrypt: boolean,
    progress?: (fraction: number) => void,
    abortController?: AbortController,
    accountId?: string,
    hints?: MediaHints,
    imageMetadata: ImageMetadataPolicy = 'strip',
  ): Observable<UploadedMedia> {
    return defer(() =>
      from(
        this.doUpload(
          this.account(accountId).id,
          file,
          encrypt,
          progress,
          abortController?.signal,
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
  uploadLimit(accountId?: string): Observable<number | null> {
    return defer(() =>
      this.engine.uploadLimit(this.account(accountId).id),
    ).pipe(map((result) => (result.ok ? result.value : null)));
  }

  private async doUpload(
    accountId: string,
    file: File,
    encrypt: boolean,
    progress?: (fraction: number) => void,
    signal?: AbortSignal,
    hints?: MediaHints,
    imageMetadata: ImageMetadataPolicy = 'strip',
  ): Promise<UploadedMedia> {
    signal?.throwIfAborted();
    const msgtype = msgTypeFor(file.type);
    // Host-measured values win; the WebView probe runs only for what is missing. For E2EE rooms
    // the thumbnail is the only one the timeline can show: the server can't scale an encrypted
    // original.
    const { dims, thumbnail } = await describeMedia(file, hints);
    signal?.throwIfAborted();
    const thumb = await this.uploadThumbnail(
      accountId,
      thumbnail,
      encrypt,
      signal,
    );

    // Stripping happens on the plaintext, before the engine encrypts it; anything it cannot
    // handle with certainty uploads as picked. Keeping metadata (the opt-in) uploads the file
    // untouched, never a partial strip.
    const keep = imageMetadata === 'keep';
    let upload: Blob = file;
    if (!keep) {
      upload = encrypt
        ? new Blob([await bytesWithoutMediaMetadata(file)])
        : await withoutMediaMetadata(file);
    }
    signal?.throwIfAborted();
    const uploaded = await this.send(
      accountId,
      upload,
      {
        filename: encrypt ? null : file.name,
        mimeType: encrypt
          ? 'application/octet-stream'
          : file.type || 'application/octet-stream',
        encrypt,
      },
      progress,
      signal,
    );
    return {
      msgtype,
      body: file.name || 'attachment',
      mxc: uploaded.kind === 'plain' ? uploaded.mxc : null,
      file: uploaded.kind === 'encrypted' ? uploaded.file : null,
      info: mediaInfo(file, uploaded.size, dims, thumb),
    };
  }

  /**
   * Upload a freshly-rendered thumbnail (encrypted with its own key/iv/hash for E2EE rooms)
   * and return the `content.info` thumbnail fields, or null when there is none. Any failure
   * resolves to null: a thumbnail is never a gate for sending. Uploaded before the main
   * resource (it is small) so `progress` tracks the dominant bytes.
   */
  private async uploadThumbnail(
    accountId: string,
    thumbnail: GeneratedThumbnail | null,
    encrypt: boolean,
    signal?: AbortSignal,
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
      const uploaded = await this.send(
        accountId,
        blob,
        encrypt
          ? {
              filename: null,
              mimeType: 'application/octet-stream',
              encrypt: true,
            }
          : { filename: 'thumbnail', mimeType: blob.type, encrypt: false },
        undefined,
        signal,
      );
      return uploaded.kind === 'encrypted'
        ? { thumbnail_file: uploaded.file, thumbnail_info }
        : { thumbnail_url: uploaded.mxc, thumbnail_info };
    } catch (error: unknown) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  /** One engine upload as a promise; an abort unsubscribes, which stops the upload. */
  private async send(
    accountId: string,
    blob: Blob,
    request: UploadRequest,
    progress?: (fraction: number) => void,
    signal?: AbortSignal,
  ): Promise<UploadedContent> {
    signal?.throwIfAborted();
    const updates = this.engine.upload(accountId, blob, request).pipe(
      tap((update) => {
        if (update.kind === 'progress') progress?.(update.fraction);
      }),
      filter((update) => update.kind === 'done'),
      map((update) => update.result),
      unwrapEngineResult(),
    );
    try {
      return await firstValueFrom(
        signal ? updates.pipe(takeUntil(fromEvent(signal, 'abort'))) : updates,
      );
    } catch (error: unknown) {
      signal?.throwIfAborted();
      throw error;
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
   * pin is released; only if no other view still pins it is the URL released and the entry
   * removed, and only while the cache still holds it for `rendition`, so a URL from before a
   * {@link releaseAll} cannot release its successor. A resolve of `rendition` still in flight
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
      accountId?: string;
    },
  ): void {
    const key = this.cacheKey(
      this.account(rendition.accountId),
      this.requestFor(rendition.media, rendition.variant),
    );
    if (url) {
      this.unpin(url);
      const entry = this.cache.get(key);
      if (entry?.url === url && !this.pinned.has(url)) {
        this.cache.delete(key);
        this.cachedBytes -= entry.bytes;
        this.release([url]);
      }
    }
    const pending = this.inFlight.get(key);
    if (pending && pending.waiters === 0) {
      this.inFlight.delete(key);
      pending.cancel.next();
    }
  }

  /**
   * Release every cached URL that is not on screen, so a hidden app holds only what it
   * shows. Unlike {@link releaseAll}, in-flight work and pins survive: the next use of a
   * released source simply fetches it again.
   */
  releaseUnpinned(): void {
    const released: string[] = [];
    for (const [key, entry] of this.cache) {
      if (this.pinned.has(entry.url)) continue;
      this.cache.delete(key);
      this.cachedBytes -= entry.bytes;
      released.push(entry.url);
    }
    this.release(released);
  }

  /** Release every cached URL and clear the cache (room close / logout). */
  releaseAll(): void {
    // Cancel in-flight resolutions first: with shareReplay(refCount:false) their fetch+decrypt
    // would otherwise finish and re-`store()` a URL into the cleared cache, leaking decrypted
    // bytes past teardown.
    this.release$.next();
    this.release([...this.cache.values()].map(({ url }) => url));
    this.cache.clear();
    this.cachedBytes = 0;
    this.inFlight.clear();
    this.pinned.clear();
    // Re-probe authed-media support on the next request: after logout→login the new homeserver
    // may differ, and a stale `false` would keep requesting the unauthenticated endpoint
    // (401/404 with no fallback), breaking all media for the session.
    this.engine.forgetProbes().subscribe();
  }

  /** The named account, or the active one, with the session generation it is live in now. */
  private account(accountId: string | undefined): AccountSession {
    const id = accountId ?? this.session.activeAccountId() ?? '';
    return { id, generation: this.session.status(id)?.generation ?? 0 };
  }

  /**
   * What to ask the engine for. Attachments display only safe media types: the declared type is
   * kept only when it is a known image, video or audio type, otherwise the bytes are opaque and
   * the filename carries the extension.
   */
  private requestFor(media: MediaPayload, variant: MediaVariant): MediaRequest {
    const FILE = { kind: 'file' } as const;
    if (variant === 'thumbnail') {
      const mimeType = displaySafeMime(
        media.thumbnailMimeType ?? media.mimeType,
      );
      if (media.thumbnailFile) {
        return {
          source: { kind: 'encrypted', file: media.thumbnailFile },
          format: FILE,
          mimeType,
          downscaleTo: null,
        };
      }
      if (media.thumbnailMxc) {
        return {
          source: { kind: 'plain', mxc: media.thumbnailMxc },
          format: FILE,
          mimeType,
          downscaleTo: null,
        };
      }
      // No bundled thumbnail: ask the server to scale the original (plaintext only; encrypted
      // originals have no server-side thumbnail and are shrunk client-side after decryption).
      // Sizes follow the current screen; resolved thumbnails are not refetched when it changes,
      // and the edge is part of the cache key so buckets never mix.
      const edge = displayThumbnailEdge(this.devicePixelRatio());
      if (media.file) {
        return {
          source: { kind: 'encrypted', file: media.file },
          format: FILE,
          mimeType: displaySafeMime(media.mimeType),
          downscaleTo: needsDownscale(media, edge) ? edge : null,
        };
      }
      return {
        source: { kind: 'plain', mxc: media.mxc ?? '' },
        format: {
          kind: 'thumbnail',
          width: edge,
          height: edge,
          method: 'scale',
          animated: false,
        },
        mimeType: displaySafeMime(media.mimeType),
        downscaleTo: null,
      };
    }
    return {
      source: media.file
        ? { kind: 'encrypted', file: media.file }
        : { kind: 'plain', mxc: media.mxc ?? '' },
      format: FILE,
      mimeType: displaySafeMime(media.mimeType),
      downscaleTo: null,
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
   * since it becomes the Blob's type. The account's session generation is part of both too,
   * so a re-login never serves bytes resolved under the old session. The parts are
   * JSON-encoded so no field's content can shift into its neighbour.
   */
  private cacheKey(account: AccountSession, request: MediaRequest): string {
    const { source, format, mimeType, downscaleTo } = request;
    if (source.kind === 'encrypted') {
      const { file } = source;
      return JSON.stringify([
        'e',
        account.id,
        account.generation,
        file.url,
        file.hashes?.['sha256'] ?? '',
        file.key?.k ?? '',
        file.iv,
        file.v ?? '',
        mimeType,
        downscaleTo ? `thumb${downscaleTo}` : 'orig',
      ]);
    }
    return JSON.stringify([
      'p',
      account.id,
      account.generation,
      source.mxc,
      mimeType,
      format.kind === 'thumbnail' ? `${format.width}x${format.height}` : 'orig',
    ]);
  }

  /** The bytes behind a URL the engine minted for this read alone, released once read. */
  private async readOnce(url: string): Promise<Blob> {
    try {
      const response = await fetch(url);
      if (!response.ok)
        throw new Error(`Media read failed: ${response.status}`);
      return await response.blob();
    } finally {
      this.release([url]);
    }
  }

  private release(urls: readonly string[]): void {
    if (urls.length > 0) this.engine.release(urls).subscribe();
  }

  private store(key: string, content: MediaContent): string {
    // Defensive: release an unpinned entry already at this key before replacing it so its URL
    // can't leak. Pinned (on-screen) URLs are left for their owner to release.
    const prev = this.cache.get(key);
    if (prev) {
      this.cachedBytes -= prev.bytes;
      if (!this.pinned.has(prev.url)) {
        this.release([prev.url]);
      }
    }
    this.cache.set(key, { url: content.url, bytes: content.size });
    this.cachedBytes += content.size;
    this.evict(key);
    return content.url;
  }

  /**
   * Evict least recently used unpinned entries until the count and byte caps both hold.
   * `keep` is the entry just stored: its URL has not reached a component to be pinned yet,
   * so a single blob over the byte cap must survive until the next store, not be released
   * before it is ever shown.
   */
  private evict(keep: string): void {
    const evicted: string[] = [];
    for (const [key, entry] of this.cache) {
      if (
        this.cache.size <= CACHE_LIMIT &&
        this.cachedBytes <= CACHE_BYTE_LIMIT
      ) {
        break;
      }
      if (key !== keep && !this.pinned.has(entry.url)) {
        this.cache.delete(key);
        this.cachedBytes -= entry.bytes;
        evicted.push(entry.url);
      }
    }
    // Leaving the loop over the caps means everything left is pinned (on screen).
    this.release(evicted);
  }
}

function msgTypeFor(mime: string): UploadedMedia['msgtype'] {
  if (mime.startsWith('image/')) {
    return 'm.image';
  }
  if (mime.startsWith('video/')) {
    return 'm.video';
  }
  if (mime.startsWith('audio/')) {
    return 'm.audio';
  }
  return 'm.file';
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
