/** The distinct type-to-confirm word for resetting the exported settings catalogue. */
export const RESET_CONFIG_CONFIRMATION_WORD = 'DEFAULTS';

/** Cost-first disclosure shared by startup recovery and the Advanced Settings surface. */
export const RESET_CONFIG_CONSEQUENCES = [
  'Every setting in the exported catalogue goes back to its default on this device: appearance, privacy, timeline, date and time formats, keyboard shortcuts, and the GIF provider and its API key.',
  'The reset only changes settings stored on this device. Nothing on your homeserver changes, and your push registrations are kept.',
  'Your account registry, unsent drafts, and per-account space ordering are not part of this reset.',
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
