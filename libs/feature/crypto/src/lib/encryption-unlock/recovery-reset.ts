import type { PasswordPrompt } from '@trinity/util/matrix';
import type { TrnAlertService } from '@trinity/components/overlay';
import { TrustOperationError } from '@trinity/data-access/trust';

/** The word the user has to type before an irreversible reset will run. */
export const RESET_CONFIRMATION_WORD = 'RESET';

/**
 * What the user is agreeing to, cost first.
 *
 * Written out here rather than inline so the wording is reviewed as prose and cannot
 * drift between the surfaces that offer the reset. Each line is a consequence the user
 * cannot discover afterwards, and the order is deliberate: what is destroyed, what is
 * disrupted, what they get back.
 */
export const RESET_CONSEQUENCES = [
  'Your message backup on the server is deleted. Messages your devices cannot already read stay unreadable — forever.',
  'Your other devices lose their verified status and must be verified again. They stay signed in.',
  'You get a new recovery key. Save it.',
].join('\n\n');

/** What the type-to-confirm gate decided. Cancelling and mistyping are both "no". */
export type ResetIntent = 'confirmed' | 'cancelled' | 'mistyped';

/** Said after a mistype — silence there is indistinguishable from a broken button. */
export const RESET_MISTYPED_MESSAGE = `Nothing was reset. Type ${RESET_CONFIRMATION_WORD} exactly to confirm.`;

/**
 * Ask for the confirmation word before anything is destroyed.
 *
 * This is the only thing between a user and an irreversible, account-wide deletion, so
 * it states the cost first and demands the word: a mis-tap is not an acceptable way to
 * reach it.
 */
export async function confirmResetIntent(
  alert: TrnAlertService,
): Promise<ResetIntent> {
  const typed = await alert.prompt({
    header: 'Reset encryption',
    message: `${RESET_CONSEQUENCES}\n\nType ${RESET_CONFIRMATION_WORD} to confirm.`,
    placeholder: RESET_CONFIRMATION_WORD,
    inputLabel: `Type ${RESET_CONFIRMATION_WORD} to confirm`,
    confirmText: 'Reset',
    cancelText: 'Cancel',
    destructive: true,
  });
  if (typed === null) {
    return 'cancelled';
  }
  return typed.trim().toUpperCase() === RESET_CONFIRMATION_WORD
    ? 'confirmed'
    : 'mistyped';
}

/**
 * Password prompt for the reset's device-signing-key upload. Same copy as encryption
 * setup, which drives the identical UIA stage.
 */
export function resetPasswordPrompt(alert: TrnAlertService): PasswordPrompt {
  return () =>
    alert.prompt({
      header: 'Confirm your password',
      message: 'Your homeserver needs your password to reset encryption.',
      placeholder: 'Password',
      confirmText: 'Confirm',
      inputType: 'password',
    });
}

/** What to tell the user about a reset that did not happen. */
export interface ResetFailure {
  readonly message: string;
  /** The provider's own reset page, when it advertises one — else null. */
  readonly providerUrl: string | null;
}

/**
 * Triage a failed reset into something to show, or null when there is nothing to say.
 *
 * Trust classifies provider-owned recovery at its boundary; this presentation helper
 * consumes only that stable recovery meaning and an already-resolved provider link.
 *
 * `readManagement` is swallowed rather than awaited bare: the whole job of this branch is
 * to say something, and a rejected metadata read (a locked keychain, say) must not leave
 * the user staring at a screen that appears to have done nothing.
 */
export async function describeResetFailure(
  err: unknown,
  readProviderUrl: () => Promise<string | null>,
): Promise<ResetFailure | null> {
  if (err instanceof TrustOperationError && err.kind === 'cancelled') {
    return null; // they stopped it themselves, before anything was touched
  }
  if (
    !(err instanceof TrustOperationError) ||
    err.recovery !== 'open-provider'
  ) {
    return {
      message: err instanceof Error ? err.message : String(err),
      providerUrl: null,
    };
  }
  const url = await readProviderUrl().catch(() => null);
  if (!url) {
    return {
      message:
        'Your identity provider has to reset encryption for this account. Trinity cannot do it here.',
      providerUrl: null,
    };
  }
  return {
    message:
      'Your identity provider handles this. Finish the reset there, then come back and sign in again.',
    providerUrl: url,
  };
}
