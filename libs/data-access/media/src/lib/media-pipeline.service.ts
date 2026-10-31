import { Injectable, inject, untracked } from '@angular/core';
import { Observable, defer, from, of, switchMap, throwError } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  mediaCaptionFields,
  type EncryptedFileInfo,
  type MediaPayload,
} from '@trinity/util/matrix';
import { MediaService } from './media.service';
import type { AttachmentRequest } from './media-engine';
import { MEDIA_ENGINE } from './media-engine.token';
import {
  strippedMedia,
  withoutImageMetadata,
} from './image-metadata/strip-file-metadata';
import { describeMedia, msgTypeFor } from './media-processing';
import type {
  ImageMetadataPolicy,
  MediaHints,
  MediaStageOutcome,
  MediaTransferEvent,
  MediaTransferFailure,
  MediaTransferRequest,
  PresentedMediaReference,
  StagedMediaReference,
} from './media-pipeline.models';

/** The engine key an upload went out under, and what it did with the file's metadata. */
interface TargetUpload {
  readonly attachmentKey: string;
  readonly imageMetadata: ImageMetadataPolicy;
}

interface StagedEntry {
  readonly file: File;
  /** The last upload per conversation and thread, oldest first. */
  readonly uploads: Map<string, TargetUpload>;
  /** Every key handed to the engine, forgotten with the staged file. */
  readonly keys: Set<string>;
}

interface PresentedEntry {
  readonly media: MediaPayload;
  readonly accountId: string;
}

type PreparedAttachment = Omit<
  AttachmentRequest,
  'attachmentKey' | 'supersedes' | 'threadRootId' | 'caption' | 'captionFields'
>;

let nextStagedId = 0;
let nextPresentedId = 0;
const MAX_CACHED_TARGETS_PER_STAGED_FILE = 2;

/**
 * Deep attachment boundary: opaque staging, encrypted Matrix transfer, safe presentation,
 * cancellation/retry, progress, and delegation to the bounded decrypted-byte cache.
 */
@Injectable({ providedIn: 'root' })
export class MediaPipeline {
  private readonly engine = inject(MEDIA_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly bytes = inject(MediaService);
  private readonly staged = new WeakMap<StagedMediaReference, StagedEntry>();
  private readonly liveStaged = new Set<StagedMediaReference>();
  // Retained MessageViews own these references across Workspace switches. Weak keys
  // release their opaque sources with the views, independently of the byte cache.
  private readonly presented = new WeakMap<
    PresentedMediaReference,
    PresentedEntry
  >();

  stage(file: File, hints?: MediaHints): MediaStageOutcome {
    if (!file || file.size === 0) {
      return { kind: 'rejected', failure: 'empty-file', retryable: false };
    }
    // An image previews as itself; a captured video previews from the poster its host
    // rendered. Anything else has no preview until it is sent.
    const previewSource = file.type.startsWith('image/')
      ? file
      : file.type.startsWith('video/')
        ? (hints?.thumbnail?.blob ?? null)
        : null;
    const reference = Object.freeze({
      id: `staged-media-${++nextStagedId}`,
      filename: file.name || 'attachment',
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      previewUrl: previewSource ? URL.createObjectURL(previewSource) : null,
      ...(hints ? { hints: Object.freeze({ ...hints }) } : {}),
    }) as StagedMediaReference;
    this.staged.set(reference, {
      file,
      uploads: new Map(),
      keys: new Set(),
    });
    this.liveStaged.add(reference);
    return { kind: 'staged', media: reference };
  }

  hasStaged(reference: StagedMediaReference): boolean {
    return this.staged.has(reference);
  }

  releaseStaged(reference: StagedMediaReference): void {
    if (!this.liveStaged.delete(reference)) return;
    if (reference.previewUrl) URL.revokeObjectURL(reference.previewUrl);
    for (const key of this.staged.get(reference)?.keys ?? []) {
      this.engine.forgetAttachment(key).subscribe();
    }
    this.staged.delete(reference);
  }

  /** The upload limit of the account's homeserver, or null when unknown. */
  uploadLimit(accountId: string | null): Observable<number | null> {
    return defer(() =>
      accountId && this.isLive(accountId)
        ? this.bytes.uploadLimit(accountId)
        : of(null),
    );
  }

  transfer(request: MediaTransferRequest): Observable<MediaTransferEvent> {
    return defer(() => {
      const entry = this.staged.get(request.media);
      if (!entry) {
        return of({
          kind: 'rejected' as const,
          failure: 'staged-media-unavailable' as const,
          retryable: false,
        });
      }
      const { accountId, roomId } = request.key;
      const threadRootId = request.threadRootId ?? null;
      const targetKey = JSON.stringify([accountId, roomId, threadRootId]);
      const previous = entry.uploads.get(targetKey);
      // A stripped upload may serve a request that would keep metadata: it discloses less.
      const imageMetadata: ImageMetadataPolicy =
        previous?.imageMetadata === 'strip'
          ? 'strip'
          : (request.imageMetadata ?? 'strip');
      const attachmentKey = JSON.stringify([
        request.media.id,
        accountId,
        roomId,
        threadRootId,
        imageMetadata,
      ]);
      // Only kept-then-stripped changes the key for a target: the kept upload's echo goes.
      const supersedes =
        previous && previous.attachmentKey !== attachmentKey
          ? previous.attachmentKey
          : undefined;
      entry.keys.add(attachmentKey);

      return new Observable<MediaTransferEvent>((subscriber) => {
        let started = false;
        let sending = false;
        const emit = (event: MediaTransferEvent): void => {
          if (!started) {
            started = true;
            subscriber.next({
              kind: 'progress',
              phase: 'validating',
              fraction: 0,
            });
            if (subscriber.closed) return;
          }
          subscriber.next(event);
        };
        const reject = (
          failure: MediaTransferFailure,
          retryable: boolean,
        ): void => {
          const event = { kind: 'rejected', failure, retryable } as const;
          // A conversation that is gone rejects before any progress, as nothing was tried.
          if (failure === 'conversation-unavailable') subscriber.next(event);
          else emit(event);
          subscriber.complete();
        };

        const subscription = from(
          prepare(entry.file, request.media.hints, imageMetadata),
        )
          .pipe(
            switchMap((prepared) =>
              this.engine.sendAttachment(accountId, roomId, {
                ...prepared,
                attachmentKey,
                ...(supersedes === undefined ? {} : { supersedes }),
                threadRootId,
                caption: request.caption,
                captionFields: mediaCaptionFields(
                  prepared.filename || 'attachment',
                  request.caption,
                ),
              }),
            ),
          )
          .subscribe({
            next: (update) => {
              if (update.kind === 'progress') {
                if (update.phase === 'sending' && !sending) {
                  sending = true;
                  this.retain(entry, targetKey, {
                    attachmentKey,
                    imageMetadata,
                  });
                }
                emit({
                  kind: 'progress',
                  phase: update.phase,
                  fraction: Math.max(0, Math.min(1, update.fraction)),
                });
                return;
              }
              const { result } = update;
              if (!result.ok) {
                const { code } = result.failure;
                if (
                  code === 'account-not-live' ||
                  code === 'conversation-unavailable'
                ) {
                  reject('conversation-unavailable', false);
                } else {
                  reject(
                    sending || code === 'encryption-unavailable'
                      ? 'send-rejected'
                      : 'upload-rejected',
                    true,
                  );
                }
                return;
              }
              const outcome = result.value;
              if (outcome.kind === 'sent') {
                this.releaseStaged(request.media);
                emit({ kind: 'sent', eventId: outcome.eventId });
              } else {
                emit({
                  kind: 'indeterminate',
                  failure: outcome.reason,
                  retryable: true,
                });
              }
              subscriber.complete();
            },
            // A local fault preparing, reading or encrypting the file.
            error: () =>
              reject(sending ? 'send-rejected' : 'upload-rejected', true),
          });
        return () => subscription.unsubscribe();
      });
    });
  }

  /** Presents `media` for an Account; the active one when omitted. */
  present(media: MediaPayload, accountId?: string): PresentedMediaReference {
    const reference = Object.freeze({
      id: `presented-media-${++nextPresentedId}`,
      kind: media.kind,
      filename: media.filename,
      mimeType: media.mimeType,
      ...(media.size === undefined ? {} : { size: media.size }),
      ...(media.width === undefined ? {} : { width: media.width }),
      ...(media.height === undefined ? {} : { height: media.height }),
      ...(media.durationMs === undefined
        ? {}
        : { durationMs: media.durationMs }),
      ...(media.thumbnailMxc || media.thumbnailFile
        ? { hasThumbnail: true }
        : {}),
      ...(media.isVoice ? { isVoice: true } : {}),
      ...(media.waveform
        ? { waveform: Object.freeze([...media.waveform]) }
        : {}),
    }) as PresentedMediaReference;
    this.presented.set(reference, {
      media,
      // Callers present inside effects: reading the session must not make them track it.
      accountId:
        accountId ?? untracked(() => this.session.activeAccountId()) ?? '',
    });
    return reference;
  }

  /**
   * Whether two references present the same bytes for the same account: one message projected
   * twice (a receipt or reaction re-projects it, minting a new reference) rather than an edit
   * that changed its file. A reference whose source is gone matches only itself.
   */
  sameMedia(a: PresentedMediaReference, b: PresentedMediaReference): boolean {
    if (a === b) return true;
    const x = this.presented.get(a);
    const y = this.presented.get(b);
    if (!x || !y || x.accountId !== y.accountId) return false;
    return mediaIdentity(x.media) === mediaIdentity(y.media);
  }

  resolveMedia(
    reference: PresentedMediaReference,
    variant: 'thumbnail' | 'full',
  ): Observable<string> {
    return defer(() => {
      const source = this.liveSource(reference);
      return source
        ? this.bytes.resolveMedia(source.media, variant, source.accountId)
        : throwError(() => new Error('Media reference is no longer available'));
    });
  }

  downloadMedia(
    reference: PresentedMediaReference,
  ): Observable<{ blob: Blob; filename: string }> {
    return defer(() => {
      const source = this.liveSource(reference);
      return source
        ? this.bytes.downloadMedia(source.media, source.accountId)
        : throwError(() => new Error('Media reference is no longer available'));
    });
  }

  pin(url: string | null): void {
    this.bytes.pin(url);
  }

  unpin(url: string | null): void {
    this.bytes.unpin(url);
  }

  /**
   * Release this caller's pin on a resolved rendition and free it unless another view still
   * pins it; see {@link MediaService.drop}. Unsubscribe from the rendition's resolve first.
   * For a reference whose Account has since gone it only releases the pin, leaving
   * the bytes to ordinary eviction.
   */
  drop(
    reference: PresentedMediaReference,
    variant: 'thumbnail' | 'full',
    url: string | null,
  ): void {
    const entry = this.presented.get(reference);
    if (entry && this.isLive(entry.accountId)) {
      this.bytes.drop(url, {
        media: entry.media,
        variant,
        accountId: entry.accountId,
      });
    } else {
      this.bytes.unpin(url);
    }
  }

  /** Release view resources without retiring references owned by retained messages. */
  releaseAll(): void {
    for (const staged of [...this.liveStaged]) this.releaseStaged(staged);
    this.bytes.releaseAll();
  }

  private liveSource(
    reference: PresentedMediaReference,
  ): PresentedEntry | undefined {
    const entry = this.presented.get(reference);
    return entry && this.isLive(entry.accountId) ? entry : undefined;
  }

  private isLive(accountId: string): boolean {
    return untracked(() => this.session.status(accountId)) !== null;
  }

  /** Records the upload a target now holds, forgetting the oldest beyond the cap. */
  private retain(
    entry: StagedEntry,
    targetKey: string,
    upload: TargetUpload,
  ): void {
    if (entry.uploads.get(targetKey)?.attachmentKey === upload.attachmentKey) {
      return;
    }
    entry.uploads.delete(targetKey);
    entry.uploads.set(targetKey, upload);
    while (entry.uploads.size > MAX_CACHED_TARGETS_PER_STAGED_FILE) {
      const [oldest, evicted] = entry.uploads.entries().next().value as [
        string,
        TargetUpload,
      ];
      entry.uploads.delete(oldest);
      entry.keys.delete(evicted.attachmentKey);
      this.engine.forgetAttachment(evicted.attachmentKey).subscribe();
    }
  }
}

/**
 * The file ready for the engine: described, its thumbnail and (unless kept) itself stripped
 * on the plaintext, before any encryption. A strip that throws hands over the file as picked,
 * marked so an encrypted room refuses it.
 */
async function prepare(
  file: File,
  hints: MediaHints | undefined,
  imageMetadata: ImageMetadataPolicy,
): Promise<PreparedAttachment> {
  // Host-measured values win; the WebView probe runs only for what is missing.
  const { dims, thumbnail } = await describeMedia(file, hints);
  // A host-rendered thumbnail is an image file of its own: it loses its metadata like any
  // photo, even when the person keeps the video's own, being a derived preview.
  const thumb =
    thumbnail &&
    (await withoutImageMetadata(
      new File([thumbnail.blob], 'thumbnail', { type: thumbnail.blob.type }),
    ));
  let upload: Blob = file;
  let metadata: AttachmentRequest['metadata'] = 'kept';
  if (imageMetadata === 'strip') {
    try {
      upload = await strippedMedia(file);
      metadata = 'stripped';
    } catch {
      metadata = 'strip-failed';
    }
  }
  return {
    file: upload,
    filename: file.name,
    mimeType: file.type || 'application/octet-stream',
    msgtype: msgTypeFor(file.type),
    info: {
      w: dims.w ?? null,
      h: dims.h ?? null,
      durationMs: dims.durationMs ?? null,
    },
    thumbnail:
      thumbnail && thumb
        ? { blob: thumb, mimeType: thumb.type, w: thumbnail.w, h: thumbnail.h }
        : null,
    metadata,
  };
}

/**
 * What a rendition is fetched from: the media, its bundled thumbnail and their types. An
 * encrypted file counts with its key, iv, hash and version, since another event can name
 * the same `file.url` with different ones.
 */
function mediaIdentity(media: MediaPayload): string {
  return JSON.stringify([
    media.kind,
    media.mimeType,
    media.mxc,
    fileIdentity(media.file),
    media.thumbnailMxc,
    fileIdentity(media.thumbnailFile),
    media.thumbnailMimeType ?? null,
  ]);
}

function fileIdentity(file: EncryptedFileInfo | null): unknown[] | null {
  return (
    file && [file.url, file.hashes?.['sha256'], file.key?.k, file.iv, file.v]
  );
}
