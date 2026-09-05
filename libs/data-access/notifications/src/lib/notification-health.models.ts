import type {
  CapabilityHealthFact,
  CapabilityIncident,
} from '@trinity/runtime/projection';

export type NotificationRuleHealth = CapabilityHealthFact<
  'notifications',
  'room-rules',
  | 'room-rules-preparing'
  | 'room-rules-ready'
  | 'room-rules-not-demanded'
  | 'room-rules-reconciliation-failed'
  | 'room-rules-ownership-released'
  | 'room-rules-preparation-timeout'
>;

export type NotificationLifetimeEvent =
  | { readonly kind: 'prepared' }
  | { readonly kind: 'health'; readonly fact: NotificationRuleHealth };

export type NotificationPresentationHealth = CapabilityHealthFact<
  'notifications',
  'presentation',
  | 'notification-presentation-preparing'
  | 'notification-presentation-ready'
  | 'notification-presentation-not-demanded'
  | 'notification-presentation-unsupported'
  | 'notification-presentation-disabled'
  | 'notification-presentation-unavailable'
  | 'notification-activation-ownership-released'
  | 'notification-presentation-timeout'
>;

export type NotificationIncident = CapabilityIncident<
  'notifications',
  'presentation-command' | 'activation' | 'navigation',
  | 'notification-presentation-failed'
  | 'notification-navigation-rejected'
  | 'notification-navigation-failed'
>;

export type NativePushHealth = CapabilityHealthFact<
  'push',
  'registration',
  | 'push-registration-preparing'
  | 'push-registration-ready'
  | 'push-registration-unsupported'
  | 'push-registration-not-configured'
  | 'push-registration-no-account'
  | 'push-permission-disabled'
  | 'push-device-registration-failed'
  | 'push-pusher-registration-failed'
  | 'push-pusher-verification-failed'
  | 'push-listener-ownership-released'
  | 'push-registration-timeout'
>;

export type NativePushLifetimeEvent =
  | { readonly kind: 'prepared' }
  | { readonly kind: 'health'; readonly fact: NativePushHealth }
  | {
      readonly kind: 'activated';
      readonly destination: import('./push.service').NativePushActivation;
    };
