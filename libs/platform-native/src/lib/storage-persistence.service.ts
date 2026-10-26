import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import {
  type Observable,
  catchError,
  defer,
  from,
  of,
  switchMap,
  timeout,
} from 'rxjs';

const PERSISTENCE_REQUEST_TIMEOUT_MS = 1_000;

/** Storage usage vs quota, in bytes plus a rounded percentage. */
export interface StorageEstimate {
  usageBytes: number;
  quotaBytes: number;
  percentUsed: number;
}

/**
 * Guards the local IndexedDB stores against eviction, which would force an account to
 * re-verify its crypto store. Asks the browser to mark storage persistent (best effort;
 * a no-op where the API is unavailable, e.g. some WebViews) and reports usage.
 */
@Injectable({ providedIn: 'root' })
export class StoragePersistenceService {
  /**
   * Whether this host can ever grant persistent storage. The iOS app's WebKit grants it only
   * to Home Screen web apps, so `persist()` is always refused there and asking is pointless.
   */
  offered(): boolean {
    return Capacitor.getPlatform() !== 'ios';
  }

  /**
   * Ask the browser to make our storage persistent. Idempotent; emits the granted state,
   * or `false` where unavailable or denied.
   */
  requestPersistence(): Observable<boolean> {
    return defer(() => {
      const storage = this.storageManager();
      if (typeof storage?.persist !== 'function') return of(false);

      const persisted =
        typeof storage.persisted === 'function'
          ? from(storage.persisted())
          : of(false);
      return persisted.pipe(
        switchMap((alreadyPersistent) =>
          alreadyPersistent ? of(true) : from(storage.persist()),
        ),
      );
    }).pipe(
      // Firefox may leave the permission request pending forever when it cannot present
      // a prompt; that must not deadlock app startup.
      timeout({
        first: PERSISTENCE_REQUEST_TIMEOUT_MS,
        with: () => of(false),
      }),
      catchError(() => of(false)),
    );
  }

  /** Current storage usage vs quota, or `null` when the estimate API is unavailable. */
  async estimate(): Promise<StorageEstimate | null> {
    const storage = this.storageManager();
    if (typeof storage?.estimate !== 'function') {
      return null;
    }
    try {
      const { usage = 0, quota = 0 } = await storage.estimate();
      return {
        usageBytes: usage,
        quotaBytes: quota,
        percentUsed: quota > 0 ? Math.round((usage / quota) * 100) : 0,
      };
    } catch {
      return null;
    }
  }

  private storageManager(): StorageManager | undefined {
    return typeof navigator !== 'undefined' ? navigator.storage : undefined;
  }
}
