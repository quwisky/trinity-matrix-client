import { Injectable, inject } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { HostUserPresenceService } from '@trinity/runtime/host';
import {
  rustCryptoStoreDbNames,
  syncStoreIndexedDbName,
} from '@trinity/util/matrix';
import { WRAPPING_KEY_DB_NAME } from './crypto-store-wrapping-keys';
import { DIAGNOSTIC_LOG_DB_NAME } from './diagnostic-log-db-name';
import { MENTION_INDEX_DB_NAME } from './mention-index-db-name';
import { firstValueFrom } from 'rxjs';
import { beginDatabaseDeletion, listDatabaseNames } from './indexed-db-wipe';
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

export interface IndexedDbWipeAttempt {
  readonly observation: Promise<WipeReport>;
  readonly settlement: Promise<WipeReport>;
}

/**
 * Deletes every local storage surface the app writes: IndexedDB (message sync + Rust
 * crypto), Capacitor Preferences, secure storage, raw web storage, and the service worker
 * with its caches.
 *
 * **Nothing here throws.** Each phase reports whether its scopes were cleared, so the
 * reset can finish and still give recovery guidance for residue.
 *
 * It deliberately does NOT use matrix-js-sdk's `clearStores()`, whose `onblocked` handler
 * only logs and never settles; deletion goes through the bounded {@link deleteDatabase}.
 */
@Injectable({ providedIn: 'root' })
export class LocalDataWipeService {
  private readonly secure = inject(SecureStorageService);
  private readonly presence = inject(HostUserPresenceService);

  /**
   * Delete every IndexedDB database this app could own.
   *
   * Runs BEFORE any key/value wipe, and the order is load-bearing: `records` is the only
   * source of these names on a browser without `indexedDB.databases()` (Firefox), so
   * clearing the registry first would leave nothing able to name what survived.
   *
   * It does NOT abort on a partial failure. Deletes are concurrent, so a `blocked` report
   * arrives after the rest are already gone; stopping there would strand the user
   * half-erased.
   */
  async wipeIndexedDb(records: readonly AccountRecord[]): Promise<WipeReport> {
    return this.beginIndexedDbWipe(records).observation;
  }

  /** Start deletion and retain queued requests after their bounded observation. */
  beginIndexedDbWipe(records: readonly AccountRecord[]): IndexedDbWipeAttempt {
    const started = this.startIndexedDbWipe(records);
    return {
      observation: started.then(async ({ attempts, enumerated }) =>
        this.wipeReport(
          attempts,
          await Promise.all(attempts.map(({ attempt }) => attempt.observation)),
          enumerated,
        ),
      ),
      settlement: started.then(async ({ attempts, enumerated }) =>
        this.wipeReport(
          attempts,
          await Promise.all(attempts.map(({ attempt }) => attempt.settlement)),
          enumerated,
        ),
      ),
    };
  }

  private async startIndexedDbWipe(records: readonly AccountRecord[]) {
    const idb = globalThis.indexedDB;
    if (typeof idb === 'undefined') {
      return { attempts: [], enumerated: false };
    }

    const names = new Set<string>();
    for (const record of records) {
      // The SDK prefixes what it is given, so this is NOT `trinity-sync:<userId>`.
      names.add(syncStoreIndexedDbName(record.userId));
      for (const name of rustCryptoStoreDbNames(record.cryptoPrefix)) {
        names.add(name);
      }
    }
    // A migrated legacy session sits on the SDK-default prefix, named by no record.
    for (const name of rustCryptoStoreDbNames(undefined)) {
      names.add(name);
    }
    // Deleting the web wrapping keys alone already makes any surviving encrypted store
    // unreadable.
    names.add(WRAPPING_KEY_DB_NAME);
    // The on-device diagnostic log keeps the removed accounts' identifiers until export.
    names.add(DIAGNOSTIC_LOG_DB_NAME);
    // The mention index keeps which messages mentioned each removed account.
    names.add(MENTION_INDEX_DB_NAME);

    // Everything else on this origin: an unrecognised database is residue from a version
    // or account we no longer track, which a registry-derived list cannot reach.
    const enumerated = await listDatabaseNames(idb);
    for (const name of enumerated ?? []) {
      names.add(name);
    }

    // Deletes run concurrently and none aborts the others, so stopping on `blocked`
    // would stop AFTER the rest are already gone.
    return {
      attempts: [...names].map((name) => ({
        name,
        attempt: beginDatabaseDeletion(idb, name),
      })),
      enumerated: enumerated !== null,
    };
  }

  private wipeReport(
    attempts: readonly { readonly name: string }[],
    outcomes: readonly ('deleted' | 'blocked' | 'failed')[],
    enumerated: boolean,
  ): WipeReport {
    return {
      blocked: outcomes.flatMap((outcome, index) =>
        outcome === 'blocked' ? [attempts[index].name] : [],
      ),
      failed: outcomes.flatMap((outcome, index) =>
        outcome === 'failed' ? [attempts[index].name] : [],
      ),
      enumerated,
    };
  }

  /**
   * Clear Preferences, secure storage and — on web/Electron — raw web storage.
   *
   * `Preferences.clear()` rather than a key list, deliberately: the app's keys are not
   * uniformly namespaced (`trinity.*`, `matrix.*`, `oidc.*`, `sso.*`, `secure.*`, plus
   * unbounded per-issuer and per-user prefixes), so any enumeration would rot. `clear()`
   * is scoped to the app's own `CapacitorStorage` group on every backend: prefixed
   * localStorage keys on web/Electron, the app-private group file on Android, prefixed
   * `UserDefaults` keys on iOS.
   */
  async wipeKeyValueStores(): Promise<KeyValueWipeReport> {
    // Bulk sweep is not the primary mechanism: the caller removes each account's keys by
    // name first (covering Electron and web); this reclaims only orphaned native secrets.
    const secureStorage = await this.wipeSecureStorage();
    // Guarded like every other step: a rejection here would reject the whole reset, whose
    // subscriber has no error path, leaving a disabled button with the data already gone.
    const preferences = await this.wipePreferences();

    // Every platform, not just web: the OIDC callback re-seed writes `sessionStorage` on
    // NATIVE too, and skipping it would leave a PKCE `code_verifier` behind, the one
    // secret in this surface. On web it also catches keys outside `CapacitorStorage`.
    const webStorage = await this.wipeWebStorage();
    return {
      secureStorage,
      preferences,
      webStorage,
    };
  }

  /**
   * Sweep secrets the Account registry can no longer name, and the App lock PIN, which
   * lives in its host's verifier rather than in secure storage. A host without a PIN
   * (`unavailable`) has nothing to clear. Both steps run whatever the other reports.
   */
  async wipeSecureStorage(): Promise<boolean> {
    const secrets = await attemptAsync(() => this.secure.clearAll());
    // Not attemptAsync: it reports any settled step as success, and a `rejected` outcome
    // must read as a failed wipe.
    let pin: boolean;
    try {
      pin =
        (await firstValueFrom(this.presence.clearPin())).kind !== 'rejected';
    } catch {
      pin = false;
    }
    return secrets && pin;
  }

  /** Clear the app-scoped Preferences group. */
  wipePreferences(): Promise<boolean> {
    return attemptAsync(() => Preferences.clear());
  }

  /** Clear raw local and session storage on every host. */
  async wipeWebStorage(): Promise<boolean> {
    const localStorage = attempt(() => globalThis.localStorage?.clear());
    const sessionStorage = attempt(() => globalThis.sessionStorage?.clear());
    return localStorage && sessionStorage;
  }

  /**
   * Unregister the service worker and delete every cache.
   *
   * A corrupt precache can wedge a PWA, so the worker must not stay registered. The cost
   * is accepted: the next load comes from the network, so erasing while offline leaves
   * the app unavailable until connectivity returns.
   *
   * A no-op off web: the worker is only registered in a production browser build.
   */
  async wipeServiceWorker(): Promise<ServiceWorkerWipeReport> {
    const [cacheStorage, registrations] = await Promise.all([
      this.wipeCacheStorage(),
      this.wipeServiceWorkerRegistrations(),
    ]);
    return { cacheStorage, registrations };
  }

  /** Delete every Cache Storage entry owned by this origin. */
  async wipeCacheStorage(): Promise<boolean> {
    if (typeof caches !== 'undefined') {
      return attemptAsync(async () => {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      });
    }
    return true;
  }

  /** Unregister every service worker owned by this origin. */
  async wipeServiceWorkerRegistrations(): Promise<boolean> {
    const serviceWorker = globalThis.navigator?.serviceWorker;
    if (serviceWorker) {
      return attemptAsync(async () => {
        const registrations = await serviceWorker.getRegistrations();
        await Promise.all(registrations.map((r) => r.unregister()));
      });
    }
    return true;
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
