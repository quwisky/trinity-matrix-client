import { describe, expect, it } from 'vitest';
import {
  CODE_LINE_PRESENTATION_PREFERENCE,
  CODE_SIZE_PREFERENCE,
  CONVERSATION_APPEARANCE_PREFERENCE_DESCRIPTORS,
} from './appearance-preferences';

describe('Conversations Appearance preference descriptors', () => {
  it('owns code size and code-line presentation as portable installation preferences', () => {
    expect(CONVERSATION_APPEARANCE_PREFERENCE_DESCRIPTORS).toEqual([
      expect.objectContaining({
        id: 'conversations.appearance.code-size',
        owner: 'conversations',
        section: 'appearance',
        order: 50,
        scope: 'installation',
        defaultValue: 'default',
        sensitivity: 'public',
        storage: 'device-preferences',
        export: 'portable',
        editor: expect.objectContaining({
          kind: 'select',
          testId: 'code-size-select',
        }),
      }),
      expect.objectContaining({
        id: 'conversations.appearance.code-line-presentation',
        owner: 'conversations',
        section: 'appearance',
        order: 60,
        scope: 'installation',
        defaultValue: 'auto',
        sensitivity: 'public',
        storage: 'device-preferences',
        export: 'portable',
        editor: expect.objectContaining({
          kind: 'select',
          testId: 'code-lines-select',
        }),
      }),
    ]);
  });

  it('uses coherent current identities and read-only legacy keys', () => {
    expect(CODE_SIZE_PREFERENCE.persistence).toEqual(
      expect.objectContaining({
        key: 'trinity.appearance.code-size',
        legacyKeys: ['trinity.code-scale'],
      }),
    );
    expect(CODE_LINE_PRESENTATION_PREFERENCE.persistence).toEqual(
      expect.objectContaining({
        key: 'trinity.appearance.code-line-presentation',
        legacyKeys: ['trinity.code-lines'],
      }),
    );
  });

  it.each([
    [CODE_SIZE_PREFERENCE, ['smaller', 'default', 'larger'], 'huge'],
    [CODE_LINE_PRESENTATION_PREFERENCE, ['off', 'auto', 'always'], 'some'],
  ] as const)(
    'accepts only the closed values for $id',
    (descriptor, accepted, rejected) => {
      for (const value of accepted) {
        expect(descriptor.validate(value)).toEqual({
          kind: 'accepted',
          value,
        });
        expect(
          descriptor.persistence.migration.migrate({ version: 0, value }),
        ).toEqual({ kind: 'accepted', value });
      }
      expect(descriptor.validate(rejected).kind).toBe('rejected');
      expect(
        descriptor.persistence.migration.migrate({
          version: 2,
          value: accepted[0],
        }).kind,
      ).toBe('rejected');
    },
  );
});
