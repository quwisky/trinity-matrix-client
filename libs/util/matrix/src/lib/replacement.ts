import { RelationType, type MatrixEvent } from 'matrix-js-sdk';

/** The `m.new_content` block of an edit: the replacement message, unwrapped. */
export function newContentOf(
  edit: MatrixEvent,
): Record<string, unknown> | null {
  // The edit's own content: `getContent()` would follow an edit the SDK attached to the edit.
  const content: unknown = edit.getOriginalContent()['m.new_content'];
  return content !== null &&
    typeof content === 'object' &&
    !Array.isArray(content)
    ? (content as Record<string, unknown>)
    : null;
}

/**
 * Whether `edit` is an `m.replace` of `original` sent by `original`'s sender. Only the sender
 * may edit a message, or anyone in the room could put words in someone else's mouth;
 * matrix-js-sdk applies server-bundled and `/relations` edits without that check. An edit
 * of an edit never counts, as the spec says.
 */
export function isEditOf(original: MatrixEvent, edit: MatrixEvent): boolean {
  // The spec keeps `m.relates_to` outside the encryption, so it is read from the wire content.
  const relation = edit.getRelation();
  return (
    edit.getSender() === original.getSender() &&
    !original.isRelation(RelationType.Replace) &&
    relation?.rel_type === RelationType.Replace &&
    relation.event_id === original.getId()
  );
}

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
