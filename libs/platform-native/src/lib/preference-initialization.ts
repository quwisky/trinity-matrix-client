export type PreferenceFallbackReason =
  'invalid-stored-value' | 'storage-unavailable';

/** Value-free result from a legacy device-preference initializer. */
export type PreferenceInitializationOutcome =
  | { readonly kind: 'ready' }
  | {
      readonly kind: 'defaulted';
      readonly reason: PreferenceFallbackReason;
    };

export interface PreferenceInitializationRead<Value> {
  readonly value: Value;
  readonly outcome: PreferenceInitializationOutcome;
}

export const preferenceInitializationReady = {
  kind: 'ready',
} as const satisfies PreferenceInitializationOutcome;

export function preferenceInitializationDefaulted(
  reason: PreferenceFallbackReason,
): PreferenceInitializationOutcome {
  return { kind: 'defaulted', reason };
}

export function combinePreferenceInitialization(
  outcomes: readonly PreferenceInitializationOutcome[],
): PreferenceInitializationOutcome {
  const storageFailure = outcomes.find(
    (outcome) =>
      outcome.kind === 'defaulted' && outcome.reason === 'storage-unavailable',
  );
  if (storageFailure) return storageFailure;
  return (
    outcomes.find((outcome) => outcome.kind === 'defaulted') ??
    preferenceInitializationReady
  );
}
