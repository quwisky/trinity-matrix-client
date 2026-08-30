import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_LINK_PREVIEWS_PREFERENCE,
  LINK_PREVIEWS_PREFERENCE,
  PRIVACY_PREFERENCE_DESCRIPTORS,
  SEND_READ_RECEIPTS_PREFERENCE,
} from './privacy-preferences';

describe('privacy preference descriptors', () => {
  it('declare the complete policy and editor metadata owned by Conversations', () => {
    expect(PRIVACY_PREFERENCE_DESCRIPTORS).toEqual([
      expect.objectContaining({
        id: 'conversations.privacy.send-read-receipts',
        owner: 'conversations',
        section: 'privacy',
        order: 10,
        scope: 'installation',
        defaultValue: true,
        sensitivity: 'private',
        storage: 'device-preferences',
        export: 'portable',
        editor: expect.objectContaining({ kind: 'toggle' }),
      }),
      expect.objectContaining({
        id: 'conversations.privacy.link-previews',
        owner: 'conversations',
        section: 'privacy',
        order: 20,
        scope: 'installation',
        defaultValue: true,
        sensitivity: 'private',
        storage: 'device-preferences',
        export: 'portable',
        editor: expect.objectContaining({ kind: 'toggle' }),
      }),
      expect.objectContaining({
        id: 'conversations.privacy.link-previews-encrypted',
        owner: 'conversations',
        section: 'privacy',
        order: 30,
        scope: 'installation',
        defaultValue: false,
        sensitivity: 'private',
        storage: 'device-preferences',
        export: 'portable',
        editor: expect.objectContaining({
          kind: 'toggle',
          nested: true,
          visibleWhen: {
            preferenceId: LINK_PREVIEWS_PREFERENCE.id,
            equals: true,
          },
        }),
      }),
    ]);
  });

  it('owns the production persistence keys', () => {
    expect(
      PRIVACY_PREFERENCE_DESCRIPTORS.map(
        (descriptor) => descriptor.persistence.key,
      ),
    ).toEqual([
      'trinity.privacy.send-read-receipts',
      'trinity.privacy.link-previews',
      'trinity.privacy.link-previews-encrypted',
    ]);
  });

  it.each([
    ['send read receipts', SEND_READ_RECEIPTS_PREFERENCE],
    ['link previews', LINK_PREVIEWS_PREFERENCE],
    ['encrypted link previews', ENCRYPTED_LINK_PREVIEWS_PREFERENCE],
  ] as const)('migrates real %s legacy and current values', (_, descriptor) => {
    const migration = descriptor.persistence.migration;

    expect(migration.migrate({ version: 0, value: 'true' })).toEqual({
      kind: 'accepted',
      value: true,
    });
    expect(migration.migrate({ version: 0, value: 'false' })).toEqual({
      kind: 'accepted',
      value: false,
    });
    expect(migration.migrate({ version: 1, value: true })).toEqual({
      kind: 'accepted',
      value: true,
    });
    expect(migration.migrate({ version: 0, value: 'not-a-boolean' })).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'preference-boolean-migration-rejected' },
    });
    expect(migration.migrate({ version: 2, value: true })).toEqual({
      kind: 'rejected',
      diagnostic: { code: 'preference-version-unsupported' },
    });
  });
});
