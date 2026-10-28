import type { MatrixEvent } from 'matrix-js-sdk';
import { isEditOf, newContentOf, validReplacement } from '@trinity/util/matrix';

/** One version of a message: the event it came from, and its content, or null when undecryptable. */
export interface EditRevisionSource {
  readonly event: MatrixEvent;
  readonly content: Record<string, unknown> | null;
}

/**
 * Whether an `m.replace` may be shown as a version of `original`: a valid replacement
 * ({@link validReplacement}), or one from the same sender that cannot be decrypted, which is
 * listed with a notice and never its content.
 *
 * Redacted edits are dropped, not shown as a placeholder: in an encrypted room the SDK never
 * decrypts them, and the rule should not depend on whether the room is encrypted.
 */
function isShowableEdit(edit: MatrixEvent, original: MatrixEvent): boolean {
  return (
    (edit.isDecryptionFailure()
      ? isEditOf(original, edit)
      : validReplacement(original, edit) !== undefined) &&
    !edit.isRedacted() &&
    // Local echo: an edit that hasn't been accepted yet (or failed) isn't history.
    edit.status === null &&
    !edit.getId()?.startsWith('~')
  );
}

/**
 * The versions of an edited message to show, oldest first: the original, then each valid
 * edit in `origin_server_ts` order.
 *
 * The original always leads rather than being sorted in: a server may stamp an edit earlier
 * than the event it replaces, and the first entry is labelled "Original". Returns an empty
 * list for a redacted original, since showing its surviving edits would undo the deletion.
 */
export function editRevisionSources(
  original: MatrixEvent,
  edits: readonly MatrixEvent[],
): EditRevisionSource[] {
  if (original.isRedacted()) {
    return [];
  }
  const base: EditRevisionSource = {
    event: original,
    content: original.isDecryptionFailure()
      ? null
      : original.getOriginalContent(),
  };

  const seen = new Set<string>([original.getId() ?? '']);
  const applied: EditRevisionSource[] = [];
  for (const edit of edits) {
    const id = edit.getId();
    if (!id || seen.has(id) || !isShowableEdit(edit, original)) {
      continue; // paging can hand us the same edit twice
    }
    seen.add(id);
    if (edit.isDecryptionFailure()) {
      applied.push({ event: edit, content: null });
      continue;
    }
    const content = newContentOf(edit);
    if (content) {
      applied.push({ event: edit, content });
    }
  }

  // Ties broken by id so the order is stable across fetches (two edits can share a ms).
  applied.sort(
    (a, b) =>
      a.event.getTs() - b.event.getTs() ||
      (a.event.getId() ?? '').localeCompare(b.event.getId() ?? ''),
  );
  return [base, ...applied];
}
