const relativeTime = new Intl.RelativeTimeFormat('en', { style: 'short' });

/**
 * How long ago `timestamp` was, relative to `now`: "just now", then minutes, hours and
 * days ("2 min. ago", "1 hr. ago", "3 days ago"). A future timestamp reads "just now".
 * Shared by thread summaries and the space rail's "+N" list.
 */
export function relativeTimeLabel(timestamp: number, now: number): string {
  const minutes = Math.floor(Math.max(0, now - timestamp) / 60_000);
  if (minutes === 0) return 'just now';
  if (minutes < 60) return relativeTime.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relativeTime.format(-hours, 'hour');
  return relativeTime.format(-Math.floor(hours / 24), 'day');
}
