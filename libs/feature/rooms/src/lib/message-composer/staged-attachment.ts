/**
 * One file staged in the composer, waiting to be sent.
 *
 * `id` exists so the strip can say WHICH one to remove. `track` alone would be satisfied by the
 * `File` reference — the list holds the same instances across renders — but the removal output
 * has to carry something, and an opaque string is a better payload for a presentational
 * component than the `File` itself. Two files picked from the same folder can also match on
 * name, size and type, so neither is a key.
 */
export interface StagedAttachment {
  readonly id: string;
  readonly file: File;
  /** Object URL previewing an image, else null. Revoked when the item leaves the strip. */
  readonly previewUrl: string | null;
  /**
   * Whether this file's last send attempt failed.
   *
   * A batch reports per item rather than throwing, so one bad file leaves four delivered and
   * itself still staged. Without this the survivor is indistinguishable from a file that was
   * never sent, and the strip would quietly present a failure as a pending item.
   */
  readonly failed: boolean;
}

/**
 * Monotonic, not `crypto.randomUUID()`: the id never leaves the composer, so it needs to be
 * unique within one session rather than globally, and a counter keeps specs readable.
 */
let nextId = 0;

/** Stage a file, creating a preview URL for images only. */
export function stageAttachment(file: File): StagedAttachment {
  return {
    id: `attachment-${++nextId}`,
    file,
    previewUrl: file.type.startsWith('image/')
      ? URL.createObjectURL(file)
      : null,
    failed: false,
  };
}

/** Release the preview URL a staged attachment owns, if it has one. */
export function releaseAttachment(attachment: StagedAttachment): void {
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}
