import { Injectable, computed, inject } from '@angular/core';
import {
  INSTALLATION_PREFERENCE_CONTEXT,
  PreferenceStoreService,
  definePreference,
  type PreferenceCommandOutcome,
  type PreferenceDescriptor,
  type PreferenceHydrationOutcome,
  type PreferenceValidation,
  type StoredPreference,
} from '@trinity/runtime/preferences';
import type { Observable } from 'rxjs';

/** The tabs of the composer's expression panel, in the order the panel shows them. */
export const COMPOSER_EXPRESSION_TABS = Object.freeze([
  'gif',
  'sticker',
  'emoji',
] as const);

export type ComposerExpressionTab = (typeof COMPOSER_EXPRESSION_TABS)[number];

function isExpressionTab(value: unknown): value is ComposerExpressionTab {
  return COMPOSER_EXPRESSION_TABS.some((tab) => tab === value);
}

function validateTab(
  value: unknown,
): PreferenceValidation<ComposerExpressionTab> {
  return isExpressionTab(value)
    ? { kind: 'accepted', value }
    : {
        kind: 'rejected',
        diagnostic: { code: 'composer-expression-tab-invalid' },
      };
}

function migrateTab(
  stored: StoredPreference,
): PreferenceValidation<ComposerExpressionTab> {
  return stored.version === 1
    ? validateTab(stored.value)
    : {
        kind: 'rejected',
        diagnostic: { code: 'composer-expression-tab-version-unsupported' },
      };
}

/**
 * The expression panel tab this device used last. Per installation and out of the exported
 * configuration: it describes how this device was last used, not a setting to carry over.
 * Not in the preference catalog, because nothing in Settings edits it.
 */
export const COMPOSER_EXPRESSION_TAB_PREFERENCE = definePreference({
  id: 'conversations.composer.expression-tab',
  owner: 'conversations',
  section: 'composer',
  order: 0,
  scope: 'installation',
  defaultValue: 'emoji',
  sensitivity: 'public',
  storage: 'device-preferences',
  export: 'excluded',
  editor: { kind: 'none' },
  persistence: {
    key: 'trinity.composer.expression-tab',
    migration: { currentVersion: 1, migrate: migrateTab },
  },
  validate: validateTab,
} satisfies PreferenceDescriptor<ComposerExpressionTab>);

/** Read model and commands for the composer's last-used expression tab. */
@Injectable({ providedIn: 'root' })
export class ComposerExpressionTabPreference {
  private readonly preferences = inject(PreferenceStoreService);
  private readonly state = this.preferences.stateFor(
    COMPOSER_EXPRESSION_TAB_PREFERENCE,
    INSTALLATION_PREFERENCE_CONTEXT,
  );

  /** The remembered tab; Emoji until restored or when nothing valid is stored. */
  readonly tab = computed<ComposerExpressionTab>(() => this.state().value);

  /** Read the stored tab. Cold and finite; a failure leaves Emoji in place. */
  restore(): Observable<PreferenceHydrationOutcome> {
    return this.preferences.hydrateDescriptors(
      INSTALLATION_PREFERENCE_CONTEXT,
      [COMPOSER_EXPRESSION_TAB_PREFERENCE],
    );
  }

  /** Store the tab for this device. Cold and finite. */
  remember(tab: ComposerExpressionTab): Observable<PreferenceCommandOutcome> {
    return this.preferences.setPreference(
      COMPOSER_EXPRESSION_TAB_PREFERENCE,
      INSTALLATION_PREFERENCE_CONTEXT,
      tab,
    );
  }
}
