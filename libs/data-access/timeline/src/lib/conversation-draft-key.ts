import type { ConversationKey } from './conversation-messages';

/**
 * The per-device draft key of a room's main composer: Account and Room, so two accounts in one
 * room keep separate drafts. (The legacy thread composer keys its draft by the thread root
 * event id alone.)
 */
export function conversationDraftKey(key: ConversationKey): string {
  return `conversation:${JSON.stringify([key.accountId, key.roomId])}`;
}
