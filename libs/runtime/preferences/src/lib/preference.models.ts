import type { Observable } from 'rxjs';

export type PreferenceValue =
  | string
  | number
  | boolean
  | null
  | readonly PreferenceValue[]
  | { readonly [key: string]: PreferenceValue };

export type PreferenceOwner =
  | 'accounts'
  | 'application-runtime'
  | 'conversations'
  | 'design-system'
  | 'discovery'
  | 'host'
  | 'identity'
  | 'notifications'
  | 'room-administration'
  | 'room-library'
  | 'trust'
  | 'workspace';

export type PreferenceScopeKind =
  'installation' | 'account' | 'conversation' | 'server-authoritative';

export type PreferenceContext =
  | { readonly kind: 'installation' }
  | { readonly kind: 'account'; readonly accountId: string }
  | {
      readonly kind: 'conversation';
      readonly accountId: string;
      readonly conversationId: string;
    }
  | { readonly kind: 'server-authoritative'; readonly accountId: string };

export const INSTALLATION_PREFERENCE_CONTEXT: PreferenceContext = {
  kind: 'installation',
};

export type PreferenceSensitivity = 'public' | 'private' | 'secret';
export type PreferenceStoragePolicy =
  'device-preferences' | 'secure-store' | 'server-authoritative';
export type PreferenceExportPolicy = 'portable' | 'excluded';

/** Adapter/policy input is untrusted and never exposed by the runtime. */
export interface PreferenceSourceDiagnostic {
  readonly code: string;
}

export type PreferenceDiagnosticCode =
  | 'preference-migration-rejected'
  | 'preference-not-registered'
  | 'preference-scope-mismatch'
  | 'preference-storage-read-failed'
  | 'preference-storage-unavailable'
  | 'preference-storage-write-failed'
  | 'preference-validation-rejected';

/** Stable, value-free diagnostics emitted by the preference runtime. */
export interface PreferenceDiagnostic {
  readonly code: PreferenceDiagnosticCode;
}

export type PreferenceValidation<T extends PreferenceValue> =
  | { readonly kind: 'accepted'; readonly value: T }
  | {
      readonly kind: 'rejected';
      readonly diagnostic: PreferenceSourceDiagnostic;
    };

export interface StoredPreference {
  readonly version: number;
  readonly value: unknown;
}

export interface PreferenceMigration<T extends PreferenceValue> {
  readonly currentVersion: number;
  readonly migrate: (stored: StoredPreference) => PreferenceValidation<T>;
}

export type PreferenceVisibility = {
  readonly preferenceId: string;
  readonly equals: PreferenceValue;
};

export type PreferenceEditor = (
  | {
      readonly kind: 'toggle';
      readonly label: string;
      readonly description: string;
      readonly testId: string;
      readonly nested?: boolean;
      readonly warning?: string;
      readonly visibleWhen?: PreferenceVisibility;
    }
  | {
      readonly kind: 'select';
      readonly label: string;
      readonly description: string;
      readonly testId: string;
      readonly options: readonly {
        readonly value: string;
        readonly label: string;
      }[];
    }
  | {
      readonly kind: 'text';
      readonly label: string;
      readonly description: string;
      readonly testId: string;
      readonly secret?: boolean;
    }
  | { readonly kind: 'none' }
) & { readonly visibleWhen?: PreferenceVisibility };

export interface PreferenceDescriptor<T extends PreferenceValue> {
  readonly id: string;
  readonly owner: PreferenceOwner;
  readonly section: string;
  readonly order: number;
  readonly scope: PreferenceScopeKind;
  readonly defaultValue: T;
  readonly sensitivity: PreferenceSensitivity;
  readonly storage: PreferenceStoragePolicy;
  readonly export: PreferenceExportPolicy;
  readonly editor: PreferenceEditor;
  readonly persistence: {
    readonly key: string;
    readonly migration: PreferenceMigration<T>;
  };
  readonly validate: (value: unknown) => PreferenceValidation<T>;
}

export function definePreference<T extends PreferenceValue>(
  descriptor: PreferenceDescriptor<T>,
): PreferenceDescriptor<T> {
  return descriptor;
}

export type PreferenceRecovery =
  'fix-value' | 'reset-preference' | 'retry-storage' | 'select-matching-scope';

export interface PreferenceFailure {
  readonly preferenceId: string;
  readonly recovery: PreferenceRecovery;
  readonly diagnostic: PreferenceDiagnostic;
}

export type PreferenceHydrationOutcome =
  | { readonly kind: 'ready'; readonly hydrated: number }
  | {
      readonly kind: 'partial';
      readonly hydrated: number;
      readonly failures: readonly PreferenceFailure[];
    };

export type PreferenceCommandOutcome =
  | { readonly kind: 'completed' }
  | {
      readonly kind: 'unavailable' | 'rejected';
      readonly recovery: PreferenceRecovery;
      readonly diagnostic: PreferenceDiagnostic;
    };

export type PreferenceState<T extends PreferenceValue> =
  | { readonly kind: 'default'; readonly value: T }
  | { readonly kind: 'ready'; readonly value: T }
  | {
      readonly kind: 'recoverable-failure';
      readonly value: T;
      readonly recovery: PreferenceRecovery;
      readonly diagnostic: PreferenceDiagnostic;
    };

export interface PreferenceCatalogEntry {
  readonly id: string;
  readonly owner: PreferenceOwner;
  readonly section: string;
  readonly order: number;
  readonly scope: PreferenceScopeKind;
  readonly defaultValue: PreferenceValue;
  readonly sensitivity: PreferenceSensitivity;
  readonly storage: PreferenceStoragePolicy;
  readonly export: PreferenceExportPolicy;
  readonly editor: PreferenceEditor;
  readonly state: () => PreferenceState<PreferenceValue>;
  readonly visible: () => boolean;
  readonly set: (value: unknown) => Observable<PreferenceCommandOutcome>;
}
