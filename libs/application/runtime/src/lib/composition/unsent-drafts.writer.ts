import { Injectable, inject } from '@angular/core';
import type { PendingTextMessage } from '@trinity/data-access/matrix-client';
import {
  conversationDraftKey,
  threadDraftKey,
} from '@trinity/data-access/timeline';
import { DraftStoreService, holdsText } from '@trinity/platform-native';

/**
 * The draft an unsent text goes back into. A thread reply goes into its thread's draft, under
 * the {@link threadDraftKey} the thread view gives its composer. Anything else, a plain reply
 * included, goes into the room's draft.
 */
export function unsentDraftKey(message: PendingTextMessage): string {
  return message.threadRootId !== null
    ? threadDraftKey(message.threadRootId)
    : conversationDraftKey({
        accountId: message.accountId,
        roomId: message.roomId,
      });
}

/**
 * Text a handover could not get onto the homeserver goes back into its composer draft, so the
 * tab that takes over shows it ready to send again. The store holds plain strings, so the plain
 * body is kept; it is the composer's own markdown source.
 */
@Injectable({ providedIn: 'root' })
export class UnsentDraftsWriter {
  private readonly drafts = inject(DraftStoreService);

  /**
   * Put each text after the draft it lands in, then write the drafts to storage. Never rejects.
   * Writes even with nothing to add: a draft typed just before the handover may still be
   * waiting for the store's debounce. Does nothing while the store has not loaded the stored
   * drafts yet (a handover during startup): it would join the text to drafts it cannot see.
   */
  writeBack(messages: readonly PendingTextMessage[]): Promise<void> {
    if (!this.drafts.isInitialised()) return Promise.resolve();
    for (const message of messages) {
      const key = unsentDraftKey(message);
      // This copy replaces the waiting record, which holds the typed text and could differ.
      if (message.txnId) this.drafts.releaseWaiting(key, message.txnId);
      const existing = this.drafts.get(key).trimEnd();
      const text = message.text.trim();
      // A rejected send may already have put its text back (ConversationCompose.restore).
      if (holdsText(existing, text)) continue;
      this.drafts.set(key, existing ? `${existing}\n\n${text}` : text);
    }
    return this.drafts.flush();
  }
}
