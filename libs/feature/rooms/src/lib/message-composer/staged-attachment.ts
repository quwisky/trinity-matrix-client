/**
 * One file staged in the composer, waiting to be sent.
 *
 * `id` lets the strip say WHICH one to remove: the removal output needs an opaque payload
 * rather than the `File`, and two files picked from the same folder can match on name, size and
 * type, so none of those is a key.
 */
export interface StagedAttachment {
  readonly id: string;
  readonly media: StagedMediaReference;
  /** Temporary thread compatibility; to be removed when threads move onto Conversation Runtime. */
  readonly file: File;
  /** Object URL previewing an image, else null. Revoked when the item leaves the strip. */
  readonly previewUrl: string | null;
  /**
   * Whether this file's last send attempt failed.
   *
   * A batch reports per item rather than throwing, so one bad file stays staged while the rest
   * are delivered; without this the strip would present a failure as a pending item.
   */
  readonly failed: boolean;
}

/**
 * Monotonic, not `crypto.randomUUID()`: the id never leaves the composer, so session-unique
 * is enough.
 */
let nextId = 0;

/** Stage a file, creating a preview URL for images only. */
export function stageAttachment(
  file: File,
  pipeline: MediaPipeline,
  hints?: MediaHints,
): StagedAttachment | null {
  const outcome = pipeline.stage(file, hints);
  if (outcome.kind === 'rejected') return null;
  return {
    id: `attachment-${++nextId}`,
    media: outcome.media,
    file,
    previewUrl: outcome.media.previewUrl,
    failed: false,
  };
}

/** Release the preview URL a staged attachment owns, if it has one. */
export function releaseAttachment(
  attachment: StagedAttachment,
  pipeline: MediaPipeline,
): void {
  pipeline.releaseStaged(attachment.media);
}
import {
  MediaPipeline,
  type MediaHints,
  type StagedMediaReference,
} from '@trinity/data-access/media';
