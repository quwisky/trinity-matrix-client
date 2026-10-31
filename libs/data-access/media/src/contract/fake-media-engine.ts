import { Observable, defer, from, map, of } from 'rxjs';
import {
  type EngineFailure,
  type EngineResult,
  decryptAttachment,
  encryptAttachment,
  engineFail,
  engineOk,
  mediaCaptionFields,
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
} from '../lib/media-engine';

interface StoredMedia {
  readonly bytes: Uint8Array;
  readonly filename: string | null;
  readonly mimeType: string;
}

interface FakeRoom {
  readonly encrypted: boolean;
  readonly messages: FakeMessage[];
}

/** A sent media message, as the contract reads it back. */
export interface FakeMessage {
  readonly msgtype: string;
  readonly body: string;
  readonly hasThumbnail: boolean;
  readonly threadRootId: string | null;
}

/** An upload kept for retries, and its echo while one waits in the room. */
interface RetainedAttachment {
  readonly hasThumbnail: boolean;
  echo: {
    status: 'not-sent' | 'sending';
    caption: string;
    /** The event the server holds under this echo's transaction, when its answer was lost. */
    landed?: string;
  } | null;
}

function failure(
  code:
    | 'account-not-live'
    | 'conversation-unavailable'
    | 'encryption-unavailable'
    | 'media-unavailable'
    | 'too-large',
): EngineFailure {
  return { kind: 'unexpected', code, diagnostic: { kind: 'unexpected' } };
}

const REFUSED: EngineFailure = {
  kind: 'unexpected',
  code: 'request-failed',
  diagnostic: { kind: 'unexpected' },
};

const CONNECTION_LOST: EngineFailure = {
  kind: 'network',
  code: 'request-failed',
  diagnostic: { kind: 'network' },
};

const NOT_FOUND: EngineFailure = {
  kind: 'http',
  code: 'request-failed',
  diagnostic: { kind: 'http', httpStatus: 404 },
};

/** An in-memory {@link MediaEngine}: a media repository for alice and a URL→bytes map. */
export class FakeMediaEngine implements MediaEngine {
  private readonly media = new Map<string, StoredMedia>();
  private readonly urls = new Map<string, Uint8Array>();
  private readonly rooms = new Map<string, FakeRoom>();
  private readonly attachments = new Map<string, RetainedAttachment>();
  private nextMedia = 0;
  private nextUrl = 0;
  private nextRoom = 0;
  private nextEvent = 0;
  private uploadGate: Promise<void> | null = null;

  readonly alice = '@alice:example.org';
  /** `m.upload.size`; null states no limit. */
  uploadLimitBytes: number | null = 1_048_576;
  /** Uploads unsubscribed before their result. */
  aborted = 0;
  probesForgotten = 0;
  /** Uploads (files and thumbnails) that reached the repository. */
  uploads = 0;
  /** Whether alice has crypto; without it an encrypted room fails closed. */
  crypto = true;
  /** The next this many sends fail with `request-failed`, leaving their echo not sent. */
  sendFailures = 0;
  /** The next send lands, but its answer is lost: the caller sees a network failure. */
  dropNextSendResponse = false;
  /** Retained echoes withdrawn (a caption change, a superseding key, an unsubscribe). */
  withdrawn = 0;

  /** The next send is refused: no event is stored. */
  refuseNextSend(): void {
    this.sendFailures = 1;
  }

  /** Holds uploads before they reach the repository; the release lets those not aborted by then through. */
  holdUploads(): () => void {
    let release!: () => void;
    this.uploadGate = new Promise<void>((resolve) => (release = resolve));
    return () => {
      this.uploadGate = null;
      release();
    };
  }

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

  /** A room alice is in. */
  addRoom(encrypted = false): string {
    const roomId = `!room${++this.nextRoom}:example.org`;
    this.rooms.set(roomId, { encrypted, messages: [] });
    return roomId;
  }

  messages(roomId: string): readonly FakeMessage[] {
    return this.rooms.get(roomId)?.messages ?? [];
  }

  /** Marks the echo retained under `attachmentKey` as sending: it can no longer be withdrawn. */
  markSending(attachmentKey: string): void {
    const echo = this.attachments.get(attachmentKey)?.echo;
    if (echo) echo.status = 'sending';
  }

  /** Whether an upload is retained under `attachmentKey`. */
  retains(attachmentKey: string): boolean {
    return this.attachments.has(attachmentKey);
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

  sendAttachment(
    accountId: string,
    roomId: string,
    request: AttachmentRequest,
  ): Observable<TransferUpdate<AttachmentOutcome>> {
    return new Observable((subscriber) => {
      let terminal = false;
      let sending: RetainedAttachment | null = null;
      const finish = (result: EngineResult<AttachmentOutcome>): void => {
        terminal = true;
        subscriber.next({ kind: 'done', result });
        subscriber.complete();
      };
      const inFlight = (): void =>
        finish(engineOk({ kind: 'indeterminate', reason: 'send-in-flight' }));
      const room = this.rooms.get(roomId);

      const send = (retained: RetainedAttachment): void => {
        if (retained.echo?.status === 'sending') return inFlight();
        if (retained.echo && retained.echo.caption !== request.caption) {
          this.withdrawn++;
          retained.echo = null;
        }
        subscriber.next({ kind: 'progress', phase: 'sending', fraction: 1 });
        if (subscriber.closed) return;
        retained.echo ??= { status: 'not-sent', caption: request.caption };
        sending = retained;
        // The server answers a task later, so a caller can still unsubscribe meanwhile.
        setTimeout(() => {
          if (subscriber.closed || !room) return;
          if (this.sendFailures > 0) {
            this.sendFailures--;
            return finish(engineFail(REFUSED));
          }
          // The same transaction again: the server answers with the event it already holds.
          const landed = retained.echo?.landed;
          if (landed) {
            retained.echo = null;
            return finish(engineOk({ kind: 'sent', eventId: landed }));
          }
          const eventId = `$event${++this.nextEvent}`;
          room.messages.push({
            msgtype: request.msgtype,
            body: String(
              mediaCaptionFields(
                request.filename || 'attachment',
                request.caption,
              )['body'],
            ),
            hasThumbnail: retained.hasThumbnail,
            threadRootId: request.threadRootId,
          });
          if (this.dropNextSendResponse && retained.echo) {
            this.dropNextSendResponse = false;
            retained.echo.landed = eventId;
            return finish(engineFail(CONNECTION_LOST));
          }
          retained.echo = null;
          finish(engineOk({ kind: 'sent', eventId }));
        });
      };

      if (accountId !== this.alice) {
        finish(engineFail(failure('account-not-live')));
      } else if (!room) {
        finish(engineFail(failure('conversation-unavailable')));
      } else {
        const previous =
          request.supersedes === undefined
            ? undefined
            : this.attachments.get(request.supersedes);
        if (previous?.echo?.status === 'sending') {
          inFlight();
        } else {
          if (previous?.echo) this.withdrawn++;
          if (request.supersedes !== undefined) {
            this.attachments.delete(request.supersedes);
          }
          const retained = this.attachments.get(request.attachmentKey);
          if (retained) {
            send(retained);
          } else if (room.encrypted && !this.crypto) {
            finish(engineFail(failure('encryption-unavailable')));
          } else if (room.encrypted && request.metadata === 'strip-failed') {
            finish(engineFail(REFUSED));
          } else {
            void this.uploadAttachment(
              subscriber,
              request,
              room.encrypted,
              (r) => send(r),
            );
          }
        }
      }
      return () => {
        if (terminal || sending?.echo?.status !== 'not-sent') return;
        this.withdrawn++;
        sending.echo = null;
      };
    });
  }

  forgetAttachment(attachmentKey: string): Observable<null> {
    return defer(() => {
      this.attachments.delete(attachmentKey);
      return of(null);
    });
  }

  private async uploadAttachment(
    subscriber: {
      readonly closed: boolean;
      next(update: TransferUpdate<AttachmentOutcome>): void;
      complete(): void;
    },
    request: AttachmentRequest,
    encrypt: boolean,
    send: (retained: RetainedAttachment) => void,
  ): Promise<void> {
    subscriber.next({
      kind: 'progress',
      phase: encrypt ? 'encrypting' : 'uploading',
      fraction: 0,
    });
    if (subscriber.closed) return;
    const thumbnail = request.thumbnail
      ? await this.store(
          this.alice,
          request.thumbnail.blob,
          {
            filename: null,
            mimeType: request.thumbnail.mimeType,
            encrypt,
          },
          () => subscriber.closed,
        )
      : null;
    const uploaded = await this.store(
      this.alice,
      request.file,
      {
        filename: encrypt ? null : request.filename,
        mimeType: request.mimeType,
        encrypt,
      },
      () => subscriber.closed,
    );
    if (subscriber.closed) return;
    if (!uploaded.ok) {
      subscriber.next({ kind: 'done', result: uploaded });
      subscriber.complete();
      return;
    }
    subscriber.next({ kind: 'progress', phase: 'uploading', fraction: 1 });
    if (subscriber.closed) return;
    const retained: RetainedAttachment = {
      hasThumbnail: thumbnail?.ok ?? false,
      echo: null,
    };
    this.attachments.set(request.attachmentKey, retained);
    send(retained);
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
    aborted: () => boolean = () => false,
  ): Promise<EngineResult<UploadedContent>> {
    if (accountId !== this.alice)
      return engineFail(failure('account-not-live'));
    if (this.uploadLimitBytes !== null && file.size > this.uploadLimitBytes) {
      return engineFail(failure('too-large'));
    }
    const plaintext = await file.arrayBuffer();
    if (this.uploadGate) await this.uploadGate;
    // An aborted upload never reaches the repository.
    if (aborted()) return engineFail(REFUSED);
    this.uploads++;
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
