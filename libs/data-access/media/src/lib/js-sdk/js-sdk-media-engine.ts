import { Injectable, inject } from '@angular/core';
import type { MatrixClient, UploadOpts } from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  defer,
  from,
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
} from '@trinity/data-access/matrix-client';
import {
  type EngineFailure,
  type EngineResult,
  decryptAttachment,
  describeMatrixRequestFailure,
  encryptAttachment,
  engineFail,
  engineOk,
} from '@trinity/util/matrix';
import type {
  MediaContent,
  MediaEngine,
  MediaRequest,
  TransferUpdate,
  UploadRequest,
  UploadedContent,
} from '../media-engine';
import { downscaleImage } from '../media-processing';
import { type MediaResize, fetchMediaBytes } from './authed-media';

/** Authenticated media arrived in spec v1.11; servers advertised MSC3916's stable flag before that. */
const AUTHENTICATED_MEDIA = {
  version: 'v1.11',
  unstableFeature: 'org.matrix.msc3916.stable',
} as const satisfies ServerSupportQuery;

function localFailure(
  code: 'account-not-live' | 'media-unavailable' | 'too-large',
): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

function done(failure: EngineFailure): TransferUpdate<never> {
  return { kind: 'done', result: engineFail(failure) };
}

function requestFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return {
    kind,
    code: 'request-failed',
    diagnostic,
    ...(diagnostic.errorName === 'TokenRefreshError'
      ? { params: { cause: 'session-refresh' as const } }
      : {}),
  };
}

function uploadFailed(error: unknown): EngineFailure {
  const { kind, diagnostic } = describeMatrixRequestFailure(error);
  return diagnostic.errcode === 'M_TOO_LARGE' || diagnostic.httpStatus === 413
    ? { kind, code: 'too-large', diagnostic }
    : requestFailed(error);
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
              (error: unknown) => engineFail(uploadFailed(error)),
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
