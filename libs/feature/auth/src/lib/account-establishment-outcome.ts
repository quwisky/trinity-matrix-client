import type { SignInOutcome } from '@trinity/data-access/auth';

const SECURE_STORAGE_UNAVAILABLE =
  'Your system keychain is locked or unavailable. Unlock it and try again.';

/** Convert an expected Account Runtime outcome into safe sign-in copy. */
export function accountEstablishmentError(
  outcome: SignInOutcome,
): string | null {
  if (outcome.kind === 'ready' || outcome.kind === 'new-device-required') {
    return null;
  }
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
    case 'unprotected-storage-declined':
      return 'Sign-in cancelled. Nothing was stored on this device.';
    case 'crypto-store-key-lost':
      return 'This device can no longer unlock this account’s stored keys. Sign in again to set it up as a new session.';
  }
}

/** Where a sign-in without an error goes; the new-device page waits for the person. */
export function signInDestination(outcome: SignInOutcome): string {
  return outcome.kind === 'new-device-required'
    ? `/login?reauth=${encodeURIComponent(outcome.accountId)}&device=new`
    : '/rooms';
}
