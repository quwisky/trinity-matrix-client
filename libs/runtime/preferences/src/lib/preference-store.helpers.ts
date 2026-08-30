import type {
  PreferenceCommandOutcome,
  PreferenceContext,
  PreferenceDescriptor,
  PreferenceDiagnosticCode,
  PreferenceFailure,
  PreferenceHydrationOutcome,
  PreferenceState,
  PreferenceValue,
  StoredPreference,
} from './preference.models';
import type {
  PreferenceStorageRequest,
  PreferenceStorageWriteOutcome,
} from './preference-storage';

export function preferenceStorageRequest(
  descriptor: PreferenceDescriptor<PreferenceValue>,
  context: PreferenceContext,
): PreferenceStorageRequest {
  return {
    key: descriptor.persistence.key,
    context,
    sensitivity: descriptor.sensitivity,
    storage: descriptor.storage,
  };
}

export function preferenceContextKey(context: PreferenceContext): string {
  switch (context.kind) {
    case 'installation':
      return 'installation';
    case 'account':
      return `account:${context.accountId}`;
    case 'conversation':
      return `conversation:${context.accountId}:${context.conversationId}`;
    case 'server-authoritative':
      return `server:${context.accountId}`;
  }
}

export function decodeStoredPreference(payload: string): {
  readonly enveloped: boolean;
  readonly stored: StoredPreference;
} {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'version' in parsed &&
      'value' in parsed &&
      typeof parsed.version === 'number'
    ) {
      return {
        enveloped: true,
        stored: { version: parsed.version, value: parsed.value },
      };
    }
    return { enveloped: false, stored: { version: 0, value: parsed } };
  } catch {
    return { enveloped: false, stored: { version: 0, value: payload } };
  }
}

export function encodeStoredPreference(
  version: number,
  value: PreferenceValue,
): string {
  return JSON.stringify({ version, value });
}

export function preferenceHydrationOutcome(
  results: readonly (PreferenceFailure | null)[],
): PreferenceHydrationOutcome {
  const failures = results.filter(
    (result): result is PreferenceFailure => result !== null,
  );
  const hydrated = results.length - failures.length;
  return failures.length === 0
    ? { kind: 'ready', hydrated }
    : { kind: 'partial', hydrated, failures };
}

export function preferenceScopeFailure(
  preferenceId: string,
): PreferenceFailure {
  return {
    preferenceId,
    recovery: 'select-matching-scope',
    diagnostic: { code: 'preference-scope-mismatch' },
  };
}

export function preferenceStorageFailure(
  preferenceId: string,
  code: PreferenceDiagnosticCode,
): PreferenceFailure {
  return {
    preferenceId,
    recovery: 'retry-storage',
    diagnostic: { code },
  };
}

export function preferenceFailureState(
  value: PreferenceValue,
  failure: PreferenceFailure,
): PreferenceState<PreferenceValue> {
  return {
    kind: 'recoverable-failure',
    value,
    recovery: failure.recovery,
    diagnostic: failure.diagnostic,
  };
}

export function unavailablePreferenceCommand(
  code: PreferenceDiagnosticCode,
): PreferenceCommandOutcome {
  return {
    kind: 'unavailable',
    recovery: 'retry-storage',
    diagnostic: { code },
  };
}

export function rejectedPreferenceCommand(
  code: PreferenceDiagnosticCode,
  recovery: 'fix-value' | 'select-matching-scope',
): PreferenceCommandOutcome {
  return { kind: 'rejected', recovery, diagnostic: { code } };
}

export function preferenceStorageCommandFailure(
  outcome: Exclude<
    PreferenceStorageWriteOutcome,
    { readonly kind: 'completed' }
  >,
): PreferenceCommandOutcome {
  return {
    kind: outcome.kind,
    recovery: 'retry-storage',
    diagnostic: { code: 'preference-storage-write-failed' },
  };
}
