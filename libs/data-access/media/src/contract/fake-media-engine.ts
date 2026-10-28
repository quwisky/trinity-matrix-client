import { Observable, defer, from, map, of } from 'rxjs';
import {
  type EngineFailure,
  type EngineResult,
  decryptAttachment,
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
} from '../lib/media-engine';

interface StoredMedia {
  readonly bytes: Uint8Array;
  readonly filename: string | null;
  readonly mimeType: string;
}

function failure(
  code: 'account-not-live' | 'media-unavailable' | 'too-large',
): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

const NOT_FOUND: EngineFailure = {
  kind: 'http',
  code: 'request-failed',
  diagnostic: { kind: 'http', httpStatus: 404 },
};

/** An in-memory {@link MediaEngine}: a media repository for alice and a URL→bytes map. */
export class FakeMediaEngine implements MediaEngine {
  private readonly media = new Map<string, StoredMedia>();
  private readonly urls = new Map<string, Uint8Array>();
  private nextMedia = 0;
  private nextUrl = 0;

  readonly alice = '@alice:example.org';
  /** `m.upload.size`; null states no limit. */
  uploadLimitBytes: number | null = 1_048_576;
  /** Uploads unsubscribed before their result. */
  aborted = 0;
  probesForgotten = 0;

  /** The bytes behind a URL from {@link content}; rejects once released. */
  async read(url: string): Promise<Uint8Array> {
    const bytes = this.urls.get(url);
    if (!bytes) throw new Error(`No bytes behind ${url}`);
    return bytes;
  }

  async stored(
    mxc: string,
  ): Promise<{ readonly filename: string | null; readonly mimeType: string }> {
    const stored = this.media.get(mxc);
    if (!stored) throw new Error(`No media at ${mxc}`);
    return { filename: stored.filename, mimeType: stored.mimeType };
  }

  /** Seeds the media repository, as if `bytes` had been uploaded in the clear to `mxc`. */
  put(
    mxc: string,
    bytes: Uint8Array,
    mimeType = 'application/octet-stream',
  ): void {
    this.media.set(mxc, { bytes, filename: null, mimeType });
  }

  /** URLs currently minted and not released. */
  liveUrls(): readonly string[] {
    return [...this.urls.keys()];
  }

  content(
    accountId: string,
    request: MediaRequest,
  ): Observable<EngineResult<MediaContent>> {
    return defer(() =>
      from(this.bytesFor(accountId, request)).pipe(
        // Mapped only while subscribed, so an unsubscribed request mints nothing.
        map((result) => {
          if (!result.ok) return result;
          const url = `blob:fake/${++this.nextUrl}`;
          this.urls.set(url, result.value);
          return engineOk({ url, size: result.value.byteLength });
        }),
      ),
    );
  }

  release(urls: readonly string[]): Observable<null> {
    return defer(() => {
      for (const url of urls) this.urls.delete(url);
      return of(null);
    });
  }

  forgetProbes(): Observable<null> {
    return defer(() => {
      this.probesForgotten++;
      return of(null);
    });
  }

  upload(
    accountId: string,
    file: Blob,
    request: UploadRequest,
  ): Observable<TransferUpdate<UploadedContent>> {
    return new Observable((subscriber) => {
      let finished = false;
      void this.store(accountId, file, request).then(async (result) => {
        if (subscriber.closed) return;
        if (result.ok) {
          subscriber.next({
            kind: 'progress',
            phase: 'uploading',
            fraction: 1,
          });
          // The result lands a task later, as a real upload's does, so a caller can still abort.
          await new Promise((resolve) => setTimeout(resolve));
          if (subscriber.closed) return;
        }
        finished = true;
        subscriber.next({ kind: 'done', result });
        subscriber.complete();
      });
      return () => {
        if (!finished) this.aborted++;
      };
    });
  }

  uploadLimit(accountId: string): Observable<EngineResult<number | null>> {
    return defer(() =>
      of(
        accountId === this.alice
          ? engineOk(this.uploadLimitBytes)
          : engineFail(failure('account-not-live')),
      ),
    );
  }

  private async bytesFor(
    accountId: string,
    request: MediaRequest,
  ): Promise<EngineResult<Uint8Array>> {
    if (accountId !== this.alice)
      return engineFail(failure('account-not-live'));
    const { source } = request;
    const mxc = source.kind === 'plain' ? source.mxc : source.file.url;
    if (!mxc) return engineFail(failure('media-unavailable'));
    const stored = this.media.get(mxc);
    if (!stored) return engineFail(NOT_FOUND);
    if (source.kind === 'plain') return engineOk(stored.bytes);
    try {
      const plaintext = await decryptAttachment(
        stored.bytes.slice().buffer,
        source.file,
      );
      return engineOk(new Uint8Array(plaintext));
    } catch {
      return engineFail(failure('media-unavailable'));
    }
  }

  private async store(
    accountId: string,
    file: Blob,
    request: UploadRequest,
  ): Promise<EngineResult<UploadedContent>> {
    if (accountId !== this.alice)
      return engineFail(failure('account-not-live'));
    if (this.uploadLimitBytes !== null && file.size > this.uploadLimitBytes) {
      return engineFail(failure('too-large'));
    }
    const plaintext = await file.arrayBuffer();
    const mxc = `mxc://example.org/media${++this.nextMedia}`;
    if (!request.encrypt) {
      this.media.set(mxc, {
        bytes: new Uint8Array(plaintext),
        filename: request.filename,
        mimeType: request.mimeType,
      });
      return engineOk({ kind: 'plain', mxc, size: file.size });
    }
    const { data, info } = await encryptAttachment(plaintext);
    this.media.set(mxc, {
      bytes: new Uint8Array(data),
      filename: null,
      mimeType: 'application/octet-stream',
    });
    return engineOk({
      kind: 'encrypted',
      file: { ...info, url: mxc },
      size: data.byteLength,
    });
  }
}
