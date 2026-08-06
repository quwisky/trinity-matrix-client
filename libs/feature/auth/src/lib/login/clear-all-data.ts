import type { TrnAlertService } from '@trinity/helm/overlay';

/**
 * The word the user has to type before everything on this device is erased.
 *
 * Deliberately NOT the `RESET` used by the encryption-reset flow. Both guard an irreversible
 * loss and both are reached by someone already in trouble, so muscle memory from one must
 * not carry a user through the other — this one erases strictly more.
 */
export const CLEAR_DATA_CONFIRMATION_WORD = 'ERASE';

/**
 * What the user is agreeing to, cost first.
 *
 * Kept here as prose rather than inline so the wording is reviewed as wording. The order is
 * deliberate — what is destroyed, what is merely disrupted, what is untouched — and the last
 * line matters as much as the first: someone doing this while panicking needs to know their
 * conversations are not being deleted.
 */
export const CLEAR_DATA_CONSEQUENCES = [
  'Encryption keys stored only on this device are deleted. Any messages no other device can decrypt become permanently unreadable.',
  'Settings, appearance, drafts and cached messages are deleted.',
  'Trinity reloads afterwards, so you need to be online to use it again.',
  'Nothing on the server is deleted. Your account, messages and rooms are still there, and you can sign in again.',
].join('\n\n');

/**
 * Said when accounts are signed in.
 *
 * Names them, because this is reachable from `/login?add` while other accounts are live and
 * the person may not have realised. It also has to be precise about the sign-out: the server
 * call is best-effort and may not happen at all, so the device can survive on the homeserver
 * — claiming it "signs you out everywhere" would be a lie on exactly the offline path this
 * button exists for.
 */
export function signedInWarning(userIds: readonly string[] | null): string {
  // Null means the account registry could not be read — which is itself one of the states
  // this button exists for. Saying nothing would be indistinguishable from "no accounts
  // signed in", so someone with live accounts could erase them having been shown the
  // gentlest version of this dialog.
  if (userIds === null) {
    return 'Any accounts signed in on this device will be signed out here.';
  }
  if (userIds.length === 0) {
    return '';
  }
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

/** The dialog body, with the signed-in warning first when there is one. */
export function clearDataMessage(userIds: readonly string[] | null): string {
  const warning = signedInWarning(userIds);
  return [
    ...(warning ? [warning] : []),
    CLEAR_DATA_CONSEQUENCES,
    `Type ${CLEAR_DATA_CONFIRMATION_WORD} to confirm.`,
  ].join('\n\n');
}

/** What the type-to-confirm gate decided. Cancelling and mistyping are both "no". */
export type ClearDataIntent = 'confirmed' | 'cancelled' | 'mistyped';

/** Said after a mistype — silence there is indistinguishable from a broken button. */
export const CLEAR_DATA_MISTYPED_MESSAGE = `Nothing was erased. Type ${CLEAR_DATA_CONFIRMATION_WORD} exactly to confirm.`;

/**
 * Shown when a database could not be deleted because something still has it open.
 *
 * Names the cause, because it is one the user can act on — and the wipe deliberately stops
 * before signing out when this happens, so they really can just close the other window and
 * press the button again.
 */
/**
 * Logged (not shown) when something could not be deleted.
 *
 * Deliberately NOT user-facing: the wipe finishes regardless, the app restarts, and what is
 * left behind is an orphaned database the next cold start sweeps. Telling someone their
 * data might still be there — when the actionable part is already done and the residue is
 * self-healing — would be alarming and unactionable in equal measure.
 */
export const CLEAR_DATA_RESIDUE_WARNING =
  'Trinity: some databases could not be deleted and will be cleaned up on next launch:';

/**
 * Ask for the confirmation word before anything is destroyed.
 *
 * The confirm button stays enabled and the word is checked after the dialog closes, matching
 * the encryption-reset gate: a live-disabled button hides *why* nothing happened, and this
 * flow needs the difference between "changed my mind" and "typed it wrong" to say something
 * useful either way.
 */
export async function confirmClearDataIntent(
  alert: TrnAlertService,
  signedInUserIds: readonly string[] | null,
): Promise<ClearDataIntent> {
  const typed = await alert.prompt({
    header: 'Erase all Trinity data',
    message: clearDataMessage(signedInUserIds),
    placeholder: CLEAR_DATA_CONFIRMATION_WORD,
    inputLabel: `Type ${CLEAR_DATA_CONFIRMATION_WORD} to confirm`,
    confirmText: 'Erase everything',
    cancelText: 'Cancel',
    destructive: true,
  });
  if (typed === null) {
    return 'cancelled';
  }
  return typed.trim().toUpperCase() === CLEAR_DATA_CONFIRMATION_WORD
    ? 'confirmed'
    : 'mistyped';
}
