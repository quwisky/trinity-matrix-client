import { InjectionToken, inject } from '@angular/core';
import type { NotificationEngine } from './notification-engine';
import { JsSdkNotificationEngine } from './js-sdk/js-sdk-notification-engine';

export const NOTIFICATION_ENGINE = new InjectionToken<NotificationEngine>(
  'NOTIFICATION_ENGINE',
  { providedIn: 'root', factory: () => inject(JsSdkNotificationEngine) },
);
