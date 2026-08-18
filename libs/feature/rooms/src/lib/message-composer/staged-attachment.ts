/**
 * One file staged in the composer, waiting to be sent.
 *
 * `id` exists because `File` has no stable identity: two files picked from the same folder can
 * be equal in name, size and type, and a `File` is not comparable by reference across a
 * re-render. Both `@for … track` and "remove this one" need a key that survives neither.
 */
export interface StagedAttachment {
  readonly id: string;
  readonly file: File;
  /** Object URL previewing an image, else null. Revoked when the item leaves the strip. */
  readonly previewUrl: string | null;
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
  };
}

/** Release the preview URL a staged attachment owns, if it has one. */
export function releaseAttachment(attachment: StagedAttachment): void {
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl);
  }
}
