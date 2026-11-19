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
