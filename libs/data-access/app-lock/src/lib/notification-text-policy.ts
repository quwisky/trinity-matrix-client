import type { NotificationText } from './app-lock.preferences';

/**
 * What notifications may show now, for every path that presents or mirrors them. Until the
 * settings are known everything is hidden, as the stored choice might hide it; a desktop has
 * no lock-screen setting to follow, so "Hide on the lock screen" hides everything there.
 */
export function effectiveNotificationText(state: {
  readonly known: boolean;
  readonly enabled: boolean;
  readonly choice: NotificationText;
  readonly lockScreenOffered: boolean;
}): NotificationText {
  if (!state.known) return 'always-hide';
  if (!state.enabled) return 'show';
  return state.choice === 'hide-on-lock-screen' && !state.lockScreenOffered
    ? 'always-hide'
    : state.choice;
}
