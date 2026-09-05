import type { ApplicationCapabilityHealth } from './capability-health.service';

export interface CapabilityStatusCopy {
  readonly capability: string;
  readonly heading: string;
  readonly condition: string;
  readonly consequence: string;
  readonly fallback: string;
  readonly recovery: string;
}

export const CAPABILITY_STATUS_CATALOG = {
  'accounts:restore': {
    capability: 'Accounts',
    heading: 'A background Account needs attention',
    condition: 'Trinity could not restore this Account.',
    consequence: 'Its Rooms and messages are temporarily unavailable.',
    fallback: 'Other Accounts and open Conversations remain usable.',
    recovery: 'Retry Account',
  },
  'identity:presence': {
    capability: 'People',
    heading: 'Presence is unavailable',
    condition: 'Trinity cannot currently read presence updates.',
    consequence: 'Online status may be out of date.',
    fallback: 'You can keep messaging normally.',
    recovery: 'Retry presence',
  },
  'preferences:apply-appearance': {
    capability: 'Appearance',
    heading: 'Appearance updates are paused',
    condition: 'A live appearance update could not be applied.',
    consequence: 'New appearance choices may not take effect yet.',
    fallback: 'The last applied appearance remains active.',
    recovery: 'Retry appearance',
  },
  'preferences:hydrate-appearance': preferenceCopy('appearance'),
  'preferences:hydrate-shell-layout': preferenceCopy('panel layout'),
  'preferences:hydrate-feature-flags': preferenceCopy('experimental features'),
  'preferences:hydrate-composer': preferenceCopy('composer settings'),
  'preferences:hydrate-date-time': preferenceCopy('date and time settings'),
  'preferences:hydrate-gifs': preferenceCopy('GIF settings'),
  'preferences:hydrate-gestures': preferenceCopy('message gestures'),
  'preferences:hydrate-privacy': preferenceCopy('privacy settings'),
  'preferences:hydrate-account-scope': preferenceCopy('Account scope'),
  'preferences:hydrate-push-gateway': preferenceCopy('push gateway settings'),
  'preferences:hydrate-shortcuts': preferenceCopy('keyboard shortcuts'),
  'preferences:hydrate-system-lines': preferenceCopy('system-message settings'),
  'room-library:hydrate-order': {
    capability: 'Rooms',
    heading: 'Saved Room ordering is unavailable',
    condition: 'Trinity could not read this Account’s saved Room order.',
    consequence: 'Rooms may appear in a different order.',
    fallback: 'The default order remains available.',
    recovery: 'Retry Room ordering',
  },
  'trust:projection': {
    capability: 'Encryption',
    heading: 'Encryption trust status is unavailable',
    condition: 'Trinity cannot confirm the latest verification state.',
    consequence: 'Verification and recovery status may be out of date.',
    fallback: 'Encrypted Conversations remain usable.',
    recovery: 'Retry trust status',
  },
  'notifications:room-rules': {
    capability: 'Notifications',
    heading: 'Room notification settings are unavailable',
    condition: 'Trinity cannot read the latest Room notification rules.',
    consequence: 'The settings shown for a Room may be stale.',
    fallback: 'Notification delivery continues independently.',
    recovery: 'Retry Room settings',
  },
  'notifications:presentation': {
    capability: 'Notifications',
    heading: 'Device notifications are unavailable',
    condition: 'This device cannot currently present new notifications.',
    consequence: 'New-message alerts may not appear outside Trinity.',
    fallback: 'Messaging and Room notification settings remain usable.',
    recovery: 'Retry notifications',
  },
  'push:registration': {
    capability: 'Notifications',
    heading: 'Mobile push is unavailable',
    condition: 'This device could not register for push messages.',
    consequence: 'Notifications may not arrive while Trinity is closed.',
    fallback: 'In-app messaging remains usable.',
    recovery: 'Retry mobile push',
  },
  'room-administration:permissions': roomAdministrationCopy('permissions'),
  'room-administration:members': roomAdministrationCopy('member list'),
  'room-administration:bans': roomAdministrationCopy('ban list'),
  'badge:support': {
    capability: 'App icon',
    heading: 'App badge updates are unavailable',
    condition: 'Trinity could not update the app-icon badge.',
    consequence: 'The icon may show an old unread count.',
    fallback: 'Unread counts remain visible inside Trinity.',
    recovery: 'Retry badge',
  },
  'updates:check': {
    capability: 'Updates',
    heading: 'Automatic update checks are unavailable',
    condition: 'Trinity could not check for a newer version.',
    consequence: 'An available update may not be announced.',
    fallback: 'Keep using Trinity and check again later.',
    recovery: 'Retry update check',
  },
  'host:contract': {
    capability: 'Device integration',
    heading: 'Some device integrations are unavailable',
    condition: 'This Trinity host uses a different integration protocol.',
    consequence: 'One or more device actions may not work.',
    fallback: 'Core messaging remains available.',
    recovery: 'Check again',
  },
  'storage:persistence': {
    capability: 'Local storage',
    heading: 'Protected browser storage is unavailable',
    condition: 'The browser did not grant persistent storage.',
    consequence:
      'The browser may clear local Trinity data under storage pressure.',
    fallback: 'Trinity continues with best-effort local storage.',
    recovery: 'Request storage again',
  },
} as const satisfies Record<string, CapabilityStatusCopy>;

const UNKNOWN_COPY: CapabilityStatusCopy = {
  capability: 'Trinity',
  heading: 'A feature needs attention',
  condition: 'Trinity received a status it does not recognise.',
  consequence: 'Part of the app may be temporarily limited.',
  fallback: 'Other features remain available where it is safe to continue.',
  recovery: 'Try again',
};

export function capabilityStatusCopy(
  problem: Pick<ApplicationCapabilityHealth, 'capability' | 'operation'>,
): CapabilityStatusCopy {
  return (
    CAPABILITY_STATUS_CATALOG[
      `${problem.capability}:${problem.operation}` as keyof typeof CAPABILITY_STATUS_CATALOG
    ] ?? UNKNOWN_COPY
  );
}

function preferenceCopy(name: string): CapabilityStatusCopy {
  return {
    capability: 'Settings',
    heading: `Saved ${name} are unavailable`,
    condition: `Trinity could not restore ${name}.`,
    consequence: `Some ${name} may differ from your saved choices.`,
    fallback: 'Safe defaults are active and can be changed later.',
    recovery: 'Retry settings',
  };
}

function roomAdministrationCopy(name: string): CapabilityStatusCopy {
  return {
    capability: 'Room administration',
    heading: `The current Room ${name} is unavailable`,
    condition: `Trinity cannot read the latest ${name}.`,
    consequence: 'Administrative actions that depend on it are paused.',
    fallback: 'Messaging and unrelated Room settings remain usable.',
    recovery: 'Retry Room administration',
  };
}
