import { describe, expect, it } from 'vitest';
import {
  ENCRYPTED_LINK_PREVIEWS_PREFERENCE,
  KEEP_PHOTO_METADATA_PREFERENCE,
  LINK_PREVIEWS_PREFERENCE,
  PRIVACY_PREFERENCE_DESCRIPTORS,
  SAVE_CAPTURES_TO_GALLERY_PREFERENCE,
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
      expect.objectContaining({
        id: 'conversations.privacy.save-captures-to-gallery',
        owner: 'conversations',
        section: 'privacy-capture',
        order: 10,
        scope: 'installation',
        defaultValue: false,
        sensitivity: 'private',
        storage: 'device-preferences',
        export: 'portable',
        editor: expect.objectContaining({
          kind: 'toggle',
          label: "Save photos and videos I take to this device's gallery",
          testId: 'privacy-save-captures-to-gallery',
        }),
      }),
      expect.objectContaining({
        id: 'conversations.privacy.keep-photo-metadata',
        owner: 'conversations',
        section: 'privacy',
        order: 40,
        scope: 'installation',
        defaultValue: false,
        sensitivity: 'private',
        storage: 'device-preferences',
        export: 'portable',
        editor: expect.objectContaining({
          kind: 'toggle',
          label: 'Keep photo and video metadata',
          testId: 'privacy-keep-photo-metadata',
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
      'trinity.privacy.save-captures-to-gallery',
      'trinity.privacy.keep-photo-metadata',
    ]);
  });

  it('explains what keeping photo and video metadata shares and that profile and room photos never keep it', () => {
    const editor = KEEP_PHOTO_METADATA_PREFERENCE.editor;
    if (editor.kind !== 'toggle') throw new Error('expected a toggle');

    // Flagged like the other opt-in that weakens privacy, encrypted link previews.
    expect(editor.description).toMatch(/^⚠ Off by default\./);
    expect(editor.description).toMatch(/photos and videos/);
    expect(editor.description).toMatch(/where/);
    expect(editor.description).toMatch(/device/);
    expect(editor.description).toMatch(/HDR/);
    expect(editor.description).toMatch(/Motion Photo/);
    expect(editor.description).toMatch(/[Pp]rofile and room photos/);
  });

  it.each([
    ['send read receipts', SEND_READ_RECEIPTS_PREFERENCE],
    ['link previews', LINK_PREVIEWS_PREFERENCE],
    ['encrypted link previews', ENCRYPTED_LINK_PREVIEWS_PREFERENCE],
    ['save captures to gallery', SAVE_CAPTURES_TO_GALLERY_PREFERENCE],
    ['keep photo and video metadata', KEEP_PHOTO_METADATA_PREFERENCE],
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
