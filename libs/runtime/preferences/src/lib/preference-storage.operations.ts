import { catchError, defer, of, type Observable } from 'rxjs';
import type {
  PreferenceStorageAdapter,
  PreferenceStorageReadOutcome,
  PreferenceStorageRequest,
  PreferenceStorageWriteOutcome,
} from './preference-storage';

export function readPreferenceStorage(
  adapter: PreferenceStorageAdapter,
  request: PreferenceStorageRequest,
): Observable<PreferenceStorageReadOutcome> {
  return defer(() => adapter.read(request)).pipe(
    catchError(() =>
      of({
        kind: 'unavailable',
        diagnostic: { code: 'preference-storage-read-failed' },
      } as const),
    ),
  );
}

export function writePreferenceStorage(
  adapter: PreferenceStorageAdapter,
  request: PreferenceStorageRequest & { readonly payload: string },
): Observable<PreferenceStorageWriteOutcome> {
  return defer(() => adapter.write(request)).pipe(
    catchError(() =>
      of({
        kind: 'unavailable',
        diagnostic: { code: 'preference-storage-write-failed' },
      } as const),
    ),
  );
}
