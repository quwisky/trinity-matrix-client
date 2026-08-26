/**
 * How long the server should keep us marked as typing after a `sendTyping(true)`,
 * in milliseconds. Refreshed while the user keeps typing (see
 * {@link TYPING_REFRESH_MS}); the server clears it automatically once it lapses, so a
 * client that stops typing without an explicit stop still stops looking like it is.
 */
export const TYPING_TIMEOUT_MS = 8000;

/**
 * Minimum gap between `sendTyping(true)` refreshes while the user keeps typing.
 * Kept comfortably below {@link TYPING_TIMEOUT_MS} so the "typing" flag never lapses
 * mid-compose, without sending a request on every keystroke.
 */
export const TYPING_REFRESH_MS = 5000;

/**
 * Human-readable "X is typing" notice for the members currently typing (the caller
 * excludes the local user). Names up to three people; beyond that it summarises. Returns `''` when nobody is typing, so a caller can treat the empty
 * string as "hide the row".
 *
 * The sentence carries no trailing ellipsis: the indicator draws three animated dots
 * after it, and a `…` in the text as well reads as a stutter.
 */
export function formatTypingNotice(names: readonly string[]): string {
  switch (names.length) {
    case 0:
      return '';
    case 1:
      return `${names[0]} is typing`;
    case 2:
      return `${names[0]} and ${names[1]} are typing`;
    case 3:
      return `${names[0]}, ${names[1]} and ${names[2]} are typing`;
    default:
      return 'Several people are typing';
  }
}
