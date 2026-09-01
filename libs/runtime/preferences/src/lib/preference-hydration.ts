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
  preferenceFailureState,
  preferenceStorageFailure,
  preferenceStorageRequest,
} from './preference-store.helpers';
import {
  readPreferenceStorage,
  writePreferenceStorage,
} from './preference-storage.operations';

export interface PreferenceHydrationResult {
  readonly state: PreferenceState<PreferenceValue>;
  readonly failure: PreferenceFailure | null;
}

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
        : applyStoredOutcome(adapter, descriptor, context, outcome, false),
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
        : applyStoredOutcome(adapter, descriptor, context, outcome, true),
    ),
  );
}

function applyStoredOutcome(
  adapter: PreferenceStorageAdapter,
  descriptor: PreferenceDescriptor<PreferenceValue>,
  context: PreferenceContext,
  outcome: Exclude<PreferenceStorageReadOutcome, { readonly kind: 'missing' }>,
  fromLegacyKey: boolean,
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
    fromLegacyKey ||
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
          fromLegacyKey ? descriptor.defaultValue : migrated.value,
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
  return { state: preferenceFailureState(value, failure), failure };
}
