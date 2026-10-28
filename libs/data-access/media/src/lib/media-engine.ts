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
}
