/** Account-removal consequences shared by every presentation that can dispatch it. */
export const ACCOUNT_REMOVAL_CONSEQUENCES =
  'Remove this Account from Trinity on this device? Trinity will try to remove its push registration and sign out from its homeserver and identity provider, then delete its credentials, drafts, cached messages and local encryption keys. Other devices, the server Account, rooms and messages are not deleted.';

/** Deliberately distinct from the narrower encryption-reset confirmation word. */
export const CLEAR_DATA_CONFIRMATION_WORD = 'RESET TRINITY';

/** Complete installation-reset consequences, ordered from permanent loss to what survives. */
export const CLEAR_DATA_CONSEQUENCES = [
  'Every Trinity account on this device is removed with its credentials, drafts, cached messages and local encryption keys. Messages whose keys exist nowhere else become permanently unreadable.',
  'Trinity removes push registrations and tries to sign out from each homeserver and identity provider. A device may remain listed remotely when that network cleanup cannot finish.',
  'Settings, web storage, local databases, service workers and offline PWA caches are deleted. Trinity reloads afterwards, so you need to be online to use it again.',
  'Nothing on the server is deleted. Your account, messages and rooms are still there, and you can sign in again.',
].join('\n\n');

/** What the type-to-confirm gate decided. */
export type ClearDataIntent = 'confirmed' | 'cancelled' | 'mistyped';

export const CLEAR_DATA_MISTYPED_MESSAGE = `Nothing was erased. Type ${CLEAR_DATA_CONFIRMATION_WORD} exactly to confirm.`;

/** Describe signed-in Accounts without claiming remote sessions will be removed. */
export function signedInWarning(userIds: readonly string[] | null): string {
  if (userIds === null) {
    return 'Any accounts signed in on this device will be signed out here.';
  }
  if (userIds.length === 0) return '';
  const subject =
    userIds.length === 1
      ? 'This account is signed in on this device'
      : `${userIds.length} accounts are signed in on this device`;
  return (
    `${subject}: ${userIds.join(', ')}. ` +
    'They are signed out here, but the devices may still be listed on your homeserver — ' +
    'remove them from another device or your account settings.'
  );
}

/** Build the complete installation-reset confirmation body. */
export function clearDataMessage(userIds: readonly string[] | null): string {
  const warning = signedInWarning(userIds);
  return [
    ...(warning ? [warning] : []),
    CLEAR_DATA_CONSEQUENCES,
    `Type ${CLEAR_DATA_CONFIRMATION_WORD} to confirm.`,
  ].join('\n\n');
}

export function classifyClearDataIntent(typed: string | null): ClearDataIntent {
  if (typed === null) return 'cancelled';
  return typed.trim().toUpperCase() === CLEAR_DATA_CONFIRMATION_WORD
    ? 'confirmed'
    : 'mistyped';
}
