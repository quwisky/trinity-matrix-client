import type { NotificationText } from './app-lock.preferences';

/**
 * What notifications may show now (spec §5), for every path that presents or mirrors them.
 * Until the settings are known (before hydration) everything is hidden, as the stored choice
 * might hide it. Then Show while App lock is off; otherwise the choice, except that a desktop,
 * which has no lock-screen setting to follow, hides everything for "Hide on the lock screen".
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
