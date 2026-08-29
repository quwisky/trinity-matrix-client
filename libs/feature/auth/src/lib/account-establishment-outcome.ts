import type { AccountEstablishmentOutcome } from '@trinity/data-access/auth';

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
  }
}
