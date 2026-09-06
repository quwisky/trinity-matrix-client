import {
  BROWSER_CAPABILITIES,
  BROWSER_CONTRACT_TYPES,
  type BrowserCapability,
  type BrowserContractType,
} from '../registry/browser-classification.mts';

export { BROWSER_CAPABILITIES, BROWSER_CONTRACT_TYPES, type BrowserCapability };

export interface BrowserJourneyDefinition {
  /** Path relative to e2e/browser. */
  readonly path: `journeys/${BrowserCapability}/${string}.spec.mts`;
  readonly capability: BrowserCapability;
  /** The primary contract exercised by this journey. */
  readonly contractType: BrowserContractType;
}

const defineBrowserJourneys = <
  const T extends readonly BrowserJourneyDefinition[],
>(
  journeys: T,
): T => journeys;

/**
 * Canonical browser inventory. Each independently focusable spec has exactly one
 * owning capability and one primary contract classification.
 */
export const BROWSER_JOURNEYS = defineBrowserJourneys([
  {
    path: 'journeys/accounts/account-lifecycle.spec.mts',
    capability: 'accounts',
    contractType: 'journey',
  },
  {
    path: 'journeys/accounts/account-notification-routing.spec.mts',
    capability: 'accounts',
    contractType: 'journey',
  },
  {
    path: 'journeys/accounts/change-password.spec.mts',
    capability: 'accounts',
    contractType: 'security',
  },
  {
    path: 'journeys/accounts/clear-all-data.spec.mts',
    capability: 'accounts',
    contractType: 'security',
  },
  {
    path: 'journeys/accounts/mixed-account-workspace.spec.mts',
    capability: 'accounts',
    contractType: 'journey',
  },
  {
    path: 'journeys/accounts/oidc-login.spec.mts',
    capability: 'accounts',
    contractType: 'security',
  },
  {
    path: 'journeys/accounts/registration.spec.mts',
    capability: 'accounts',
    contractType: 'journey',
  },
  {
    path: 'journeys/accounts/sso-login.spec.mts',
    capability: 'accounts',
    contractType: 'security',
  },
  {
    path: 'journeys/conversations/composer-drafts.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/composer-formatting.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/composer-insert-sheet.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/composer-mentions.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/composer-reactions.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/composer-typing.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/gif.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/hide-system-messages.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/jump-to-date.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/jump-to-latest.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/link-preview.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/location-share.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/message-action-sheet.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/message-edit-history.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/message-forward.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/message-grouping.spec.mts',
    capability: 'conversations',
    contractType: 'visual',
  },
  {
    path: 'journeys/conversations/message-linkify.spec.mts',
    capability: 'conversations',
    contractType: 'security',
  },
  {
    path: 'journeys/conversations/message-links.spec.mts',
    capability: 'conversations',
    contractType: 'security',
  },
  {
    path: 'journeys/conversations/message-markdown.spec.mts',
    capability: 'conversations',
    contractType: 'security',
  },
  {
    path: 'journeys/conversations/message-poll.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/message-quote.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/message-receipts.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/message-source.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/message-spoiler.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/message-swipe.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/message-unread.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/pinned-message-panel.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/pinned-message-workflow.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/quote-mentions.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/reactions-who.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/read-receipts-privacy.spec.mts',
    capability: 'conversations',
    contractType: 'security',
  },
  {
    path: 'journeys/conversations/seen-by.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/slash-commands.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/stickers-custom-emoji.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/thread-composer.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/timeline-anchoring.spec.mts',
    capability: 'conversations',
    contractType: 'visual',
  },
  {
    path: 'journeys/conversations/timeline-events.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/conversations/timeline-virtualization.spec.mts',
    capability: 'conversations',
    contractType: 'visual',
  },
  {
    path: 'journeys/conversations/voice-message.spec.mts',
    capability: 'conversations',
    contractType: 'journey',
  },
  {
    path: 'journeys/discovery-search/room-directory.spec.mts',
    capability: 'discovery-search',
    contractType: 'journey',
  },
  {
    path: 'journeys/discovery-search/search-focus.spec.mts',
    capability: 'discovery-search',
    contractType: 'journey',
  },
  {
    path: 'journeys/discovery-search/space-directory.spec.mts',
    capability: 'discovery-search',
    contractType: 'journey',
  },
  {
    path: 'journeys/host-shell/design-system-contract.spec.mts',
    capability: 'host-shell',
    contractType: 'visual',
  },
  {
    path: 'journeys/host-shell/kit-state-styling.spec.mts',
    capability: 'host-shell',
    contractType: 'visual',
  },
  {
    path: 'journeys/host-shell/system-status.spec.mts',
    capability: 'host-shell',
    contractType: 'accessibility',
  },
  {
    path: 'journeys/host-shell/unauthenticated-shell.spec.mts',
    capability: 'host-shell',
    contractType: 'host',
  },
  {
    path: 'journeys/identity/dm-avatar.spec.mts',
    capability: 'identity',
    contractType: 'journey',
  },
  {
    path: 'journeys/identity/presence.spec.mts',
    capability: 'identity',
    contractType: 'journey',
  },
  {
    path: 'journeys/notifications/keyword-notifications.spec.mts',
    capability: 'notifications',
    contractType: 'journey',
  },
  {
    path: 'journeys/notifications/notification-settings.spec.mts',
    capability: 'notifications',
    contractType: 'journey',
  },
  {
    path: 'journeys/notifications/notification-sound.spec.mts',
    capability: 'notifications',
    contractType: 'journey',
  },
  {
    path: 'journeys/notifications/notifications.spec.mts',
    capability: 'notifications',
    contractType: 'journey',
  },
  {
    path: 'journeys/notifications/push-gateway.spec.mts',
    capability: 'notifications',
    contractType: 'journey',
  },
  {
    path: 'journeys/notifications/room-notifications.spec.mts',
    capability: 'notifications',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/block-member.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/kick-member.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/member-info.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/member-roles.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/promote-member.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/redact-others.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/report-message.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/room-access-settings.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/room-members-and-addresses.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/room-profile-settings.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/room-settings-general-mobile.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/room-settings-for-you-mobile.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/room-settings-for-you.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/room-settings-widgets-mobile.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/room-widget-settings.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/space-leave.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/space-settings-mobile.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/space-settings-resilience.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/space-settings.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-administration/tombstone.spec.mts',
    capability: 'room-administration',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/favourite-rooms.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/leave-room.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/mark-read.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/mark-unread.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/recent-activity.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/room-filter-spaceless.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/room-http-error-recovery.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/room-list.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/sidebar-filter.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/sidebar-touch.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/space-curation.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/space-room-order.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/room-library/unread-badges.spec.mts',
    capability: 'room-library',
    contractType: 'journey',
  },
  {
    path: 'journeys/settings/account-server-profile.spec.mts',
    capability: 'settings',
    contractType: 'journey',
  },
  {
    path: 'journeys/settings/appearance-preferences.spec.mts',
    capability: 'settings',
    contractType: 'visual',
  },
  {
    path: 'journeys/settings/date-time-format.spec.mts',
    capability: 'settings',
    contractType: 'journey',
  },
  {
    path: 'journeys/settings/keyboard-shortcuts.spec.mts',
    capability: 'settings',
    contractType: 'accessibility',
  },
  {
    path: 'journeys/settings/preference-reset.spec.mts',
    capability: 'settings',
    contractType: 'security',
  },
  {
    path: 'journeys/settings/settings-navigation-layout.spec.mts',
    capability: 'settings',
    contractType: 'visual',
  },
  {
    path: 'journeys/settings/switch-state.spec.mts',
    capability: 'settings',
    contractType: 'visual',
  },
  {
    path: 'journeys/settings/text-scaling.spec.mts',
    capability: 'settings',
    contractType: 'visual',
  },
  {
    path: 'journeys/trust/key-export.spec.mts',
    capability: 'trust',
    contractType: 'security',
  },
  {
    path: 'journeys/trust/message-shield.spec.mts',
    capability: 'trust',
    contractType: 'security',
  },
  {
    path: 'journeys/trust/recovery-reset.spec.mts',
    capability: 'trust',
    contractType: 'security',
  },
  {
    path: 'journeys/trust/security-settings.spec.mts',
    capability: 'trust',
    contractType: 'security',
  },
  {
    path: 'journeys/trust/sso-recovery-reset.spec.mts',
    capability: 'trust',
    contractType: 'security',
  },
  {
    path: 'journeys/trust/verify-user.spec.mts',
    capability: 'trust',
    contractType: 'security',
  },
  {
    path: 'journeys/workspace/compact-room-details.spec.mts',
    capability: 'workspace',
    contractType: 'journey',
  },
  {
    path: 'journeys/workspace/compact-room-routing.spec.mts',
    capability: 'workspace',
    contractType: 'journey',
  },
  {
    path: 'journeys/workspace/drawer-swipe.spec.mts',
    capability: 'workspace',
    contractType: 'journey',
  },
  {
    path: 'journeys/workspace/pane-resize.spec.mts',
    capability: 'workspace',
    contractType: 'visual',
  },
  {
    path: 'journeys/workspace/responsive-surfaces.spec.mts',
    capability: 'workspace',
    contractType: 'visual',
  },
  {
    path: 'journeys/workspace/room-in-url.spec.mts',
    capability: 'workspace',
    contractType: 'journey',
  },
  {
    path: 'journeys/workspace/room-shortcuts.spec.mts',
    capability: 'workspace',
    contractType: 'journey',
  },
  {
    path: 'journeys/workspace/settings-overlay-routing.spec.mts',
    capability: 'workspace',
    contractType: 'journey',
  },
  {
    path: 'journeys/workspace/shell-layout.spec.mts',
    capability: 'workspace',
    contractType: 'visual',
  },
]);

export type BrowserJourneyPath = (typeof BROWSER_JOURNEYS)[number]['path'];

export const BROWSER_JOURNEY_BY_PATH = new Map<
  BrowserJourneyPath,
  (typeof BROWSER_JOURNEYS)[number]
>(BROWSER_JOURNEYS.map((journey) => [journey.path, journey]));
