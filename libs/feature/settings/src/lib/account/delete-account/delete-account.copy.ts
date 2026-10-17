import type { AccountDeletionRefusal } from '@trinity/platform-native';

/** The server part of a Matrix user ID, which names the homeserver in copy. */
export function serverNameOf(accountId: string): string {
  const colon = accountId.indexOf(':');
  return colon === -1 ? accountId : accountId.slice(colon + 1);
}

export const DELETE_ACCOUNT_COPY = {
  groupDescription: 'Permanently delete this account from its server.',
  rowDescription: (accountId: string) =>
    `Close ${accountId} for good. This can’t be undone.`,
  providerRowDescription: (server: string) =>
    `Your account is managed by ${server}’s sign-in provider. You delete it there.`,
  providerHint: (host: string) => `Opens ${host} in your browser.`,
  providerOpened:
    'After you delete your account there, come back to Trinity. It removes the account from this device when it notices.',
  providerMissing: (server: string) =>
    `${server} doesn’t offer a page for deleting accounts. Ask its administrator to delete it.`,
  stillExists:
    'Your account still exists. If you deleted it, wait a moment and check again.',
  confirmTitle: (accountId: string) => `Delete ${accountId}?`,
  confirmIntro: 'Deleting this account is permanent. You can’t undo it.',
  confirmListIntro: 'When you delete it:',
  othersUnaffected: 'Other accounts in Trinity are not affected.',
  eraseLabel: 'Also erase my messages',
  typeLabel: 'Type DELETE to confirm',
  passwordTitle: 'Enter your password',
  passwordBody: (accountId: string) =>
    `Enter the password for ${accountId} to delete it.`,
  passwordRejected: 'That password is incorrect. Nothing was deleted.',
  browserTitle: 'Confirm in your browser',
  browserBody: (server: string) =>
    `${server} needs you to confirm this in your browser. When you have finished, come back here.`,
  browserPending: (server: string) =>
    `${server} hasn’t received your confirmation yet. Finish it in your browser, then try again.`,
  deletingTitle: 'Deleting your account…',
  deletingBody: 'Keep Trinity open until this finishes.',
  stoppedTitle: 'Nothing was deleted',
  unconfirmedTitle: 'Deletion not confirmed',
  unconfirmed: 'Trinity couldn’t confirm whether your account was deleted.',
} as const;

/** Why the deletion stopped, in plain words. */
export function refusalMessage(
  reason: AccountDeletionRefusal,
  server: string,
  retryAfterMs?: number,
): string {
  switch (reason) {
    case 'attempts-exceeded':
      return 'Too many incorrect passwords. Nothing was deleted.';
    case 'no-usable-stage':
      return `${server} needs a confirmation step Trinity can’t complete. Delete the account from another Matrix app, or ask the server’s administrator. Nothing was deleted.`;
    case 'unsupported':
      return `${server} doesn’t let apps delete accounts. Ask its administrator.`;
    case 'forbidden':
      return `${server} doesn’t allow deleting accounts. Ask its administrator.`;
    case 'rate-limited': {
      const seconds =
        retryAfterMs === undefined ? null : Math.ceil(retryAfterMs / 1000);
      return seconds === null
        ? 'Too many requests. Try again shortly. Nothing was deleted.'
        : `Too many requests. Try again in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}. Nothing was deleted.`;
    }
    case 'unreachable':
      return `Trinity couldn’t reach ${server}. Nothing was deleted.`;
    case 'still-active':
      return 'Your account was not deleted. Try again.';
    case 'busy':
      return 'Trinity is busy signing out or switching accounts. Try again in a moment.';
    case 'cancelled':
    case 'account-unavailable':
    case 'failed':
      return 'Something went wrong. Nothing was deleted. Try again.';
  }
}

/** Whether trying again can help, rather than only asking the administrator. */
export function canRetry(reason: AccountDeletionRefusal): boolean {
  return (
    reason === 'rate-limited' ||
    reason === 'unreachable' ||
    reason === 'still-active' ||
    reason === 'busy' ||
    reason === 'account-unavailable' ||
    reason === 'failed'
  );
}
