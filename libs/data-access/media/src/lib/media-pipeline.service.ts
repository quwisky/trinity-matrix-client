import { Injectable, inject } from '@angular/core';
import {
  EMPTY,
  Observable,
  Subscription,
  defer,
  from,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import {
  EventStatus,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  isRoomEncrypted,
  mediaCaptionFields,
  type EncryptedFileInfo,
  type MediaPayload,
} from '@trinity/util/matrix';
import { MediaService, type UploadedMedia } from './media.service';
import type {
  ImageMetadataPolicy,
  MediaHints,
  MediaStageOutcome,
  MediaTransferEvent,
  MediaTransferRequest,
  PresentedMediaReference,
  StagedMediaReference,
} from './media-pipeline.models';

interface CachedUpload {
  readonly media: UploadedMedia;
  /** What the upload did with the photo's metadata, so a retry can honour a change. */
  readonly imageMetadata: ImageMetadataPolicy;
  txnId: string;
  pendingEvent: MatrixEvent | null;
  pendingCaption: string | null;
}

interface StagedEntry {
  readonly file: File;
  readonly uploads: Map<string, CachedUpload>;
}

interface PresentedEntry {
  readonly media: MediaPayload;
  readonly client: MatrixClient;
}

let nextStagedId = 0;
let nextPresentedId = 0;
const MAX_CACHED_TARGETS_PER_STAGED_FILE = 2;

/**
 * Deep attachment boundary: opaque staging, encrypted Matrix transfer, safe presentation,
 * cancellation/retry, progress, and delegation to the bounded decrypted-byte cache.
 */
@Injectable({ providedIn: 'root' })
export class MediaPipeline {
  private readonly matrix = inject(MatrixClientService);
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
    this.staged.set(reference, { file, uploads: new Map() });
    this.liveStaged.add(reference);
    return { kind: 'staged', media: reference };
  }

  hasStaged(reference: StagedMediaReference): boolean {
    return this.staged.has(reference);
  }

  releaseStaged(reference: StagedMediaReference): void {
    if (!this.liveStaged.delete(reference)) return;
    if (reference.previewUrl) URL.revokeObjectURL(reference.previewUrl);
    this.staged.delete(reference);
  }

  /** The upload limit of the account's homeserver, or null when unknown. */
  uploadLimit(accountId: string | null): Observable<number | null> {
    return defer(() => {
      const client = accountId ? this.matrix.clientFor(accountId) : null;
      return client ? this.bytes.uploadLimit(client) : of(null);
    });
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
      const client = this.matrix.clientFor(request.key.accountId);
      const room = client?.getRoom(request.key.roomId) ?? null;
      if (!client || !room) {
        return of({
          kind: 'rejected' as const,
          failure: 'conversation-unavailable' as const,
          retryable: false,
        });
      }

      return new Observable<MediaTransferEvent>((subscriber) => {
        const abortController = new AbortController();
        const targetKey = JSON.stringify([
          request.key.accountId,
          request.key.roomId,
          request.threadRootId ?? null,
        ]);
        let uploadSubscription: Subscription | null = null;
        let sendSubscription: Subscription | null = null;
        let localEventId: string | null = null;
        let activeUpload: CachedUpload | null = null;
        let terminal = false;

        const cleanup = (): void => {
          abortController.abort();
          uploadSubscription?.unsubscribe();
          sendSubscription?.unsubscribe();
          if (terminal || !localEventId) return;
          const localEcho = room.findEventById(localEventId);
          if (!localEcho) return;
          try {
            client.cancelPendingEvent(localEcho);
            if (activeUpload) {
              activeUpload.pendingEvent = null;
              activeUpload.pendingCaption = null;
              // Room retains cancelled transaction ids. Preserve the completed upload,
              // but allocate a new event identity before a later retry.
              activeUpload.txnId = client.makeTxnId();
            }
          } catch {
            // SENDING is indeterminate. Retry reuses the transaction id, so the server
            // deduplicates rather than accepting a second event.
          }
        };

        const progress = (
          phase: Extract<MediaTransferEvent, { kind: 'progress' }>['phase'],
          fraction: number,
        ): void => {
          subscriber.next({
            kind: 'progress',
            phase,
            fraction: Math.max(0, Math.min(1, fraction)),
          });
        };

        const reject = (
          failure: Extract<MediaTransferEvent, { kind: 'rejected' }>['failure'],
          retryable: boolean,
        ): void => {
          terminal = true;
          subscriber.next({ kind: 'rejected', failure, retryable });
          subscriber.complete();
        };

        const inFlight = (): void => {
          terminal = true;
          subscriber.next({
            kind: 'indeterminate',
            failure: 'send-in-flight',
            retryable: true,
          });
          subscriber.complete();
        };

        const canRetryPending = (pending: MatrixEvent): boolean =>
          pending.status === EventStatus.NOT_SENT ||
          pending.status === EventStatus.QUEUED ||
          pending.status === EventStatus.ENCRYPTING;

        /** Cancels a retained local echo; false (and in flight) when the SDK refuses. */
        const withdraw = (pending: MatrixEvent): boolean => {
          try {
            client.cancelPendingEvent(pending);
            return true;
          } catch {
            inFlight();
            return false;
          }
        };

        const send = (cached: CachedUpload): void => {
          activeUpload = cached;
          const pending = cached.pendingEvent;
          if (pending) {
            if (!canRetryPending(pending)) {
              inFlight();
              return;
            }
            if (cached.pendingCaption !== request.caption) {
              if (!withdraw(pending)) return;
              cached.pendingEvent = null;
              cached.pendingCaption = null;
              cached.txnId = client.makeTxnId();
            }
          }
          const content = this.eventContent(cached.media, request.caption);
          const attemptEventId =
            cached.pendingEvent?.getId() ?? `~${room.roomId}:${cached.txnId}`;
          localEventId = attemptEventId;
          progress('sending', 1);
          if (subscriber.closed) return;
          sendSubscription = defer(() => {
            if (cached.pendingEvent) {
              return client.resendEvent(cached.pendingEvent, room);
            }
            const attempt = request.threadRootId
              ? client.sendMessage(
                  room.roomId,
                  request.threadRootId,
                  content as never,
                  cached.txnId,
                )
              : client.sendMessage(room.roomId, content as never, cached.txnId);
            // The SDK installs its pending local echo synchronously. Retain that exact
            // event if the request rejects: a retry must resend it because the Room
            // forbids adding another pending event with the same transaction id.
            cached.pendingEvent = room.findEventById(attemptEventId) ?? null;
            if (cached.pendingEvent) cached.pendingCaption = request.caption;
            return attempt;
          }).subscribe({
            next: ({ event_id }) => {
              terminal = true;
              if (!event_id || !room.findEventById(event_id)) {
                const pending = localEventId
                  ? room.findEventById(localEventId)
                  : null;
                cached.pendingEvent = pending?.status ? pending : null;
                cached.pendingCaption = cached.pendingEvent
                  ? request.caption
                  : null;
                subscriber.next({
                  kind: 'indeterminate',
                  failure: 'local-echo-missing',
                  retryable: true,
                });
              } else {
                cached.pendingEvent = null;
                cached.pendingCaption = null;
                this.releaseStaged(request.media);
                subscriber.next({ kind: 'sent', eventId: event_id });
              }
              subscriber.complete();
            },
            error: () => {
              if (!cached.pendingEvent && localEventId) {
                cached.pendingEvent = room.findEventById(localEventId) ?? null;
              }
              if (cached.pendingEvent) cached.pendingCaption = request.caption;
              reject('send-rejected', true);
            },
          });
        };

        progress('validating', 0);
        if (subscriber.closed) return cleanup;
        const imageMetadata = request.imageMetadata ?? 'strip';
        const previous = entry.uploads.get(targetKey);
        // Bytes uploaded with their metadata must not go out once the person chose to strip
        // it: sending the event is the disclosure, since nobody has the mxc (or, encrypted,
        // the key) before it. Withdraw the failed echo and upload again, stripped.
        if (previous?.imageMetadata === 'keep' && imageMetadata === 'strip') {
          const pending = previous.pendingEvent;
          if (pending && !canRetryPending(pending)) {
            inFlight();
            return cleanup;
          }
          if (pending && !withdraw(pending)) return cleanup;
          entry.uploads.delete(targetKey);
        }
        // A stripped upload may serve a request that would keep metadata: it discloses less.
        const cached = entry.uploads.get(targetKey);
        if (cached) {
          send(cached);
        } else {
          const crypto = client.getCrypto?.();
          uploadSubscription = from(isRoomEncrypted(room, crypto))
            .pipe(
              switchMap((encrypted) => {
                // Without a crypto store the SDK sends the event, and the file key in it,
                // in the clear to a room whose state lacks the encryption event.
                if (encrypted && !crypto) {
                  reject('send-rejected', true);
                  return EMPTY;
                }
                progress(encrypted ? 'encrypting' : 'uploading', 0);
                if (subscriber.closed) return EMPTY;
                return this.bytes.uploadMedia(
                  entry.file,
                  encrypted,
                  (fraction) => progress('uploading', fraction),
                  abortController,
                  client,
                  request.media.hints,
                  imageMetadata,
                );
              }),
            )
            .subscribe({
              next: (media) => {
                const uploaded = {
                  media,
                  imageMetadata,
                  txnId: client.makeTxnId(),
                  pendingEvent: null,
                  pendingCaption: null,
                };
                entry.uploads.set(targetKey, uploaded);
                while (
                  entry.uploads.size > MAX_CACHED_TARGETS_PER_STAGED_FILE
                ) {
                  const oldest = entry.uploads.keys().next().value as
                    string | undefined;
                  if (oldest === undefined) break;
                  entry.uploads.delete(oldest);
                }
                send(uploaded);
              },
              error: () => {
                if (!abortController.signal.aborted) {
                  reject('upload-rejected', true);
                }
              },
            });
        }

        return cleanup;
      });
    });
  }

  present(
    media: MediaPayload,
    client: MatrixClient = this.matrix.instance,
  ): PresentedMediaReference {
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
    this.presented.set(reference, { media, client });
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
    if (!x || !y || x.client !== y.client) return false;
    return mediaIdentity(x.media) === mediaIdentity(y.media);
  }

  resolveMedia(
    reference: PresentedMediaReference,
    variant: 'thumbnail' | 'full',
  ): Observable<string> {
    return defer(() => {
      const source = this.liveSource(reference);
      return source
        ? this.bytes.resolveMedia(source.media, variant, source.client)
        : throwError(() => new Error('Media reference is no longer available'));
    });
  }

  downloadMedia(
    reference: PresentedMediaReference,
  ): Observable<{ blob: Blob; filename: string }> {
    return defer(() => {
      const source = this.liveSource(reference);
      return source
        ? this.bytes.downloadMedia(source.media, source.client)
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
   * Works for a reference whose Account has since gone: freeing bytes needs no live client.
   */
  drop(
    reference: PresentedMediaReference,
    variant: 'thumbnail' | 'full',
    url: string | null,
  ): void {
    const source = this.presented.get(reference);
    if (source) {
      this.bytes.drop(url, {
        media: source.media,
        variant,
        client: source.client,
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
    const source = this.presented.get(reference);
    const accountId = source?.client.getUserId();
    return source &&
      accountId &&
      this.matrix.clientFor(accountId) === source.client
      ? source
      : undefined;
  }

  private eventContent(media: UploadedMedia, caption: string): object {
    return {
      msgtype: media.msgtype,
      ...mediaCaptionFields(media.body, caption),
      info: media.info,
      ...(media.file ? { file: media.file } : { url: media.mxc }),
    };
  }
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
