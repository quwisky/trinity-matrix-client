import { InjectionToken } from '@angular/core';
import type { NotificationPolicyInput } from './notification-intent';

/** Application-composed foreground context consumed by notification policy. */
export interface NotificationVisibilityPort {
  snapshot(): NotificationPolicyInput['visibility'];
}

export const NOTIFICATION_VISIBILITY =
  new InjectionToken<NotificationVisibilityPort>('NOTIFICATION_VISIBILITY');
