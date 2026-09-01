import {
  definePreference,
  providePreferenceDescriptors,
  type PreferenceDescriptor,
  type PreferenceValidation,
  type PreferenceValue,
  type StoredPreference,
} from '@trinity/runtime/preferences';

export const CODE_SIZE_OPTIONS = Object.freeze([
  Object.freeze({ id: 'smaller', label: 'Smaller', factor: 0.875 }),
  Object.freeze({ id: 'default', label: 'Default', factor: 1 }),
  Object.freeze({ id: 'larger', label: 'Larger', factor: 1.15 }),
] as const);

export type CodeSize = (typeof CODE_SIZE_OPTIONS)[number]['id'];

export const CODE_LINE_PRESENTATION_OPTIONS = Object.freeze([
  Object.freeze({ id: 'off', label: 'Off' }),
  Object.freeze({ id: 'auto', label: 'Blocks over 5 lines' }),
  Object.freeze({ id: 'always', label: 'Always' }),
] as const);

export type CodeLinePresentation =
  (typeof CODE_LINE_PRESENTATION_OPTIONS)[number]['id'];

export const CODE_SIZE_PREFERENCE = definePreference({
  id: 'conversations.appearance.code-size',
  owner: 'conversations',
  section: 'appearance',
  order: 50,
  scope: 'installation',
  defaultValue: 'default',
  sensitivity: 'public',
  storage: 'device-preferences',
  export: 'portable',
  editor: {
    kind: 'select',
    label: 'Code size',
    description:
      'Scale code inside rendered messages independently from the application text size.',
    testId: 'code-size-select',
    options: CODE_SIZE_OPTIONS.map(({ id, label }) => ({ value: id, label })),
  },
  persistence: {
    key: 'trinity.appearance.code-size',
    legacyKeys: ['trinity.code-scale'],
    migration: closedStringMigration(isCodeSize),
  },
  validate: closedStringValidation(isCodeSize, 'appearance-code-size-invalid'),
} satisfies PreferenceDescriptor<CodeSize>);

export const CODE_LINE_PRESENTATION_PREFERENCE = definePreference({
  id: 'conversations.appearance.code-line-presentation',
  owner: 'conversations',
  section: 'appearance',
  order: 60,
  scope: 'installation',
  defaultValue: 'auto',
  sensitivity: 'public',
  storage: 'device-preferences',
  export: 'portable',
  editor: {
    kind: 'select',
    label: 'Code line numbers',
    description: 'Choose when rendered code blocks show a line-number gutter.',
    testId: 'code-lines-select',
    options: CODE_LINE_PRESENTATION_OPTIONS.map(({ id, label }) => ({
      value: id,
      label,
    })),
  },
  persistence: {
    key: 'trinity.appearance.code-line-presentation',
    legacyKeys: ['trinity.code-lines'],
    migration: closedStringMigration(isCodeLinePresentation),
  },
  validate: closedStringValidation(
    isCodeLinePresentation,
    'appearance-code-line-presentation-invalid',
  ),
} satisfies PreferenceDescriptor<CodeLinePresentation>);

export const CONVERSATION_APPEARANCE_PREFERENCE_DESCRIPTORS: readonly PreferenceDescriptor<PreferenceValue>[] =
  [CODE_SIZE_PREFERENCE, CODE_LINE_PRESENTATION_PREFERENCE];

export const CONVERSATION_APPEARANCE_PREFERENCES = Object.freeze({
  codeSize: CODE_SIZE_PREFERENCE,
  codeLinePresentation: CODE_LINE_PRESENTATION_PREFERENCE,
});

/** Contributes Conversations-owned presentation policy to the preference catalog. */
export function provideConversationAppearancePreferences() {
  return providePreferenceDescriptors(
    () => CONVERSATION_APPEARANCE_PREFERENCE_DESCRIPTORS,
  );
}

function isCodeSize(value: unknown): value is CodeSize {
  return CODE_SIZE_OPTIONS.some(({ id }) => id === value);
}

function isCodeLinePresentation(value: unknown): value is CodeLinePresentation {
  return CODE_LINE_PRESENTATION_OPTIONS.some(({ id }) => id === value);
}

function closedStringValidation<T extends string>(
  accepts: (value: unknown) => value is T,
  diagnosticCode: string,
): (value: unknown) => PreferenceValidation<T> {
  return (value) =>
    accepts(value)
      ? { kind: 'accepted', value }
      : { kind: 'rejected', diagnostic: { code: diagnosticCode } };
}

function closedStringMigration<T extends string>(
  accepts: (value: unknown) => value is T,
) {
  return {
    currentVersion: 1,
    migrate: (stored: StoredPreference): PreferenceValidation<T> => {
      if (
        (stored.version === 0 || stored.version === 1) &&
        accepts(stored.value)
      ) {
        return { kind: 'accepted', value: stored.value };
      }
      return {
        kind: 'rejected',
        diagnostic: { code: 'appearance-preference-migration-rejected' },
      };
    },
  } as const;
}
