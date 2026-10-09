import type { AccountEstablishmentOutcome } from '@trinity/data-access/auth';

const SECURE_STORAGE_UNAVAILABLE =
  'Your system keychain is locked or unavailable. Unlock it and try again.';

/** Convert an expected Account Runtime outcome into safe sign-in copy. */
export function accountEstablishmentError(
  outcome: AccountEstablishmentOutcome,
): string | null {
  if (outcome.kind === 'ready') return null;
  if (outcome.kind === 'transition-in-progress') {
    return 'Another account change is already in progress. Please try again.';
  }

  switch (outcome.failure) {
    case 'account-already-stored':
      return 'This account is already saved on this device.';
    case 'homeserver-mismatch':
      return (
        `${outcome.accountId} is already signed in through ${outcome.storedBaseUrl}. ` +
        'Remove that account from this device first to sign in to it through a different server.'
      );
    case 'active-account-required':
      return 'Open an active account before adding this one.';
    case 'local-state-unavailable':
      return 'Trinity could not update local account storage. Please try again.';
    case 'reauthentication-required':
      return 'This account needs you to sign in again.';
    case 'transient-network':
      return 'The account could not connect. Check your connection and try again.';
    case 'crypto-failure':
      return 'Encrypted account storage could not be opened. Please try again.';
    case 'secure-storage-unavailable':
      return SECURE_STORAGE_UNAVAILABLE;
    case 'crypto-store-key-lost':
      return 'This device can no longer unlock this account’s stored keys. Sign in again to set it up as a new session.';
  }
}
