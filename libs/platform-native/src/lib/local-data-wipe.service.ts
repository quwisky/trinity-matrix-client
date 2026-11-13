import { Injectable, inject } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { HostUserPresenceService } from '@trinity/runtime/host';
import {
  rustCryptoStoreDbNames,
  syncStoreIndexedDbName,
} from '@trinity/util/matrix';
import { WRAPPING_KEY_DB_NAME } from './crypto-store-wrapping-keys';
import { FileSaveService } from './host-media/file-save.service';
import { RETIRED_DIAGNOSTIC_LOG_DB_NAME } from './retired-diagnostic-log';
import { MENTION_INDEX_DB_NAME } from './mention-index-db-name';
import { firstValueFrom } from 'rxjs';
import { beginDatabaseDeletion, listDatabaseNames } from './indexed-db-wipe';
import { SecureStorageService } from './secure-storage.service';
import { ACCOUNTS_KEY, type AccountRecord } from './session-storage.service';

/** What a wipe managed to do. Reported rather than thrown — see {@link LocalDataWipeService}. */
export interface WipeReport {
  /** Databases still held open by another connection (typically a second tab). */
  readonly blocked: readonly string[];
  /** Databases whose delete request errored. */
  readonly failed: readonly string[];
  /** Whether `indexedDB.databases()` was available, i.e. whether orphans could be found. */
  readonly enumerated: boolean;
}

export interface IndexedDbWipeAttempt {
  readonly observation: Promise<WipeReport>;
  readonly settlement: Promise<WipeReport>;
}

/**
 * Deletes every local storage surface the app writes: IndexedDB (message sync + Rust
 * crypto), Capacitor Preferences, secure storage, raw web storage, the service worker
 * with its caches, and the attachments saved to disk for the native share sheet.
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
  private readonly files = inject(FileSaveService);

  /**
   * Delete every IndexedDB database this app could own: start deletion and retain queued
   * requests after their bounded observation.
   *
   * Runs BEFORE any key/value wipe, and the order is load-bearing: `records` is the only
   * source of these names on a browser without `indexedDB.databases()` (Firefox), so
   * clearing the registry first would leave nothing able to name what survived.
   *
   * It does NOT abort on a partial failure. Deletes are concurrent, so a `blocked` report
   * arrives after the rest are already gone; stopping there would strand the user
   * half-erased.
   */
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
    // The retired diagnostic log's database, if startup could not delete it yet.
    names.add(RETIRED_DIAGNOSTIC_LOG_DB_NAME);
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
   * Sweep secrets the Account registry can no longer name, and the App lock PIN, which
   * lives in its host's verifier rather than in secure storage. A host without a PIN
   * (`unavailable`) has nothing to clear. Both steps run whatever the other reports.
   *
   * Not the primary mechanism: the caller removes each account's keys by name first
   * (covering Electron and web); this reclaims only orphaned native secrets.
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

  /**
   * Whether an erase must not start yet: a desktop whose host has not answered cannot reach
   * its keychain, and an erase without it would delete the stores those secrets open.
   */
  keychainAwaitingHost(): Promise<boolean> {
    return this.secure.awaitingHost();
  }

  /** Whether only the account registry can name the secrets to remove (the desktop keychain). */
  secretsRemovedByNameOnly(): Promise<boolean> {
    return this.secure.removesByNameOnly();
  }

  /** Delete the decrypted attachments left in the native cache for the share sheet. */
  wipeSharedFiles(): Promise<boolean> {
    return attemptAsync(() => this.files.clearShared());
  }

  /**
   * Clear the app-scoped Preferences group.
   *
   * `Preferences.clear()` rather than a key list, deliberately: the app's keys are not
   * uniformly namespaced (`trinity.*`, `matrix.*`, `oidc.*`, `sso.*`, `secure.*`, plus
   * unbounded per-issuer and per-user prefixes), so any enumeration would rot. `clear()`
   * is scoped to the app's own `CapacitorStorage` group on every backend: prefixed
   * localStorage keys on web/Electron, the app-private group file on Android, prefixed
   * `UserDefaults` keys on iOS.
   *
   * `keepRegistry` leaves the account registry entry and nothing else, for an erase that
   * still needs it to name keychain entries.
   */
  wipePreferences(keepRegistry = false): Promise<boolean> {
    return attemptAsync(async () => {
      if (!keepRegistry) return Preferences.clear();
      const { keys } = await Preferences.keys();
      await Promise.all(
        keys
          .filter((key) => key !== ACCOUNTS_KEY)
          .map((key) => Preferences.remove({ key })),
      );
    });
  }

  /**
   * Clear raw local and session storage on every host, not just web: the OIDC callback
   * re-seed writes `sessionStorage` on NATIVE too, and skipping it would leave a PKCE
   * `code_verifier` behind, the one secret in this surface. On web it also catches keys
   * outside `CapacitorStorage`. `keepRegistry` leaves the registry entry, as in
   * {@link wipePreferences}.
   */
  async wipeWebStorage(keepRegistry = false): Promise<boolean> {
    const localStorage = attempt(() => {
      const storage = globalThis.localStorage;
      if (!keepRegistry) return storage?.clear();
      for (const key of Object.keys(storage ?? {})) {
        if (key !== WEB_REGISTRY_KEY) storage?.removeItem(key);
      }
    });
    const sessionStorage = attempt(() => globalThis.sessionStorage?.clear());
    return localStorage && sessionStorage;
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

  /**
   * Unregister every service worker owned by this origin.
   *
   * A corrupt precache can wedge a PWA, so the worker must not stay registered. The cost
   * is accepted: the next load comes from the network, so erasing while offline leaves
   * the app unavailable until connectivity returns.
   *
   * A no-op off web: the worker is only registered in a production browser build.
   */
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

/**
 * The registry entry as Capacitor's web Preferences names it in localStorage. The registry
 * is only ever held back on the desktop keychain, where Preferences is that implementation.
 */
const WEB_REGISTRY_KEY = `CapacitorStorage.${ACCOUNTS_KEY}`;

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
