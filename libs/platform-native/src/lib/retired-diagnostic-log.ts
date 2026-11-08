import { Injectable, inject } from '@angular/core';
import { Observable, catchError, defer, of } from 'rxjs';
import { DevicePreferenceStorageService } from './device-preference-storage.service';
import { beginDatabaseDeletion } from './indexed-db-wipe';

/** The IndexedDB database the retired on-device diagnostic log kept its entries in. */
export const RETIRED_DIAGNOSTIC_LOG_DB_NAME = 'trinity-diagnostic-log';

/** The retired Settings › Advanced › Keep a diagnostic log choice. */
export const RETIRED_DIAGNOSTIC_LOG_KEYS = [
  'trinity.diagnostics.keep-log',
] as const;

/**
 * Deletes what the retired diagnostic log left on this device, once per startup: its
 * database, which may still hold Matrix IDs and room names, and its setting.
 */
@Injectable({ providedIn: 'root' })
export class RetiredDiagnosticLogCleanup {
  private readonly storage = inject(DevicePreferenceStorageService);

  /**
   * Cold and finite. The database delete is started, not awaited: a window of an older build
   * holding it open would otherwise hold startup, and the queued delete finishes once that
   * window closes. A failure is ignored: the next launch tries again.
   */
  run(): Observable<void> {
    return defer(() => {
      if (typeof indexedDB !== 'undefined') {
        beginDatabaseDeletion(indexedDB, RETIRED_DIAGNOSTIC_LOG_DB_NAME);
      }
      return this.storage.removeMany(RETIRED_DIAGNOSTIC_LOG_KEYS);
    }).pipe(catchError(() => of(void 0)));
  }
}
