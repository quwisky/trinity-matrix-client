/** Which library owns a stored key. */
export type ConfigOwner =
  | 'application/appearance'
  | 'data-access/timeline'
  | 'platform-native'
  | 'data-access/gif'
  | 'data-access/whats-new'
  | 'data-access/notifications'
  | 'data-access/room-library'
  | 'data-access/diagnostic-log'
  | 'data-access/app-lock'
  | 'data-access/trust'
  | 'runtime/projection'
  | 'feature/settings';

/**
 * What the config export does with one stored key.
 *
 * `exported` — it appears in the document. `excluded` — it is a real stored preference kept
 * out on purpose. `internal` — it is not a stored preference at all.
 */
export type ConfigKeyRecord =
  | {
      readonly disposition: 'exported';
      readonly key: string;
      readonly owner: ConfigOwner;
    }
  | {
      readonly disposition: 'excluded' | 'internal';
      readonly key: string;
      readonly owner: ConfigOwner;
      readonly reason: string;
    };

/**
 * Every `trinity.*` key the workspace stores, and what the export does with it.
 *
 * The single classification table, and the one thing that has to stay in step as settings
 * are added — which is why it is guarded mechanically rather than by discipline:
 * `scripts/config-schema-drift.spec.mjs` fails when a `trinity.*` literal exists in shipped
 * source and is not listed here, and when a key listed here no longer exists. The issue's
 * own key table had drifted from 13 keys to 24 in the weeks before this was written; that is
 * the evidence the guard exists for.
 *
 * Other stores are excluded wholesale rather than key by key — see
 * {@link CONFIG_EXCLUSION_NOTES}.
 */
export const CONFIG_KEY_LEDGER: readonly ConfigKeyRecord[] = [
  // — application/appearance —
  {
    disposition: 'exported',
    key: 'trinity.appearance.mode',
    owner: 'application/appearance',
  },
  {
    disposition: 'exported',
    key: 'trinity.appearance.theme',
    owner: 'application/appearance',
  },
  {
    disposition: 'exported',
    key: 'trinity.appearance.text-size',
    owner: 'application/appearance',
  },
  {
    disposition: 'exported',
    key: 'trinity.appearance.density',
    owner: 'application/appearance',
  },
  {
    disposition: 'exported',
    key: 'trinity.appearance.room-list',
    owner: 'application/appearance',
  },

  // — data-access/timeline —
  {
    disposition: 'exported',
    key: 'trinity.appearance.code-size',
    owner: 'data-access/timeline',
  },
  {
    disposition: 'exported',
    key: 'trinity.appearance.code-line-presentation',
    owner: 'data-access/timeline',
  },
  {
    disposition: 'excluded',
    key: 'trinity.composer.expression-tab',
    owner: 'data-access/timeline',
    reason:
      'The expression panel tab this device used last. It records how one device was ' +
      'used, not a setting, so another device must not inherit it.',
  },

  // — read-only Appearance predecessor keys —
  {
    disposition: 'excluded',
    key: 'trinity.theme',
    owner: 'application/appearance',
    reason:
      'Read-only Appearance migration predecessor; portable export uses the current descriptor key.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.palette',
    owner: 'application/appearance',
    reason:
      'Read-only Appearance migration predecessor; portable export uses the current descriptor key.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.text-scale',
    owner: 'application/appearance',
    reason:
      'Read-only Appearance migration predecessor; portable export uses the current descriptor key.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.density',
    owner: 'application/appearance',
    reason:
      'Read-only Appearance migration predecessor; portable export uses the current descriptor key.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.code-scale',
    owner: 'data-access/timeline',
    reason:
      'Read-only Appearance migration predecessor; portable export uses the current descriptor key.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.code-lines',
    owner: 'data-access/timeline',
    reason:
      'Read-only Appearance migration predecessor; portable export uses the current descriptor key.',
  },

  // — shell-layout.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.shell.sidebar-width',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.shell.right-panel-width',
    owner: 'platform-native',
  },

  // — privacy-settings.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.privacy.send-read-receipts',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.privacy.link-previews',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.privacy.link-previews-encrypted',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.privacy.save-captures-to-gallery',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.privacy.keep-photo-metadata',
    owner: 'platform-native',
  },

  // — system-line-settings.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.timeline.show-membership',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.timeline.show-profile',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.timeline.show-room-changes',
    owner: 'platform-native',
  },

  // — date-time-format.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.format.time',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.format.date',
    owner: 'platform-native',
  },

  // — message-gesture-settings.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.message-swipe',
    owner: 'platform-native',
  },

  // — feature-flags.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.flags.virtual-timeline',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.flags.defer-media-while-scrolling',
    owner: 'platform-native',
  },
  {
    disposition: 'exported',
    key: 'trinity.flags.fling-placeholders',
    owner: 'platform-native',
  },

  // — shortcuts/keyboard-shortcuts.service.ts —
  {
    disposition: 'exported',
    key: 'trinity.shortcuts.overrides',
    owner: 'platform-native',
  },

  // — data-access/whats-new —
  {
    disposition: 'excluded',
    key: 'trinity.whats-new.last-seen-version',
    owner: 'data-access/whats-new',
    reason:
      'The app version this device last opened. It records how one device was used, ' +
      'not a setting, so another device must not inherit it.',
  },

  // — data-access/gif —
  {
    disposition: 'exported',
    key: 'trinity.gif.config',
    owner: 'data-access/gif',
  },

  // — data-access/notifications —
  {
    disposition: 'excluded',
    key: 'trinity.push.gateway',
    owner: 'data-access/notifications',
    reason:
      'Retired: the device override of the push gateway from before the gateway became ' +
      'build configuration. RetiredPushGatewayCleanup deletes it at startup; nothing reads it.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.push.applied-app-id',
    owner: 'data-access/notifications',
    reason:
      'Retired: the ledger of the push app id the retired gateway setting registered. ' +
      'RetiredPushGatewayCleanup deletes it at startup; nothing reads it.',
  },

  // — platform-native, excluded and internal —
  {
    disposition: 'excluded',
    key: 'trinity.composer.drafts',
    owner: 'platform-native',
    reason:
      'Unsent message text, not configuration. It must not appear in a document someone ' +
      'pastes into a support thread, and Reset must never destroy it.',
  },
  {
    disposition: 'internal',
    key: 'trinity.message.private',
    owner: 'platform-native',
    reason:
      'Not a stored key at all: the iOS notification category for App lock’s "Hide on the ' +
      'lock screen", registered by AppDelegate with the placeholder "New message".',
  },

  // — data-access/room-library, excluded —
  {
    disposition: 'excluded',
    key: 'trinity.accounts.mixed',
    owner: 'data-access/room-library',
    reason:
      'A set of signed-in user ids. It cannot transfer — on a device signed into different ' +
      'accounts every id in it is inert — and it puts the same user-id material into a ' +
      'shareable document that excluding `matrix.accounts` was meant to keep out. The mix ' +
      'rebuilds itself as accounts are added.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.spaces.order.default.',
    owner: 'data-access/room-library',
    reason:
      'Per-account: the key is suffixed with a user id, so a portable document would carry ' +
      'an ordering addressed to an account the importing device may not have. Same user-id ' +
      'disclosure as `trinity.accounts.mixed`.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.spaces.order.overrides.',
    owner: 'data-access/room-library',
    reason:
      'Per-account like its sibling, and keyed by space room id on top — an override names ' +
      'spaces the importing account may not have joined.',
  },

  // — data-access/room-library, exported —
  {
    disposition: 'exported',
    key: 'trinity.rail.unread-chats',
    owner: 'data-access/room-library',
  },

  // — data-access/diagnostic-log —
  {
    disposition: 'excluded',
    key: 'trinity.diagnostics.keep-log',
    owner: 'data-access/diagnostic-log',
    reason:
      'A per-installation privacy choice about what this device records. A pasted or ' +
      'imported document must not switch logging on for another device, and an unreadable ' +
      'value already means off.',
  },

  // — data-access/app-lock —
  {
    disposition: 'excluded',
    key: 'trinity.app-lock.enabled',
    owner: 'data-access/app-lock',
    reason:
      'A per-device privacy choice; an imported document must not turn a lock on or off ' +
      'on another device, which may not even have the PIN it would need.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.app-lock.lock-after',
    owner: 'data-access/app-lock',
    reason:
      'A per-device privacy choice that only means something while that device has App ' +
      'lock on; it stays with the device like the lock itself.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.app-lock.notification-text',
    owner: 'data-access/app-lock',
    reason:
      'A per-device privacy choice nested under App lock; it means nothing on a device ' +
      'without the lock, and the native push renderers read their own mirror of it.',
  },

  // — data-access/trust —
  {
    disposition: 'excluded',
    key: 'trinity.trust.device-confirmation',
    owner: 'data-access/trust',
    reason:
      'Per-device record of a new sign-in that still has to be verified. Importing it ' +
      'elsewhere would hold another device at the new-device check, and dropping it ' +
      'would let this one skip the check.',
  },
  {
    disposition: 'excluded',
    key: 'trinity.trust.slot-forecast',
    owner: 'data-access/trust',
    reason:
      'Per-device memory of which encryption prompt this device last needed, used only to ' +
      'reserve the banner space at start-up. Another device has its own trust state.',
  },

  // — runtime/projection —
  {
    disposition: 'excluded',
    key: 'trinity.debug.projections',
    owner: 'runtime/projection',
    reason:
      'Development-only opt-in flag for the projection trace; never read in production builds ' +
      'and not a user preference.',
  },

  // — feature/settings —
  {
    disposition: 'internal',
    key: 'trinity.notification-sound',
    owner: 'feature/settings',
    reason:
      'Not a stored key at all: a map key standing for the sound switch inside the ' +
      'notifications page optimistic-state map. The preference itself lives in Matrix ' +
      'account data (`dev.trinityproject.trinity.notification_sound`), which is out of scope.',
  },
];

/**
 * The stores the export never touches at all, and why — the copy the Advanced section
 * shows so the omissions are stated rather than discovered.
 */
export const CONFIG_EXCLUSION_NOTES: readonly {
  readonly what: string;
  readonly reason: string;
}[] = [
  {
    what: 'Your signed-in accounts',
    reason:
      'This is a preferences transfer, not a sign-in transfer. The account registry keys ' +
      'each account by user id and device id, and those are what the stored access token ' +
      'and the per-device crypto store are addressed by — so a copied entry names a token ' +
      'and a crypto store that are not there. Sign in on the new device, then import.',
  },
  {
    what: 'Access tokens and encryption keys',
    reason:
      'They live in secure storage, which nothing here reads, so no account credential ' +
      'or key material can reach this document. The GIF API key is the one third-party ' +
      'secret it does carry — it is a service quota key, not an account credential.',
  },
  {
    what: 'Unsent message drafts',
    reason:
      'Half-typed messages are not configuration, and this document is meant to be safe to ' +
      'share. Reset to defaults leaves them alone too.',
  },
  {
    what: 'Settings your account carries for you',
    reason:
      'Notification rules and the notification sound live on your homeserver in Matrix ' +
      'account data, so they already follow you to a new device.',
  },
  {
    what: 'Half-finished sign-in state',
    reason:
      'The transient `oidc.*` and `sso.*` values exist only between leaving for a login ' +
      'page and coming back; restoring one elsewhere could only resume a flow that is over.',
  },
];

/**
 * The keys one library is expected to contribute entries for.
 *
 * Exported from the barrel because its consumers are the *other* libs' registry specs —
 * `gif-config-entries.spec.ts` and the other libs' config-entries specs assert their entries
 * match this list — and the Nx boundaries route those through `@trinity/platform-native`.
 */
export function exportedKeysFor(owner: ConfigOwner): readonly string[] {
  const keys: string[] = [];
  for (const record of CONFIG_KEY_LEDGER) {
    if (record.disposition === 'exported' && record.owner === owner) {
      keys.push(record.key);
    }
  }
  return keys;
}
