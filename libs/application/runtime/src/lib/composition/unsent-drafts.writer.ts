import { Injectable, inject } from '@angular/core';
import type { PendingTextMessage } from '@trinity/data-access/matrix-client';
import { conversationDraftKey } from '@trinity/data-access/timeline';
import { DraftStoreService } from '@trinity/platform-native';

/**
 * The draft an unsent text goes back into. A thread reply goes into its thread's draft, which
 * the thread composer keys by the root event id alone (`thread-view.component.html`). Anything
 * else, a plain reply included, goes into the room's draft.
 */
export function unsentDraftKey(message: PendingTextMessage): string {
  return (
    message.threadRootId ??
    conversationDraftKey({
      accountId: message.accountId,
      roomId: message.roomId,
    })
  );
}

/**
 * Owner decision 5 of #1267: text a handover could not get onto the homeserver goes back into
 * its composer draft, so the tab that takes over shows it ready to send again. The store holds
 * plain strings, so the plain body is kept; it is the composer's own markdown source.
 */
@Injectable({ providedIn: 'root' })
export class UnsentDraftsWriter {
  private readonly drafts = inject(DraftStoreService);

  /** Put each text after the draft it lands in, then write the drafts to storage. Never rejects. */
  writeBack(messages: readonly PendingTextMessage[]): Promise<void> {
    if (messages.length === 0) return Promise.resolve();
    for (const message of messages) {
      const key = unsentDraftKey(message);
      const existing = this.drafts.get(key).trimEnd();
      const text = message.text.trim();
      // A rejected send may already have put its text back (ConversationCompose.restore).
      if (holdsText(existing, text)) continue;
      this.drafts.set(key, existing ? `${existing}\n\n${text}` : text);
    }
    return this.drafts.flush();
  }
}

/**
 * Whether `draft` already is `text`, or holds it as one of its blank-line-separated paragraphs.
 * Not a substring test: an unsent "ok" must still come back after a draft that says "looks ok".
 */
function holdsText(draft: string, text: string): boolean {
  return (
    draft.trim() === text ||
    draft.split(/\n\s*\n/).some((paragraph) => paragraph.trim() === text)
  );
}
