export type CoverageStatus = 'shared-now' | 'portable-later' | 'web-only';

interface SharedCoverage {
  webSpec: string;
  androidSpec: string;
  status: 'shared-now';
}

interface WebOnlyCoverage {
  webSpec: string;
  status: 'web-only';
  reason: string;
}

export const sharedNow = [
  {
    webSpec: 'app.spec.mts',
    androidSpec: 'app-shell.spec.mts',
    status: 'shared-now',
  },
  {
    webSpec: 'navigation.spec.mts',
    androidSpec: 'navigation.spec.mts',
    status: 'shared-now',
  },
] satisfies SharedCoverage[];

export const webOnly = [
  {
    webSpec: 'keyboard-shortcuts-settings.spec.mts',
    status: 'web-only',
    reason: 'Desktop keyboard shortcut behavior has no Android interaction equivalent.',
  },
  {
    webSpec: 'oidc-login.spec.mts',
    status: 'web-only',
    reason: 'Native OIDC crosses into a system browser and returns through a deep link.',
  },
  {
    webSpec: 'pane-resize.spec.mts',
    status: 'web-only',
    reason: 'The desktop pointer-resizable pane is not rendered in the mobile layout.',
  },
  {
    webSpec: 'sso-login.spec.mts',
    status: 'web-only',
    reason: 'Native SSO crosses into a system browser and returns through a deep link.',
  },
  {
    webSpec: 'sso-recovery-reset.spec.mts',
    status: 'web-only',
    reason: 'Native SSO recovery crosses the system-browser and deep-link boundary.',
  },
] satisfies WebOnlyCoverage[];

/** Explicit backlog: adding a web spec requires classifying it before the guard passes. */
export const portableLater = [
  'block-member.spec.mts',
  'change-password.spec.mts',
  'clear-all-data.spec.mts',
  'composer-drafts.spec.mts',
  'composer-formatting.spec.mts',
  'composer-mentions.spec.mts',
  'composer-reactions.spec.mts',
  'composer-typing.spec.mts',
  'date-time-format.spec.mts',
  'dm-avatar.spec.mts',
  'drawer-swipe.spec.mts',
  'favourite-rooms.spec.mts',
  'gif.spec.mts',
  'hide-system-messages.spec.mts',
  'jump-to-date.spec.mts',
  'jump-to-latest.spec.mts',
  'key-export.spec.mts',
  'keyword-notifications.spec.mts',
  'kick-member.spec.mts',
  'kit-state-styling.spec.mts',
  'leave-room.spec.mts',
  'link-preview.spec.mts',
  'location-share.spec.mts',
  'mark-read.spec.mts',
  'mark-unread.spec.mts',
  'member-info.spec.mts',
  'member-roles.spec.mts',
  'message-action-sheet.spec.mts',
  'message-edit-history.spec.mts',
  'message-forward.spec.mts',
  'message-grouping.spec.mts',
  'message-linkify.spec.mts',
  'message-links.spec.mts',
  'message-markdown.spec.mts',
  'message-poll.spec.mts',
  'message-quote.spec.mts',
  'message-receipts.spec.mts',
  'message-shield.spec.mts',
  'message-source.spec.mts',
  'message-spoiler.spec.mts',
  'message-swipe.spec.mts',
  'message-unread.spec.mts',
  'mobile-nav.spec.mts',
  'mobile-navigation.spec.mts',
  'multi-account.spec.mts',
  'notification-settings.spec.mts',
  'notification-sound.spec.mts',
  'notifications.spec.mts',
  'pin-messages.spec.mts',
  'pinned-messages.spec.mts',
  'presence.spec.mts',
  'promote-member.spec.mts',
  'push-gateway.spec.mts',
  'quote-mentions.spec.mts',
  'reactions-who.spec.mts',
  'read-receipts-privacy.spec.mts',
  'recent-activity.spec.mts',
  'recovery-reset.spec.mts',
  'redact-others.spec.mts',
  'report-message.spec.mts',
  'room-directory.spec.mts',
  'room-filter-spaceless.spec.mts',
  'room-in-url.spec.mts',
  'room-list.spec.mts',
  'room-notifications.spec.mts',
  'room-settings-widgets-mobile.spec.mts',
  'room-settings.spec.mts',
  'room-shortcuts.spec.mts',
  'search-focus.spec.mts',
  'security-settings.spec.mts',
  'seen-by.spec.mts',
  'settings-scrollbars.spec.mts',
  'settings.spec.mts',
  'sidebar-filter.spec.mts',
  'sidebar-touch.spec.mts',
  'slash-commands.spec.mts',
  'space-curation.spec.mts',
  'space-directory.spec.mts',
  'space-room-order.spec.mts',
  'space-settings.spec.mts',
  'switch-state.spec.mts',
  'text-scaling.spec.mts',
  'thread-composer.spec.mts',
  'timeline-anchoring.spec.mts',
  'timeline-events.spec.mts',
  'timeline-virtualization.spec.mts',
  'tombstone.spec.mts',
  'unread-badges.spec.mts',
  'verify-user.spec.mts',
  'voice-message.spec.mts',
] as const;

export const androidOnly = [
  {
    androidSpec: 'navigation.spec.mts',
    journey: 'hardware Back and force-stop/relaunch session restoration',
  },
] as const;
