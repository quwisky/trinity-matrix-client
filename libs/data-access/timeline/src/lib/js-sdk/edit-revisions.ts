import type { MatrixEvent } from 'matrix-js-sdk';
import {
  UNDECRYPTABLE_BODY,
  isEditOf,
  newContentOf,
  renderTextBody,
  validReplacement,
  type MessageRevisionView,
} from '@trinity/util/matrix';

/** One version of a message: the event it came from, and its content, or null when undecryptable. */
export interface EditRevisionSource {
  readonly event: MatrixEvent;
  readonly content: Record<string, unknown> | null;
}

type MemberName = (userId: string) => string | null | undefined;

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

/** {@link editRevisionSources}, rendered for the edit-history view. */
export function buildEditRevisions(
  original: MatrixEvent,
  edits: readonly MatrixEvent[],
  currentUserId: string | null,
  /** A member's display name, for mention pills. */
  nameOf: MemberName = () => null,
): MessageRevisionView[] {
  // Every valid edit shares the original's sender (isShowableEdit), so one check covers all.
  const isOwn = !!currentUserId && original.getSender() === currentUserId;
  return editRevisionSources(original, edits).map(({ event, content }) => {
    if (!content) {
      return {
        id: event.getId() ?? '',
        timestamp: event.getTs(),
        body: UNDECRYPTABLE_BODY,
        html: null,
        kind: 'undecryptable',
        isOwn,
      };
    }
    // `isReply: false`: an edit carries no reply fallback; the reply relation lives on the
    // original event, whose body was already stripped when rendered.
    const { text, textHtml } = renderTextBody(content, false, '', nameOf);
    return {
      id: event.getId() ?? '',
      timestamp: event.getTs(),
      body: text,
      html: textHtml,
      kind: 'text',
      isOwn,
    };
  });
}
