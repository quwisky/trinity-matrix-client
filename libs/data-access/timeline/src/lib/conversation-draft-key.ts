import type { ConversationKey } from './conversation-messages';

/**
 * The per-device draft key of a room's main composer: Account and Room, so two accounts in one
 * room keep separate drafts. The legacy thread composer uses {@link threadDraftKey}.
 */
export function conversationDraftKey(key: ConversationKey): string {
  return `conversation:${JSON.stringify([key.accountId, key.roomId])}`;
}

/**
 * The per-device draft key of a thread's composer: the thread root event id alone, as the
 * thread composer stores it. The thread view and a session handover's unsent replies both
 * build it here, so the reply lands in the draft the thread composer reads.
 */
export function threadDraftKey(rootEventId: string): string {
  return rootEventId;
}
