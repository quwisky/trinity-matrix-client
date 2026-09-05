/** The distinct type-to-confirm word for resetting the exported settings catalogue. */
export const RESET_CONFIG_CONFIRMATION_WORD = 'DEFAULTS';

/** Cost-first disclosure shared by startup recovery and the Advanced Settings surface. */
export const RESET_CONFIG_CONSEQUENCES = [
  'Every setting in the exported catalogue goes back to its default on this device: appearance, privacy, timeline, date and time formats, keyboard shortcuts, the GIF provider and its API key, and the push gateway.',
  'Clearing the push gateway also removes this device’s push registrations from your homeserver, so notifications stop until you set a gateway up again. Nothing else on the server changes.',
  'Your Account registry, unsent drafts, push delivery ledger, and per-Account Space ordering are not part of this reset.',
  'There is no undo. Copy or export the document first if you might want these values back.',
].join('\n\n');

export type ResetConfigIntent = 'confirmed' | 'cancelled' | 'mistyped';

export const RESET_CONFIG_MISTYPED_MESSAGE = `Nothing was reset. Type ${RESET_CONFIG_CONFIRMATION_WORD} exactly to confirm.`;

/** Interpret one prompt result without exposing the dialog library to platform code. */
export function classifyResetConfigIntent(
  typed: string | null,
): ResetConfigIntent {
  if (typed === null) return 'cancelled';
  return typed.trim().toUpperCase() === RESET_CONFIG_CONFIRMATION_WORD
    ? 'confirmed'
    : 'mistyped';
}
