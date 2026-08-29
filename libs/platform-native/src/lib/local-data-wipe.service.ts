import { Injectable, inject } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import {
  rustCryptoStoreDbNames,
  syncStoreIndexedDbName,
} from '@trinity/util/matrix';
import { deleteDatabase, listDatabaseNames } from './indexed-db-wipe';
import { SecureStorageService } from './secure-storage.service';
import type { AccountRecord } from './session-storage.service';

/** What a wipe managed to do. Reported rather than thrown — see {@link LocalDataWipeService}. */
export interface WipeReport {
  /** Databases still held open by another connection (typically a second tab). */
  readonly blocked: readonly string[];
  /** Databases whose delete request errored. */
  readonly failed: readonly string[];
  /** Whether `indexedDB.databases()` was available, i.e. whether orphans could be found. */
  readonly enumerated: boolean;
}

export interface KeyValueWipeReport {
  readonly secureStorage: boolean;
  readonly preferences: boolean;
  readonly webStorage: boolean;
}

export interface ServiceWorkerWipeReport {
  readonly cacheStorage: boolean;
  readonly registrations: boolean;
}

/**
 * Deletes every local storage surface the app writes: IndexedDB (message sync + Rust
 * crypto), Capacitor Preferences, secure storage, raw web storage, and the service worker
 * with its caches.
 *
 * **Nothing here throws.** Each phase reports whether its approved scopes were cleared, so
 * Account Runtime can finish the reset and still give typed recovery guidance for residue.
 *
 * It deliberately does NOT use matrix-js-sdk's `clearStores()`, whose `onblocked` handler
 * only logs — that promise never settles and the caller hangs. Deletion goes through
 * {@link deleteDatabase}, which is bounded.
 */
@Injectable({ providedIn: 'root' })
export class LocalDataWipeService {
  private readonly secure = inject(SecureStorageService);

  /**
   * Delete every IndexedDB database this app could own.
   *
   * Runs BEFORE any key/value wipe, and the order is load-bearing: `records` is the only
   * source of these names on a browser without `indexedDB.databases()` (Firefox), so
   * clearing the registry first would leave nothing able to name what survived.
   *
   * It does NOT abort on a partial failure — the caller finishes the reset regardless, see
   * Account Runtime's installation-reset workflow. Deletes are concurrent, so a `blocked` report always arrives
   * after the rest are already gone; stopping there would strand the user half-erased.
   */
  async wipeIndexedDb(records: readonly AccountRecord[]): Promise<WipeReport> {
    const idb = globalThis.indexedDB;
    if (typeof idb === 'undefined') {
      return { blocked: [], failed: [], enumerated: false };
    }

    const names = new Set<string>();
    for (const record of records) {
      // The SDK prefixes what it is given, so this is NOT `trinity-sync:<userId>`.
      names.add(syncStoreIndexedDbName(record.userId));
      for (const name of rustCryptoStoreDbNames(record.cryptoPrefix)) {
        names.add(name);
      }
    }
    // A migrated pre-multi-account session sits on the SDK-default prefix, and the crypto
    // spike creates the same pair — neither is named by any record.
    for (const name of rustCryptoStoreDbNames(undefined)) {
      names.add(name);
    }

    // Everything else on this origin. This is a factory reset of our own storage, so an
    // unrecognised database is residue from a version or an account we no longer track —
    // exactly what a registry-derived list cannot reach.
    const enumerated = await listDatabaseNames(idb);
    for (const name of enumerated ?? []) {
      names.add(name);
    }

    // Deletes run concurrently and none of them aborts the others. A caller that treats
    // `blocked` as a reason to stop would therefore be stopping AFTER the rest are already
    // gone — see Account Runtime's reset workflow, which deliberately finishes instead.
    const blocked: string[] = [];
    const failed: string[] = [];
    await Promise.all(
      [...names].map(async (name) => {
        const outcome = await deleteDatabase(idb, name);
        if (outcome === 'blocked') {
          blocked.push(name);
        } else if (outcome === 'failed') {
          failed.push(name);
        }
      }),
    );
    return { blocked, failed, enumerated: enumerated !== null };
  }

  /**
   * Clear Preferences, secure storage and — on web/Electron — raw web storage.
   *
   * `Preferences.clear()` rather than a key list, deliberately. The app's keys are not
   * uniformly namespaced (`trinity.*`, `matrix.*`, `oidc.*`, `sso.*`, `secure.*`, plus
   * unbounded per-issuer and per-user prefixes), so any enumeration would be wrong on the
   * day it was written and would rot afterwards. `clear()` is scoped to the app's own
   * `CapacitorStorage` group on every backend: prefixed localStorage keys on web/Electron,
   * the app-private group file on Android, prefixed `UserDefaults` keys on iOS.
   */
  async wipeKeyValueStores(): Promise<KeyValueWipeReport> {
    // Best-effort bulk sweep where the backend has one (native keychain/keystore). It is
    // NOT the primary mechanism: the caller removes each account's keys by name first,
    // which is what covers Electron and web. This only reclaims secrets orphaned by an
    // earlier bug, whose account is no longer listed and whose key nothing can name.
    const secureStorage = await attemptAsync(() => this.secure.clearAll());
    // Guarded like every other step here. A rejection escaping this method would reject
    // the whole reset, and the caller's subscriber has no error path to catch it — the
    // page would sit on a disabled button with its data already deleted.
    const preferences = await attemptAsync(() => Preferences.clear());

    // Every platform, not just web. `sessionStorage` in particular is written on NATIVE by
    // the OIDC callback re-seed, so skipping it there would leave a PKCE `code_verifier`
    // behind — the one secret in this whole surface. On native the WebView's own storage
    // otherwise holds nothing of ours (Preferences is native), so clearing it costs
    // nothing; on web it catches anything living outside the `CapacitorStorage` namespace.
    const localStorage = attempt(() => globalThis.localStorage?.clear());
    const sessionStorage = attempt(() => globalThis.sessionStorage?.clear());
    return {
      secureStorage,
      preferences,
      webStorage: localStorage && sessionStorage,
    };
  }

  /**
   * Unregister the service worker and delete every cache.
   *
   * A corrupt precache is itself one of the states that wedges a PWA, so leaving the worker
   * registered would leave a possible cause of the problem in place. The cost is real and
   * accepted: the next load comes from the network, so erasing while offline leaves the app
   * unavailable until connectivity returns.
   *
   * A no-op off web — the worker is only registered in a production browser build.
   */
  async wipeServiceWorker(): Promise<ServiceWorkerWipeReport> {
    let cacheStorage = true;
    if (typeof caches !== 'undefined') {
      cacheStorage = await attemptAsync(async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      });
    }
    let registrations = true;
    const serviceWorker = globalThis.navigator?.serviceWorker;
    if (serviceWorker) {
      registrations = await attemptAsync(async () => {
        const registrations = await serviceWorker.getRegistrations();
        await Promise.all(registrations.map((r) => r.unregister()));
      });
    }
    return { cacheStorage, registrations };
  }
}

/** Run a best-effort cleanup step and report whether it completed. */
function attempt(step: () => void): boolean {
  try {
    step();
    return true;
  } catch {
    // A storage-disabled context (Safari with cookies blocked) throws on access alone.
    return false;
  }
}

async function attemptAsync(step: () => Promise<unknown>): Promise<boolean> {
  try {
    await step();
    return true;
  } catch {
    return false;
  }
}
