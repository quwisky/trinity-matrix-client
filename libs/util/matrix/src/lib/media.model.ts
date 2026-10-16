/** Media view-model types shared by the timeline projection and {@link MediaService}. */

/** The renderable category of a media message. */
export type MediaKind = 'image' | 'file' | 'video' | 'audio';

/**
 * Encrypted-attachment descriptor: the `content.file` / `info.thumbnail_file` object on an
 * E2EE media event. Modelled locally because matrix-js-sdk does not export `EncryptedFile`.
 */
export interface EncryptedFileInfo {
  /** `mxc://` URL of the ciphertext. */
  url: string;
  /** AES-CTR key as a JSON Web Key. */
  key: JsonWebKey;
  /** Base64 (unpadded) initialization vector. */
  iv: string;
  /** Content hashes (notably `sha256`) verified before decryption. */
  hashes: Record<string, string>;
  /** Encryption version (`"v2"`). */
  v: string;
}

/**
 * A media attachment projected from an `m.image` / `m.file` / `m.video` / `m.audio` event,
 * carrying what {@link MediaService} needs to resolve the bytes without leaking SDK types.
 */
export interface MediaPayload {
  kind: MediaKind;
  /** `content.url` for plaintext media; `null` when the attachment is encrypted. */
  mxc: string | null;
  /** `content.file` for encrypted media; `null` when plaintext. */
  file: EncryptedFileInfo | null;
  /** Display name / caption (`content.filename ?? content.body`). */
  filename: string;
  /** `info.mimetype`, defaulted to `application/octet-stream`. */
  mimeType: string;
  /** `info.size` in bytes, if known. */
  size?: number;
  /** `info.w` (images/video). */
  width?: number;
  /** `info.h` (images/video). */
  height?: number;
  /** `info.duration` in ms (audio/video). */
  durationMs?: number;
  /** `info.thumbnail_url` (plaintext thumbnail), if present. */
  thumbnailMxc: string | null;
  /** `info.thumbnail_file` (encrypted thumbnail), if present. */
  thumbnailFile: EncryptedFileInfo | null;
  /** `info.thumbnail_info.mimetype`, if a thumbnail is present. */
  thumbnailMimeType?: string;
  /** True for an MSC3245 voice message (an `m.audio` marked as voice). */
  isVoice?: boolean;
  /** MSC1767 waveform amplitudes (`[0, 1024]`) for a voice message, else absent. */
  waveform?: number[];
}
