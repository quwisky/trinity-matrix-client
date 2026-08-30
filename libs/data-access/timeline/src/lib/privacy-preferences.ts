import {
  definePreference,
  providePreferenceDescriptors,
  type PreferenceDescriptor,
  type PreferenceValidation,
  type PreferenceValue,
  type StoredPreference,
} from '@trinity/runtime/preferences';

export const SEND_READ_RECEIPTS_PREFERENCE = definePreference({
  id: 'conversations.privacy.send-read-receipts',
  owner: 'conversations',
  section: 'privacy',
  order: 10,
  scope: 'installation',
  defaultValue: true,
  sensitivity: 'private',
  storage: 'device-preferences',
  export: 'portable',
  editor: {
    kind: 'toggle',
    label: 'Send read receipts',
    description:
      "Let others see when you've read their messages. When off, your unread badges still clear, but your reading stays private to you on this device.",
    testId: 'privacy-send-read-receipts',
  },
  persistence: {
    key: 'trinity.privacy.send-read-receipts',
    migration: booleanMigration(),
  },
  validate: validateBoolean,
} satisfies PreferenceDescriptor<boolean>);

export const LINK_PREVIEWS_PREFERENCE = definePreference({
  id: 'conversations.privacy.link-previews',
  owner: 'conversations',
  section: 'privacy',
  order: 20,
  scope: 'installation',
  defaultValue: true,
  sensitivity: 'private',
  storage: 'device-preferences',
  export: 'portable',
  editor: {
    kind: 'toggle',
    label: 'Show link previews',
    description:
      "Show a preview for links in messages. Previews are fetched through your homeserver — in an unencrypted room, that's a link it can already see.",
    testId: 'privacy-link-previews',
  },
  persistence: {
    key: 'trinity.privacy.link-previews',
    migration: booleanMigration(),
  },
  validate: validateBoolean,
} satisfies PreferenceDescriptor<boolean>);

export const ENCRYPTED_LINK_PREVIEWS_PREFERENCE = definePreference({
  id: 'conversations.privacy.link-previews-encrypted',
  owner: 'conversations',
  section: 'privacy',
  order: 30,
  scope: 'installation',
  defaultValue: false,
  sensitivity: 'private',
  storage: 'device-preferences',
  export: 'portable',
  editor: {
    kind: 'toggle',
    label: 'Show link previews in encrypted rooms',
    description:
      "⚠ Off by default. Turning this on sends links from your encrypted messages to your homeserver to fetch a preview — disclosing a link it otherwise couldn't see.",
    testId: 'privacy-link-previews-encrypted',
    nested: true,
    visibleWhen: {
      preferenceId: LINK_PREVIEWS_PREFERENCE.id,
      equals: true,
    },
  },
  persistence: {
    key: 'trinity.privacy.link-previews-encrypted',
    migration: booleanMigration(),
  },
  validate: validateBoolean,
} satisfies PreferenceDescriptor<boolean>);

export const PRIVACY_PREFERENCE_DESCRIPTORS: readonly PreferenceDescriptor<PreferenceValue>[] =
  [
    SEND_READ_RECEIPTS_PREFERENCE,
    LINK_PREVIEWS_PREFERENCE,
    ENCRYPTED_LINK_PREVIEWS_PREFERENCE,
  ];

export const CONVERSATION_PRIVACY_PREFERENCES = {
  sendReadReceipts: SEND_READ_RECEIPTS_PREFERENCE,
  linkPreviews: LINK_PREVIEWS_PREFERENCE,
  linkPreviewsInEncrypted: ENCRYPTED_LINK_PREVIEWS_PREFERENCE,
} as const;

/** Contributes Conversations-owned privacy policy to the application catalog. */
export function provideConversationPrivacyPreferences() {
  return providePreferenceDescriptors(() => PRIVACY_PREFERENCE_DESCRIPTORS);
}

function validateBoolean(value: unknown): PreferenceValidation<boolean> {
  return typeof value === 'boolean'
    ? { kind: 'accepted', value }
    : {
        kind: 'rejected',
        diagnostic: { code: 'preference-expected-boolean' },
      };
}

function booleanMigration() {
  return {
    currentVersion: 1,
    migrate: (stored: StoredPreference): PreferenceValidation<boolean> => {
      if (stored.version !== 0 && stored.version !== 1) {
        return {
          kind: 'rejected',
          diagnostic: { code: 'preference-version-unsupported' },
        };
      }
      if (typeof stored.value === 'boolean') {
        return { kind: 'accepted', value: stored.value };
      }
      if (stored.version === 0 && stored.value === 'true') {
        return { kind: 'accepted', value: true };
      }
      if (stored.version === 0 && stored.value === 'false') {
        return { kind: 'accepted', value: false };
      }
      return {
        kind: 'rejected',
        diagnostic: { code: 'preference-boolean-migration-rejected' },
      };
    },
  } as const;
}
