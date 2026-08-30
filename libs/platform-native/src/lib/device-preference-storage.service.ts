import { Injectable } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { Observable, defer, forkJoin, from, map } from 'rxjs';

export interface DevicePreferenceWrite {
  readonly key: string;
  readonly value: string;
}

/**
 * Platform-contained access to the installation's non-secret key/value storage.
 *
 * Capability code depends on this cold RxJS port rather than naming Capacitor. Values
 * remain opaque strings because domain owners are responsible for validation, migration,
 * and defaults; secrets belong in {@link SecureStorageService}, not this adapter.
 */
@Injectable({ providedIn: 'root' })
export class DevicePreferenceStorageService {
  get(key: string): Observable<string | null> {
    return defer(() => from(Preferences.get({ key }))).pipe(
      map(({ value }) => value),
    );
  }

  getMany(keys: readonly string[]): Observable<readonly (string | null)[]> {
    return defer(() =>
      keys.length === 0
        ? from([[] as const])
        : forkJoin(keys.map((key) => this.get(key))),
    );
  }

  set(key: string, value: string): Observable<void> {
    return defer(() => from(Preferences.set({ key, value })));
  }

  setMany(entries: readonly DevicePreferenceWrite[]): Observable<void> {
    return defer(() =>
      entries.length === 0
        ? from([undefined])
        : forkJoin(entries.map(({ key, value }) => this.set(key, value))).pipe(
            map(() => undefined),
          ),
    );
  }

  remove(key: string): Observable<void> {
    return defer(() => from(Preferences.remove({ key })));
  }

  removeMany(keys: readonly string[]): Observable<void> {
    return defer(() =>
      keys.length === 0
        ? from([undefined])
        : forkJoin(keys.map((key) => this.remove(key))).pipe(
            map(() => undefined),
          ),
    );
  }
}
