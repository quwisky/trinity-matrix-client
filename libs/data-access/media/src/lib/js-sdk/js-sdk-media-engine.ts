import { Injectable, inject } from '@angular/core';
import {
  EventStatus,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type UploadOpts,
} from 'matrix-js-sdk';
import {
  EMPTY,
  Observable,
  type Subscription,
  catchError,
  defer,
  from,
  last,
  map,
  of,
  shareReplay,
  switchMap,
  throwError,
} from 'rxjs';
import {
  JS_SDK_CLIENTS,
  serverAdvertises,
  type ServerSupportQuery,
  isRoomEncrypted,
} from '@trinity/data-access/matrix-client';
import {
  type EncryptedFileInfo,
  type EngineFailure,
  type EngineResult,
  decryptAttachment,
  encryptAttachment,
  engineFail,
  engineOk,
} from '@trinity/util/matrix';
import type {
  AttachmentOutcome,
  AttachmentRequest,
  MediaContent,
  MediaEngine,
  MediaRequest,
  TransferUpdate,
  UploadRequest,
  UploadedContent,
} from '../media-engine';
import { downscaleImage } from '../media-processing';
import { type MediaResize, fetchMediaBytes } from './authed-media';
import { requestFailed, tooLargeOrFailed } from './request-failure';

/** Authenticated media arrived in spec v1.11; servers advertised MSC3916's stable flag before that. */
const AUTHENTICATED_MEDIA = {
  version: 'v1.11',
  unstableFeature: 'org.matrix.msc3916.stable',
} as const satisfies ServerSupportQuery;

function localFailure(
  code:
    | 'account-not-live'
    | 'conversation-unavailable'
    | 'encryption-unavailable'
    | 'media-unavailable'
    | 'too-large',
): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

function done(failure: EngineFailure): TransferUpdate<never> {
  return { kind: 'done', result: engineFail(failure) };
}

/** The refusal of a file still carrying the metadata its strip could not remove. */
const STRIP_FAILED: EngineFailure = {
  kind: 'unexpected',
  code: 'request-failed',
  diagnostic: { kind: 'unexpected' },
};

const ENCRYPTED_UPLOAD: UploadRequest = {
  filename: null,
  mimeType: 'application/octet-stream',
  encrypt: true,
};

/** An attachment's event content, less its caption fields. */
interface AttachmentContent {
  readonly msgtype: AttachmentRequest['msgtype'];
  readonly info: Readonly<Record<string, unknown>>;
  readonly source:
    { readonly file: EncryptedFileInfo } | { readonly url: string };
}

/** An upload kept for retries, with the local echo of its last send while one is pending. */
interface RetainedAttachment {
  readonly content: AttachmentContent;
  txnId: string;
  pendingEvent: MatrixEvent | null;
  pendingCaption: string | null;
}

/** Bytes that cannot be shown: no source, or a failed hash check. */
class MediaUnavailableError extends Error {}

/** {@link MediaEngine} over the live matrix-js-sdk clients of {@link JS_SDK_CLIENTS}. */
@Injectable({ providedIn: 'root' })
export class JsSdkMediaEngine implements MediaEngine {
  private readonly clients = inject(JS_SDK_CLIENTS);
  /** Cached authenticated-media probe per exact client/account. */
  private authedMedia = new WeakMap<MatrixClient, Observable<boolean>>();
  /** Upload limit per exact client; a failed lookup is dropped so the next caller retries. */
  private readonly uploadLimits = new WeakMap<
    MatrixClient,
    Observable<number | null>
  >();
  /** Uploads kept for retries by attachment key, until the caller forgets them. */
  // shortcut: uncapped; a transfer that reaches its upload after the pipeline released the
  // staged file is never forgotten. Cap it (oldest first) if retained uploads ever accumulate.
  private readonly attachments = new Map<string, RetainedAttachment>();

  content(
    accountId: string,
    request: MediaRequest,
  ): Observable<EngineResult<MediaContent>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(localFailure('account-not-live')));
      const { source, downscaleTo } = request;
      return this.fetchBlob(client, request).pipe(
        map((blob): EngineResult<Blob> => engineOk(blob)),
        // Only the download and its hash check fail as results; a local fault after them
        // (the downscale) errors the stream.
        catchError((error: unknown) =>
          of(
            engineFail(
              error instanceof MediaUnavailableError
                ? localFailure('media-unavailable')
                : requestFailed(error),
            ),
          ),
        ),
        switchMap((result) =>
          result.ok && source.kind === 'encrypted' && downscaleTo
            ? from(downscaleImage(result.value, downscaleTo)).pipe(
                map(engineOk),
              )
            : of(result),
        ),
        // Minted in the last step, so an unsubscribed request leaves no URL behind.
        map((result) =>
          result.ok
            ? engineOk({
                url: URL.createObjectURL(result.value),
                size: result.value.size,
              })
            : result,
        ),
      );
    });
  }

  release(urls: readonly string[]): Observable<null> {
    return defer(() => {
      for (const url of urls) URL.revokeObjectURL(url);
      return of(null);
    });
  }

  forgetProbes(): Observable<null> {
    return defer(() => {
      this.authedMedia = new WeakMap();
      return of(null);
    });
  }

  upload(
    accountId: string,
    file: Blob,
    request: UploadRequest,
  ): Observable<TransferUpdate<UploadedContent>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(done(localFailure('account-not-live')));
      // Checked before sending, as matrix-rust-sdk does: Synapse drops an oversized body.
      return this.limitOf(client).pipe(
        switchMap((limit) =>
          limit !== null && file.size > limit
            ? of(done(localFailure('too-large')))
            : this.send(client, file, request),
        ),
      );
    });
  }

  uploadLimit(accountId: string): Observable<EngineResult<number | null>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(engineFail(localFailure('account-not-live')));
      return this.limitOf(client).pipe(map((limit) => engineOk(limit)));
    });
  }

  sendAttachment(
    accountId: string,
    roomId: string,
    request: AttachmentRequest,
  ): Observable<TransferUpdate<AttachmentOutcome>> {
    return defer(() => {
      const client = this.clients.clientFor(accountId);
      if (!client) return of(done(localFailure('account-not-live')));
      const room = client.getRoom(roomId);
      if (!room) return of(done(localFailure('conversation-unavailable')));
      return this.transfer(accountId, client, room, request);
    });
  }

  forgetAttachment(attachmentKey: string): Observable<null> {
    return defer(() => {
      this.attachments.delete(attachmentKey);
      return of(null);
    });
  }

  private transfer(
    accountId: string,
    client: MatrixClient,
    room: Room,
    request: AttachmentRequest,
  ): Observable<TransferUpdate<AttachmentOutcome>> {
    return new Observable<TransferUpdate<AttachmentOutcome>>((subscriber) => {
      let uploadSubscription: Subscription | null = null;
      let sendSubscription: Subscription | null = null;
      let localEventId: string | null = null;
      let activeUpload: RetainedAttachment | null = null;
      let terminal = false;

      const cleanup = (): void => {
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
        phase: 'encrypting' | 'uploading' | 'sending',
        fraction: number,
      ): void => {
        subscriber.next({ kind: 'progress', phase, fraction });
      };

      const finish = (result: EngineResult<AttachmentOutcome>): void => {
        terminal = true;
        subscriber.next({ kind: 'done', result });
        subscriber.complete();
      };

      const inFlight = (): void =>
        finish(engineOk({ kind: 'indeterminate', reason: 'send-in-flight' }));

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

      const send = (cached: RetainedAttachment): void => {
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
        const content = eventContent(cached.content, request.captionFields);
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
            if (!event_id || !room.findEventById(event_id)) {
              const pending = localEventId
                ? room.findEventById(localEventId)
                : null;
              cached.pendingEvent = pending?.status ? pending : null;
              cached.pendingCaption = cached.pendingEvent
                ? request.caption
                : null;
              finish(
                engineOk({
                  kind: 'indeterminate',
                  reason: 'local-echo-missing',
                }),
              );
            } else {
              cached.pendingEvent = null;
              cached.pendingCaption = null;
              finish(engineOk({ kind: 'sent', eventId: event_id }));
            }
          },
          error: (error: unknown) => {
            if (!cached.pendingEvent && localEventId) {
              cached.pendingEvent = room.findEventById(localEventId) ?? null;
            }
            if (cached.pendingEvent) cached.pendingCaption = request.caption;
            finish(engineFail(requestFailed(error)));
          },
        });
      };

      // The caller changed its mind about this file's metadata: bytes uploaded with it must
      // not go out, so withdraw their failed echo before uploading the file again.
      if (request.supersedes !== undefined) {
        const pending = this.attachments.get(request.supersedes)?.pendingEvent;
        if (pending && !canRetryPending(pending)) {
          inFlight();
          return cleanup;
        }
        if (pending && !withdraw(pending)) return cleanup;
        this.attachments.delete(request.supersedes);
      }
      const cached = this.attachments.get(request.attachmentKey);
      if (cached) {
        send(cached);
        return cleanup;
      }
      const crypto = client.getCrypto?.();
      uploadSubscription = from(isRoomEncrypted(room, crypto))
        .pipe(
          switchMap((encrypted) => {
            // Without a crypto store the SDK sends the event, and the file key in it,
            // in the clear to a room whose state lacks the encryption event.
            if (encrypted && !crypto) {
              finish(engineFail(localFailure('encryption-unavailable')));
              return EMPTY;
            }
            if (encrypted && request.metadata === 'strip-failed') {
              finish(engineFail(STRIP_FAILED));
              return EMPTY;
            }
            progress(encrypted ? 'encrypting' : 'uploading', 0);
            if (subscriber.closed) return EMPTY;
            return this.uploadAttachment(accountId, request, encrypted);
          }),
        )
        .subscribe({
          next: (update) => {
            if (update.kind === 'progress') {
              progress(update.phase, update.fraction);
              return;
            }
            if (!update.result.ok) {
              finish(update.result);
              return;
            }
            const uploaded: RetainedAttachment = {
              content: update.result.value,
              txnId: client.makeTxnId(),
              pendingEvent: null,
              pendingCaption: null,
            };
            this.attachments.set(request.attachmentKey, uploaded);
            send(uploaded);
          },
          // A local fault (reading or encrypting the file) is not an expected failure.
          error: (error: unknown) => subscriber.error(error),
        });
      return cleanup;
    });
  }

  /** The thumbnail, which never gates the send, then the file, with the file's progress. */
  private uploadAttachment(
    accountId: string,
    request: AttachmentRequest,
    encrypt: boolean,
  ): Observable<TransferUpdate<AttachmentContent>> {
    const { thumbnail } = request;
    const thumbnailInfo: Observable<Record<string, unknown> | null> = thumbnail
      ? this.upload(
          accountId,
          thumbnail.blob,
          encrypt
            ? ENCRYPTED_UPLOAD
            : {
                filename: 'thumbnail',
                mimeType: thumbnail.mimeType,
                encrypt: false,
              },
        ).pipe(
          last(),
          map((update) => {
            if (update.kind !== 'done' || !update.result.ok) return null;
            const uploaded = update.result.value;
            const thumbnail_info = {
              mimetype: thumbnail.mimeType,
              w: thumbnail.w,
              h: thumbnail.h,
              size: thumbnail.blob.size,
            };
            return uploaded.kind === 'encrypted'
              ? { thumbnail_file: uploaded.file, thumbnail_info }
              : { thumbnail_url: uploaded.mxc, thumbnail_info };
          }),
          catchError(() => of(null)),
        )
      : of(null);
    return thumbnailInfo.pipe(
      switchMap((thumb) =>
        this.upload(
          accountId,
          request.file,
          encrypt
            ? ENCRYPTED_UPLOAD
            : {
                filename: request.filename,
                mimeType: request.mimeType,
                encrypt: false,
              },
        ).pipe(
          map((update): TransferUpdate<AttachmentContent> => {
            if (update.kind === 'progress') return update;
            if (!update.result.ok)
              return { kind: 'done', result: update.result };
            return {
              kind: 'done',
              result: engineOk(
                attachmentContent(request, update.result.value, thumb),
              ),
            };
          }),
        ),
      ),
    );
  }

  private send(
    client: MatrixClient,
    file: Blob,
    request: UploadRequest,
  ): Observable<TransferUpdate<UploadedContent>> {
    return new Observable((subscriber) => {
      const abortController = new AbortController();
      const progressHandler = (p: { loaded: number; total: number }) =>
        subscriber.next({
          kind: 'progress',
          phase: 'uploading',
          fraction: p.total ? p.loaded / p.total : 0,
        });
      void prepareUpload(file, request, abortController.signal)
        .then((prepared) =>
          client
            .uploadContent(prepared.body, {
              ...prepared.options,
              progressHandler,
              abortController,
            })
            .then(
              (res) => engineOk(prepared.content(res.content_uri)),
              (error: unknown) => engineFail(tooLargeOrFailed(error)),
            ),
        )
        .then(
          (result) => {
            if (abortController.signal.aborted) return;
            subscriber.next({ kind: 'done', result });
            subscriber.complete();
          },
          // A local fault (reading or encrypting the file) is not an expected failure.
          (error: unknown) => {
            if (!abortController.signal.aborted) subscriber.error(error);
          },
        );
      return () => abortController.abort();
    });
  }

  private limitOf(client: MatrixClient): Observable<number | null> {
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

  private fetchBlob(
    client: MatrixClient,
    request: MediaRequest,
  ): Observable<Blob> {
    const { source, format, mimeType } = request;
    if (source.kind === 'encrypted') {
      // Encrypted: download the full ciphertext (an encrypted original has no server-side
      // thumbnail) and decrypt it with the event's per-file AES-CTR key. decryptAttachment
      // verifies the SHA-256 hash and rejects on a mismatch, so tampered bytes never reach the DOM.
      const file = source.file;
      return this.fetchBytes(client, file.url, null).pipe(
        switchMap((ciphertext) =>
          from(decryptAttachment(ciphertext, file)).pipe(
            catchError(() => throwError(() => new MediaUnavailableError())),
          ),
        ),
        map((plaintext) => new Blob([plaintext], { type: mimeType })),
      );
    }
    if (!source.mxc) {
      return throwError(() => new MediaUnavailableError());
    }
    const resize: MediaResize =
      format.kind === 'thumbnail'
        ? { w: format.width, h: format.height, method: format.method }
        : null;
    return this.fetchBytes(client, source.mxc, resize).pipe(
      map((buffer) => new Blob([buffer], { type: mimeType })),
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
    resize: MediaResize,
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
}

function attachmentContent(
  request: AttachmentRequest,
  uploaded: UploadedContent,
  thumbnail: Record<string, unknown> | null,
): AttachmentContent {
  const { w, h, durationMs } = request.info;
  return {
    msgtype: request.msgtype,
    info: {
      mimetype: request.mimeType,
      size: uploaded.size,
      ...(w != null ? { w } : {}),
      ...(h != null ? { h } : {}),
      ...(durationMs != null ? { duration: durationMs } : {}),
      ...(thumbnail ?? {}),
    },
    source:
      uploaded.kind === 'encrypted'
        ? { file: uploaded.file }
        : { url: uploaded.mxc },
  };
}

function eventContent(
  content: AttachmentContent,
  captionFields: AttachmentRequest['captionFields'],
): object {
  return {
    msgtype: content.msgtype,
    ...captionFields,
    info: content.info,
    ...content.source,
  };
}

/** One file ready to send; an encrypted one goes up as ciphertext with no name or type to leak. */
async function prepareUpload(
  file: Blob,
  request: UploadRequest,
  signal: AbortSignal,
): Promise<{
  readonly body: Blob;
  readonly options: UploadOpts;
  content(mxc: string): UploadedContent;
}> {
  if (request.encrypt) {
    const plaintext = await file.arrayBuffer();
    signal.throwIfAborted();
    const { data, info } = await encryptAttachment(plaintext);
    signal.throwIfAborted();
    return {
      body: new Blob([data]),
      options: { includeFilename: false, type: 'application/octet-stream' },
      content: (url) => ({
        kind: 'encrypted',
        file: { ...info, url },
        size: data.byteLength,
      }),
    };
  }
  return {
    body: file,
    options: {
      ...(request.filename === null
        ? { includeFilename: false }
        : { name: request.filename }),
      type: request.mimeType,
    },
    content: (mxc) => ({ kind: 'plain', mxc, size: file.size }),
  };
}
