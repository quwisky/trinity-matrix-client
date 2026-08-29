import { Injectable, inject } from '@angular/core';
import { Observable, Subscription, defer, of, throwError } from 'rxjs';
import {
  EventStatus,
  type MatrixClient,
  type MatrixEvent,
} from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { mediaCaptionFields, type MediaPayload } from '@trinity/util/matrix';
import { MediaService, type UploadedMedia } from './media.service';
import type {
  MediaStageOutcome,
  MediaTransferEvent,
  MediaTransferRequest,
  PresentedMediaReference,
  StagedMediaReference,
} from './media-pipeline.models';

interface CachedUpload {
  readonly media: UploadedMedia;
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
  private presented = new WeakMap<PresentedMediaReference, PresentedEntry>();

  stage(file: File): MediaStageOutcome {
    if (!file || file.size === 0) {
      return { kind: 'rejected', failure: 'empty-file', retryable: false };
    }
    const reference = Object.freeze({
      id: `staged-media-${++nextStagedId}`,
      filename: file.name || 'attachment',
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      previewUrl: file.type.startsWith('image/')
        ? URL.createObjectURL(file)
        : null,
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

        const send = (cached: CachedUpload): void => {
          activeUpload = cached;
          const pending = cached.pendingEvent;
          if (pending) {
            const canRetryPending =
              pending.status === EventStatus.NOT_SENT ||
              pending.status === EventStatus.QUEUED ||
              pending.status === EventStatus.ENCRYPTING;
            if (!canRetryPending) {
              terminal = true;
              subscriber.next({
                kind: 'indeterminate',
                failure: 'send-in-flight',
                retryable: true,
              });
              subscriber.complete();
              return;
            }
            if (cached.pendingCaption !== request.caption) {
              try {
                client.cancelPendingEvent(pending);
              } catch {
                terminal = true;
                subscriber.next({
                  kind: 'indeterminate',
                  failure: 'send-in-flight',
                  retryable: true,
                });
                subscriber.complete();
                return;
              }
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
        const cached = entry.uploads.get(targetKey);
        if (cached) {
          send(cached);
        } else {
          const encrypted = room.hasEncryptionStateEvent();
          progress(encrypted ? 'encrypting' : 'uploading', 0);
          if (subscriber.closed) return cleanup;
          uploadSubscription = this.bytes
            .uploadMedia(
              entry.file,
              encrypted,
              (fraction) => progress('uploading', fraction),
              abortController,
              client,
            )
            .subscribe({
              next: (media) => {
                const uploaded = {
                  media,
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
      ...(media.isVoice ? { isVoice: true } : {}),
      ...(media.waveform
        ? { waveform: Object.freeze([...media.waveform]) }
        : {}),
    }) as PresentedMediaReference;
    this.presented.set(reference, { media, client });
    return reference;
  }

  resolveMedia(
    reference: PresentedMediaReference,
    variant: 'thumbnail' | 'full',
  ): Observable<string> {
    const source = this.presented.get(reference);
    return source
      ? this.bytes.resolveMedia(source.media, variant, source.client)
      : throwError(() => new Error('Media reference is no longer available'));
  }

  downloadMedia(
    reference: PresentedMediaReference,
  ): Observable<{ blob: Blob; filename: string }> {
    const source = this.presented.get(reference);
    return source
      ? this.bytes.downloadMedia(source.media, source.client)
      : throwError(() => new Error('Media reference is no longer available'));
  }

  pin(url: string | null): void {
    this.bytes.pin(url);
  }

  unpin(url: string | null): void {
    this.bytes.unpin(url);
  }

  releaseAll(): void {
    for (const staged of [...this.liveStaged]) this.releaseStaged(staged);
    this.presented = new WeakMap();
    this.bytes.releaseAll();
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
