import type { MatrixEvent } from 'matrix-js-sdk';
import { isEditOf, newContentOf } from './edit-relation';

/** The content `edit` would give `original`, or null when it may not replace it. */
function replacementContent(
  original: MatrixEvent,
  edit: MatrixEvent,
): Record<string, unknown> | null {
  return isEditOf(original, edit) &&
    edit.getType() === original.getType() &&
    // The spec asks that an encrypted message's replacement be encrypted too.
    !(original.isEncrypted() && !edit.isEncrypted()) &&
    // Not decrypted yet: its content is still the ciphertext envelope, never the edit.
    !(edit.isEncrypted() && edit.getClearContent() === null)
    ? newContentOf(edit)
    : null;
}

/**
 * The edit that may replace `original`'s content: `candidate` (by default the one the SDK
 * attached) when {@link isEditOf} holds, it has the same type, it is encrypted if `original`
 * is, it is decrypted, and its own content carries an object `m.new_content`; otherwise
 * undefined.
 */
export function validReplacement(
  original: MatrixEvent,
  candidate: MatrixEvent | null = original.replacingEvent(),
): MatrixEvent | undefined {
  return candidate && replacementContent(original, candidate)
    ? candidate
    : undefined;
}

/**
 * The content to show for `event`: its valid edit's `m.new_content`, else its own content.
 * Use instead of `getContent()`, which trusts whatever edit the SDK attached.
 */
export function displayContent(event: MatrixEvent): Record<string, unknown> {
  const edit = event.isRedacted() ? null : event.replacingEvent();
  return (
    (edit && replacementContent(event, edit)) ?? event.getOriginalContent()
  );
}
