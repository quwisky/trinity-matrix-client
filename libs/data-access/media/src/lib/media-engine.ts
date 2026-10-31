import type { Observable } from 'rxjs';
import type { EncryptedFileInfo, EngineResult } from '@trinity/util/matrix';

/** Rust `MediaSource`: plain `mxc://` or an encrypted file (key, iv, hashes, v). */
export type MediaSource =
  | { readonly kind: 'plain'; readonly mxc: string }
  | { readonly kind: 'encrypted'; readonly file: EncryptedFileInfo };

/** Rust `MediaFormat::{File, Thumbnail(MediaThumbnailSettings)}`. */
export type MediaFormat =
  | { readonly kind: 'file' }
  | {
      readonly kind: 'thumbnail';
      readonly width: number;
      readonly height: number;
      readonly method: 'scale' | 'crop';
      readonly animated: boolean;
    };

/** Rust `MediaRequestParameters { source, format }` plus how the webview should see the bytes. */
export interface MediaRequest {
  readonly source: MediaSource;
  /** An encrypted source has no server thumbnail: the adapter fetches the file (as Rust does). */
  readonly format: MediaFormat;
  /** Already `displaySafeMime`d by the caller; becomes the Blob / response Content-Type. */
  readonly mimeType: string;
  /** Shrink a decrypted image to this long edge (px) before minting the URL; a hint. */
  readonly downscaleTo: number | null;
}

/** A URL the webview can load. The subscriber owns it until it calls `release([url])`. */
export interface MediaContent {
  /** js-sdk: `blob:…`; Rust: a custom-scheme URL. */
  readonly url: string;
  /** Bytes behind the URL, for MediaService's byte cap. */
  readonly size: number;
}

export interface UploadRequest {
  /** Null on encrypted uploads (do not leak). */
  readonly filename: string | null;
  /** `application/octet-stream` on encrypted uploads. */
  readonly mimeType: string;
  /** Encrypt with a fresh per-file key (Rust `Client::upload_encrypted_file`). */
  readonly encrypt: boolean;
}

/** `{ mxc }` for plain uploads, `{ file }` (url filled) for encrypted ones. */
export type UploadedContent =
  | { readonly kind: 'plain'; readonly mxc: string; readonly size: number }
  | {
      readonly kind: 'encrypted';
      readonly file: EncryptedFileInfo;
      readonly size: number;
    };

/** Progress then exactly one terminal result. Unsubscribe aborts. */
export type TransferUpdate<T> =
  | {
      readonly kind: 'progress';
      readonly phase: 'encrypting' | 'uploading' | 'sending';
      readonly fraction: number;
    }
  | { readonly kind: 'done'; readonly result: EngineResult<T> };

export interface AttachmentRequest {
  /** Same key = same upload: a retry reuses it; the pipeline changes the key to force a re-upload. */
  readonly attachmentKey: string;
  /**
   * A previous key for the same message whose retained echo is withdrawn before this one is
   * uploaded (metadata kept, now to be stripped). An echo still sending ends this send as
   * `indeterminate` / `send-in-flight` instead.
   */
  readonly supersedes?: string;
  readonly threadRootId: string | null;
  /** Already metadata-stripped (or kept) by the pipeline. Not plain data: a handle. */
  readonly file: Blob;
  /** The picked file's name; the event body falls back to `attachment` without one. */
  readonly filename: string;
  readonly mimeType: string;
  readonly msgtype: 'm.image' | 'm.video' | 'm.audio' | 'm.file';
  /** Rust `AttachmentInfo` / BaseImageInfo / BaseVideoInfo. */
  readonly info: {
    readonly w: number | null;
    readonly h: number | null;
    readonly durationMs: number | null;
  };
  /** Rust `Thumbnail { data, content_type, width, height, size }`; stripped by the pipeline. */
  readonly thumbnail: {
    readonly blob: Blob;
    readonly mimeType: string;
    readonly w: number;
    readonly h: number;
  } | null;
  readonly caption: string;
  /** The MSC2530 fields of `mediaCaptionFields(filename || 'attachment', caption)`: TypeScript renders them. */
  readonly captionFields: Readonly<Record<string, unknown>>;
  /**
   * What the pipeline did with the file's identifying metadata. `strip-failed` means stripping
   * threw and `file` is the original: an encrypted room refuses it before any progress
   * (`request-failed`), a plain room sends it as picked.
   */
  readonly metadata: 'kept' | 'stripped' | 'strip-failed';
}

export type AttachmentOutcome =
  | { readonly kind: 'sent'; readonly eventId: string }
  /** The send may have left; a retry with the same key dedupes. */
  | {
      readonly kind: 'indeterminate';
      readonly reason: 'local-echo-missing' | 'send-in-flight';
    };

/** Media bytes and uploads for one account at a time. The engine keeps no URL cache. */
export interface MediaEngine {
  /**
   * Command: a fresh URL for the request's bytes on every subscription, minted only while
   * subscribed. Fails `account-not-live`, `media-unavailable` (no source, or a failed hash
   * check) or `request-failed`.
   */
  content(
    accountId: string,
    request: MediaRequest,
  ): Observable<EngineResult<MediaContent>>;

  /** Hint: the caller no longer shows these URLs; an unknown URL is ignored. Replies null. */
  release(urls: readonly string[]): Observable<null>;

  /** Hint: ask each homeserver again whether it serves authenticated media. Replies null. */
  forgetProbes(): Observable<null>;

  /**
   * Command with progress: an encrypted upload sends neither the filename nor the type.
   * Fails `account-not-live`, `too-large` or `request-failed`. Unsubscribe aborts.
   */
  upload(
    accountId: string,
    file: Blob,
    request: UploadRequest,
  ): Observable<TransferUpdate<UploadedContent>>;

  /** Command: the homeserver's `m.upload.size`, or null when it states none or cannot be asked. */
  uploadLimit(accountId: string): Observable<EngineResult<number | null>>;

  /**
   * Command with progress: upload the attachment (encrypting iff the room is) and send one
   * media message, its local echo in the timeline before `sent`. The engine retains the upload
   * and echo under `attachmentKey` until {@link forgetAttachment}, so a retry neither uploads
   * again nor sends twice; a changed caption withdraws a retained echo and sends a new event.
   * Fails `account-not-live`, `conversation-unavailable`, `encryption-unavailable` (an encrypted
   * room without crypto, before any upload), `too-large` or `request-failed`. A failure after a
   * `sending` progress update failed the send; any other failed the upload, except
   * `encryption-unavailable`, which refuses the send itself although no `sending` precedes it.
   * Unsubscribe aborts the upload and withdraws an echo not yet sending.
   */
  sendAttachment(
    accountId: string,
    roomId: string,
    request: AttachmentRequest,
  ): Observable<TransferUpdate<AttachmentOutcome>>;

  /** Hint: forget the upload and echo retained under `attachmentKey`; withdraws nothing. Replies null. */
  forgetAttachment(attachmentKey: string): Observable<null>;
}
