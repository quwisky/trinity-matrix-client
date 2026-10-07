import { initialOf } from '@trinity/util/matrix';

/**
 * First visible character of an account's display name for its avatar fallback.
 * An account with no visible name falls back to its Matrix ID, as the account
 * badges do, so every surface draws the same letter for one account.
 */
export function accountInitial(account: {
  readonly userId: string;
  readonly displayName: string;
}): string {
  const hasVisibleName = account.displayName.replace(/^[#@!]+/, '').trim();
  return initialOf(hasVisibleName ? account.displayName : account.userId);
}
