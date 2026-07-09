/**
 * A user's coarse online status, narrowed from matrix-js-sdk's `User.presence`
 * string to the three states the UI renders. `unavailable` is Matrix's "idle/away".
 */
export type PresenceState = 'online' | 'unavailable' | 'offline';

/**
 * Narrow a raw `User.presence` value to a {@link PresenceState}. Anything unknown or
 * absent (a user we've never received presence for) is treated as `offline`.
 */
export function toPresenceState(
  presence: string | null | undefined,
): PresenceState {
  return presence === 'online' || presence === 'unavailable'
    ? presence
    : 'offline';
}

/** Human-readable label for a presence state (tooltips / screen readers). */
export function presenceLabel(state: PresenceState): string {
  switch (state) {
    case 'online':
      return 'Online';
    case 'unavailable':
      return 'Away';
    case 'offline':
      return 'Offline';
  }
}
