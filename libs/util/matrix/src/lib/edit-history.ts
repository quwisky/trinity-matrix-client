import type { MatrixEvent } from 'matrix-js-sdk';
import { UNDECRYPTABLE_BODY, renderTextBody } from './message-view';
import { isEditOf, newContentOf, validReplacement } from './replacement';

/**
 * The versions of an edited message, for the edit-history view. Kept out of
 * {@link MessageView} because history is fetched on demand and would churn every row's
 * identity.
 */

/** One version of a message — the original, or one `m.replace` applied to it. */
export interface MessageRevisionView {
  /** The event this version came from (the original event for the first entry). */
  id: string;
  /** When this version was sent (`origin_server_ts`). */
  timestamp: number;
  /** Plain-text body; also what a reader gets when `html` is null. */
  body: string;
  /** Sanitized HTML for the body, or null to render `body` as plain text. */
  html: string | null;
  /** `undecryptable` when we hold no key for this version — `body` is the standing notice. */
  kind: 'text' | 'undecryptable';
  /** Whether the current user sent this version — only they may remove it. */
  isOwn: boolean;
}

type MemberName = (userId: string) => string | null | undefined;

function undecryptable(
  event: MatrixEvent,
  isOwn: boolean,
): MessageRevisionView {
  return {
    id: event.getId() ?? '',
    timestamp: event.getTs(),
    body: UNDECRYPTABLE_BODY,
    html: null,
    kind: 'undecryptable',
    isOwn,
  };
}

function revision(
  event: MatrixEvent,
  content: Record<string, unknown>,
  isOwn: boolean,
  nameOf: MemberName,
): MessageRevisionView {
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
 * Project an edited message and its `m.replace` events into the versions to show, oldest
 * first: the original, then each valid edit in `origin_server_ts` order.
 *
 * The original always leads rather than being sorted in: a server may stamp an edit earlier
 * than the event it replaces, and the first entry is labelled "Original". Returns an empty
 * list for a redacted original, since showing its surviving edits would undo the deletion.
 */
export function buildEditRevisions(
  original: MatrixEvent,
  edits: readonly MatrixEvent[],
  currentUserId: string | null,
  /** A member's display name, for mention pills. */
  nameOf: MemberName = () => null,
): MessageRevisionView[] {
  if (original.isRedacted()) {
    return [];
  }

  // Every valid edit shares the original's sender (isShowableEdit), so one check covers all.
  const isOwn = !!currentUserId && original.getSender() === currentUserId;
  const base = original.isDecryptionFailure()
    ? undecryptable(original, isOwn)
    : revision(original, original.getOriginalContent(), isOwn, nameOf);

  const seen = new Set<string>([base.id]);
  const applied: MessageRevisionView[] = [];
  for (const edit of edits) {
    const id = edit.getId();
    if (!id || seen.has(id) || !isShowableEdit(edit, original)) {
      continue; // paging can hand us the same edit twice
    }
    seen.add(id);
    if (edit.isDecryptionFailure()) {
      applied.push(undecryptable(edit, isOwn));
      continue;
    }
    const content = newContentOf(edit);
    if (content) {
      applied.push(revision(edit, content, isOwn, nameOf));
    }
  }

  // Ties broken by id so the order is stable across fetches (two edits can share a ms).
  applied.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  return [base, ...applied];
}
