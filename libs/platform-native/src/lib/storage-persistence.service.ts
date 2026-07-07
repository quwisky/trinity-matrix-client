import { Injectable } from '@angular/core';

/** Storage usage vs quota, in bytes plus a rounded percentage. */
export interface StorageEstimate {
  usageBytes: number;
  quotaBytes: number;
  percentUsed: number;
}

/**
 * Guards the local IndexedDB stores against eviction. Several signed-in accounts
 * each keep their own sync + Rust-crypto databases, so total on-device storage grows
 * with every account — and an evicted crypto store would force that account to
 * re-verify. This asks the browser to mark Trinity's storage **persistent** (best
 * effort; a no-op where the API is unavailable, e.g. some WebViews) and reports usage
 * so the app can surface storage pressure.
 */
@Injectable({ providedIn: 'root' })
export class StoragePersistenceService {
  /**
   * Ask the browser to make our storage persistent so it isn't evicted under pressure.
   * Idempotent — resolves the granted state, or `false` where unavailable / denied.
   * The browser decides whether to prompt (never re-asks once persisted).
   */
  async requestPersistence(): Promise<boolean> {
    const storage = this.storageManager();
    if (typeof storage?.persist !== 'function') {
      return false;
    }
    try {
      if (
        typeof storage.persisted === 'function' &&
        (await storage.persisted())
      ) {
        return true; // already persistent — don't re-ask
      }
      return await storage.persist();
    } catch {
      return false;
    }
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
