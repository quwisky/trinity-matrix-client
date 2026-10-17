/** The word typed to confirm an account deletion; matched like the other reset gates. */
export const ACCOUNT_DELETION_CONFIRMATION_WORD = 'DELETE';

export const ACCOUNT_DELETION_MISTYPED_MESSAGE = `Nothing was deleted. Type ${ACCOUNT_DELETION_CONFIRMATION_WORD} exactly to confirm.`;

/** What the type-to-confirm gate decided. */
export type AccountDeletionIntent = 'confirmed' | 'mistyped';

export function classifyAccountDeletionIntent(
  typed: string,
): AccountDeletionIntent {
  return typed.trim().toUpperCase() === ACCOUNT_DELETION_CONFIRMATION_WORD
    ? 'confirmed'
    : 'mistyped';
}

/** What deleting an account on its homeserver means, ordered from the account outward. */
export function accountDeletionConsequences(
  accountId: string,
): readonly string[] {
  return [
    'You can’t sign in to it again, on any device. All of its sessions are signed out.',
    `The user ID ${accountId} can’t be registered again, by you or anyone else.`,
    'You leave every room and space, and invitations you haven’t answered are declined.',
    'Your encryption keys are deleted, so you lose access to your encrypted messages. Other people keep their own copies.',
    'Messages you sent stay visible to people who could already see them.',
  ];
}

/** What the erase option asks of the server, with the protocol's limits stated. */
export function accountEraseDescription(serverName: string): string {
  return `Asks ${serverName} to hide your messages from people who join rooms later, and to delete your account data and email addresses. People who already saw your messages keep them, and other servers may keep their copies.`;
}
