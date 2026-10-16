/**
 * How long the server keeps us marked as typing after a `sendTyping(true)`, in milliseconds.
 * Refreshed every {@link TYPING_REFRESH_MS}; the server clears it once it lapses.
 */
export const TYPING_TIMEOUT_MS = 8000;

/**
 * Minimum gap between `sendTyping(true)` refreshes; kept below {@link TYPING_TIMEOUT_MS} so
 * the flag never lapses mid-compose.
 */
export const TYPING_REFRESH_MS = 5000;

/**
 * Human-readable "X is typing" notice for the members currently typing (the caller excludes
 * the local user). Names up to three people, then summarises. Returns `''` when nobody is
 * typing. No trailing ellipsis: the indicator draws animated dots after it.
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
