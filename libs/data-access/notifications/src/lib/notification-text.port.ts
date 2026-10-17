import { InjectionToken } from '@angular/core';

/** What notifications may say (App lock's Notification text). */
export type NotificationTextMode =
  'show' | 'hide-on-lock-screen' | 'always-hide';

/**
 * Application-composed; absent means Show. Notifications never depends on App lock. Read for
 * each notification, so a change applies to the next one.
 */
export interface NotificationTextPort {
  mode(): NotificationTextMode;
}

export const NOTIFICATION_TEXT = new InjectionToken<NotificationTextPort>(
  'NOTIFICATION_TEXT',
);
