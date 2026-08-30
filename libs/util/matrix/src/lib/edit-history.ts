import { EventType, type MatrixEvent } from 'matrix-js-sdk';
import { UNDECRYPTABLE_BODY, renderTextBody } from './message-view';

/**
 * The versions of an edited message, for the edit-history view. Kept out of
 * {@link MessageView} on purpose: history is fetched on demand, so folding it into the
 * timeline's view model would churn every row's identity for a screen nobody has opened.
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

/** The `m.new_content` block of an edit: the replacement message, unwrapped. */
function newContentOf(edit: MatrixEvent): Record<string, unknown> | null {
  const content = edit.getContent()['m.new_content'];
  return content && typeof content === 'object'
    ? (content as Record<string, unknown>)
    : null;
}

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
): MessageRevisionView {
  // `isReply: false` — an edit carries no reply fallback to strip; the reply relation
  // lives on the original event, and its own body was already stripped when rendered.
  const { text, textHtml } = renderTextBody(content, false);
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
 * Whether an `m.replace` may be shown as a version of `original`.
 *
 * The sender check is the security-relevant one: an edit only counts when it comes from
 * the account that sent the message, or anyone in the room could put words in someone
 * else's mouth. matrix-js-sdk's `relations()` applies the same rule, but only when it
 * managed to resolve the original event itself — so this is not redundant.
 *
 * Redacted edits are dropped rather than shown as a placeholder: in an encrypted room the
 * SDK never decrypts them, so they don't come back at all, and a rule that quietly depends
 * on whether the room is encrypted is worse than one that always hides them.
 */
function isShowableEdit(edit: MatrixEvent, original: MatrixEvent): boolean {
  return (
    edit.getSender() === original.getSender() &&
    edit.getType() === EventType.RoomMessage &&
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
 * The original always leads, rather than being sorted in with the rest — a server is free
 * to stamp an edit earlier than the event it replaces, and the first entry is the one the
 * UI labels "Original".
 *
 * Returns an empty list for a redacted original: its edits survive on the server, but
 * showing them would undo the deletion the sender asked for.
 */
export function buildEditRevisions(
  original: MatrixEvent,
  edits: readonly MatrixEvent[],
  currentUserId: string | null,
): MessageRevisionView[] {
  if (original.isRedacted()) {
    return [];
  }

  // Every valid edit shares the original's sender (isShowableEdit enforces it), so one
  // check answers it for the whole list.
  const isOwn = !!currentUserId && original.getSender() === currentUserId;
  const base = original.isDecryptionFailure()
    ? undecryptable(original, isOwn)
    : revision(original, original.getOriginalContent(), isOwn);

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
      applied.push(revision(edit, content, isOwn));
    }
  }

  // Ties broken by id so the order is stable across fetches (two edits can share a ms).
  applied.sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));
  return [base, ...applied];
}
