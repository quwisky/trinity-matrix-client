/** Media view-model types shared by the timeline projection and {@link MediaService}. */

/** The renderable category of a media message. */
export type MediaKind = 'image' | 'file' | 'video' | 'audio';

/**
 * Encrypted-attachment descriptor — the `content.file` / `info.thumbnail_file`
 * object on an E2EE media event (AES-CTR key as JWK + iv + sha256 hashes).
 *
 * `matrix-js-sdk` defines this shape (`EncryptedFile`) as a *type* but does not
 * re-export it from the package root, so we model the fields we use locally.
 */
export interface EncryptedFileInfo {
  /** `mxc://` URL of the ciphertext. */
  url: string;
  /** AES-CTR key as a JSON Web Key. */
  key: JsonWebKey;
  /** Base64 (unpadded) initialization vector. */
  iv: string;
  /** Content hashes (notably `sha256`) verified after decryption. */
  hashes: Record<string, string>;
  /** Encryption version (`"v2"`). */
  v: string;
}

/**
 * A media attachment projected from an `m.image` / `m.file` / `m.video` / `m.audio`
 * event — a plain view model that carries everything {@link MediaService} needs to
 * resolve the bytes (plaintext `mxc` or encrypted `file`) without leaking SDK types.
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
  /**
   * MSC2448 `xyz.amorgan.blurhash` — a ~30-character DCT encoding of the image, used to
   * paint a photo-shaped placeholder before the bytes arrive. Absent when the sender did
   * not provide one, or provided one longer than we are willing to carry.
   */
  blurhash?: string;
}
