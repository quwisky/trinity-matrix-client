import { of, switchMap, type Observable } from 'rxjs';
import type {
  PreferenceContext,
  PreferenceDescriptor,
  PreferenceFailure,
  PreferenceState,
  PreferenceValue,
} from './preference.models';
import type {
  PreferenceStorageAdapter,
  PreferenceStorageReadOutcome,
} from './preference-storage';
import {
  decodeStoredPreference,
  encodeStoredPreference,
  preferenceStorageFailure,
  preferenceStorageRequest,
} from './preference-store.helpers';
import {
  readPreferenceStorage,
  writePreferenceStorage,
} from './preference-storage.operations';

export type PreferenceHydrationResult =
  | {
      readonly state: Extract<
        PreferenceState<PreferenceValue>,
        { kind: 'ready' }
      >;
      readonly failure: null;
    }
  | {
      readonly state: Extract<
        PreferenceState<PreferenceValue>,
        { kind: 'recoverable-failure' }
      >;
      readonly failure: PreferenceFailure;
    };

type StoredPreferenceSource = 'current' | 'legacy';

export function hydratePreference(
  adapter: PreferenceStorageAdapter,
  descriptor: PreferenceDescriptor<PreferenceValue>,
  context: PreferenceContext,
): Observable<PreferenceHydrationResult> {
  const currentRequest = preferenceStorageRequest(descriptor, context);
  return readPreferenceStorage(adapter, currentRequest).pipe(
    switchMap((outcome) =>
      outcome.kind === 'missing'
        ? readLegacyPreference(adapter, descriptor, context, 0)
        : applyStoredOutcome(adapter, descriptor, context, outcome, 'current'),
    ),
  );
}

function readLegacyPreference(
  adapter: PreferenceStorageAdapter,
  descriptor: PreferenceDescriptor<PreferenceValue>,
  context: PreferenceContext,
  index: number,
): Observable<PreferenceHydrationResult> {
  const legacyKey = descriptor.persistence.legacyKeys?.[index];
  if (legacyKey === undefined) {
    return of(readyResult(descriptor.defaultValue));
  }
  return readPreferenceStorage(adapter, {
    ...preferenceStorageRequest(descriptor, context),
    key: legacyKey,
  }).pipe(
    switchMap((outcome) =>
      outcome.kind === 'missing'
        ? readLegacyPreference(adapter, descriptor, context, index + 1)
        : applyStoredOutcome(adapter, descriptor, context, outcome, 'legacy'),
    ),
  );
}

function applyStoredOutcome(
  adapter: PreferenceStorageAdapter,
  descriptor: PreferenceDescriptor<PreferenceValue>,
  context: PreferenceContext,
  outcome: Exclude<PreferenceStorageReadOutcome, { readonly kind: 'missing' }>,
  source: StoredPreferenceSource,
): Observable<PreferenceHydrationResult> {
  if (outcome.kind === 'unavailable') {
    return of(
      failureResult(
        descriptor.defaultValue,
        preferenceStorageFailure(
          descriptor.id,
          'preference-storage-read-failed',
        ),
      ),
    );
  }

  const decoded = decodeStoredPreference(outcome.payload);
  let migrated: ReturnType<typeof descriptor.persistence.migration.migrate>;
  try {
    migrated = descriptor.persistence.migration.migrate(decoded.stored);
  } catch {
    return of(migrationFailureResult(descriptor));
  }
  if (migrated.kind === 'rejected') {
    return of(migrationFailureResult(descriptor));
  }

  const needsCurrentWrite =
    source === 'legacy' ||
    !decoded.enveloped ||
    decoded.stored.version !== descriptor.persistence.migration.currentVersion;
  if (!needsCurrentWrite) return of(readyResult(migrated.value));

  return writePreferenceStorage(adapter, {
    ...preferenceStorageRequest(descriptor, context),
    payload: encodeStoredPreference(
      descriptor.persistence.migration.currentVersion,
      migrated.value,
    ),
  }).pipe(
    switchMap((writeOutcome) => {
      if (writeOutcome.kind === 'completed') {
        return of(readyResult(migrated.value));
      }
      const failure = preferenceStorageFailure(
        descriptor.id,
        'preference-storage-write-failed',
      );
      return of(
        failureResult(
          source === 'legacy' ? descriptor.defaultValue : migrated.value,
          failure,
        ),
      );
    }),
  );
}

function readyResult(value: PreferenceValue): PreferenceHydrationResult {
  return { state: { kind: 'ready', value }, failure: null };
}

function migrationFailureResult(
  descriptor: PreferenceDescriptor<PreferenceValue>,
): PreferenceHydrationResult {
  const failure: PreferenceFailure = {
    preferenceId: descriptor.id,
    recovery: 'reset-preference',
    diagnostic: { code: 'preference-migration-rejected' },
  };
  return failureResult(descriptor.defaultValue, failure);
}

function failureResult(
  value: PreferenceValue,
  failure: PreferenceFailure,
): PreferenceHydrationResult {
  return {
    state: {
      kind: 'recoverable-failure',
      value,
      recovery: failure.recovery,
      diagnostic: failure.diagnostic,
    },
    failure,
  };
}
