import { Injectable, inject } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { Observable, defer, from } from 'rxjs';
import {
  MatrixSession,
  isRustCryptoStoreDbName,
  rustCryptoStoreDbNames,
} from '@trinity/util-matrix';
import { SecureStorageService } from './secure-storage.service';

/** Non-secret per-account record (the token lives in {@link SecureStorageService}). */
export type AccountRecord = Omit<MatrixSession, 'accessToken'>;

/** The persisted multi-account registry: the account list + which one is active. */
interface AccountRegistry {
  activeUserId: string | null;
  accounts: AccountRecord[];
}

/** Registry of non-secret account records + the active pointer. */
const ACCOUNTS_KEY = 'matrix.accounts';
/** Per-account access-token key in secure storage: `${TOKEN_KEY_PREFIX}${userId}`. */
const TOKEN_KEY_PREFIX = 'matrix.accessToken:';
/** Legacy single-slot keys (migration source), retired on first read. */
const LEGACY_SESSION_KEY = 'matrix.session';
const LEGACY_TOKEN_KEY = 'matrix.accessToken';

/**
 * Persists signed-in Matrix accounts. Each account's **access token** (the full
 * bearer credential) goes through {@link SecureStorageService} under a per-account
 * key; the non-secret fields (homeserver, user id, device id) live together in a
 * Capacitor Preferences registry that also records which account is active. Never
 * write a token to Preferences/localStorage.
 *
 * Supports multiple accounts (add / list / switch / remove) while staying backward
 * compatible: `save`/`load`/`clear` behave as before for a single account. On first
 * read the legacy single-slot format (`matrix.session` + `matrix.accessToken`) is
 * folded into the registry as the sole active account — one-time and transparent
 * (no re-login).
 *
 * Methods return cold Observables (`defer` so the work runs on subscribe).
 */
@Injectable({ providedIn: 'root' })
export class SessionStorageService {
  private readonly secure = inject(SecureStorageService);

  /**
   * Persist a session and make it the active account (add or replace). Resolves the
   * **stored** session — carrying the crypto-store prefix this account resolved to
   * (a fresh account gets its own; an existing/migrated one keeps its prior one) — so
   * the caller starts the client with the same prefix that was persisted, instead of
   * the SDK default (which would collide with another account's crypto store).
   */
  save(session: MatrixSession): Observable<MatrixSession> {
    return defer(() => from(this.upsert(session)));
  }

  /** Load a session — the active account by default, or a specific `userId`. */
  load(userId?: string): Observable<MatrixSession | null> {
    return defer(() => from(this.loadOne(userId)));
  }

  /** The stored (non-secret) account records, for an account switcher. */
  list(): Observable<AccountRecord[]> {
    return defer(() => from(this.readRegistry().then((r) => r.accounts)));
  }

  /**
   * The stored (non-secret) record for one account, or null. Unlike {@link load} this
   * needs no access token, so it works for a soft-logged-out account whose token was
   * dropped — used to prefill homeserver + device id when re-authenticating it.
   */
  record(userId: string): Observable<AccountRecord | null> {
    return defer(() =>
      from(
        this.readRegistry().then(
          (r) => r.accounts.find((a) => a.userId === userId) ?? null,
        ),
      ),
    );
  }

  /** Make `userId` the active account (no-op if it isn't stored). */
  setActive(userId: string): Observable<void> {
    return defer(() => from(this.setActiveInternal(userId)));
  }

  /** Remove one account (its record + token); repoint active if it was active. */
  remove(userId: string): Observable<void> {
    return defer(() => from(this.removeInternal(userId)));
  }

  /**
   * Drop an account's access token (e.g. a server-side soft-logout revoked it) but KEEP
   * its registry record, so a later re-authentication restores it on the same crypto
   * store. A token-less record is treated as absent by {@link load}, so a restart's
   * restore skips it instead of resurrecting an account whose token no longer works.
   */
  invalidateToken(userId: string): Observable<void> {
    return defer(() => from(this.secure.remove(this.tokenKey(userId))));
  }

  /** Remove every account and token (full sign-out / reset). */
  clear(): Observable<void> {
    return defer(() => from(this.clearInternal()));
  }

  /**
   * Reclaim orphaned Rust crypto stores left on disk that NO signed-in account owns — e.g. a
   * pre-fix sign-out that deleted the wrong store (leaving the account's real one behind), or
   * a re-login whose background cleanup didn't finish. Deletes every `…::matrix-sdk-crypto[-meta]`
   * IndexedDB not owned by a currently-registered account. Meant to run once at startup: a fresh
   * page load holds no connection to a prior session's stores (so `deleteDatabase` won't block),
   * and the keep-set spares every live account's store. Best-effort; a no-op where
   * `indexedDB.databases()` is unavailable (e.g. Firefox) or off-browser.
   */
  sweepOrphanedCryptoStores(): Observable<void> {
    return defer(() => from(this.sweepOrphans()));
  }

  private tokenKey(userId: string): string {
    return TOKEN_KEY_PREFIX + userId;
  }

  private async upsert(session: MatrixSession): Promise<MatrixSession> {
    const { accessToken, ...incoming } = session;
    const registry = await this.readRegistry();
    const existing = registry.accounts.find(
      (a) => a.userId === incoming.userId,
    );
    const deviceChanged = !!existing && existing.deviceId !== incoming.deviceId;
    const record: AccountRecord =
      existing && !deviceChanged
        ? // Same-device re-login (soft-logout re-auth, token rotation): reuse the exact
          // crypto store this account already has — including a migrated legacy
          // account's absent (SDK-default) prefix — so no re-verification is forced.
          { ...existing, baseUrl: incoming.baseUrl }
        : // A brand-new account, OR an existing one whose device changed (a fresh login
          // minted a new device), binds a crypto store scoped to THIS device. Scoping
          // by device id — not user id alone — is what stops a later fresh login from
          // reopening a store an earlier device left behind: reusing the old device's
          // store under a new device makes the Rust OlmMachine reject the mismatch
          // ("the account in the store doesn't match the account in the constructor").
          {
            baseUrl: incoming.baseUrl,
            userId: incoming.userId,
            deviceId: incoming.deviceId,
            cryptoPrefix:
              incoming.cryptoPrefix ??
              `trinity-crypto:${incoming.userId}:${incoming.deviceId}`,
          };
    registry.accounts = [
      ...registry.accounts.filter((a) => a.userId !== incoming.userId),
      record,
    ];
    registry.activeUserId = incoming.userId;
    await this.secure.set(this.tokenKey(incoming.userId), accessToken);
    await this.writeRegistry(registry);
    if (existing && deviceChanged) {
      // The device changed, so `record` above moved this account to a fresh
      // device-scoped crypto store. No logout wiped the old device's store (this is a
      // re-login, not a sign-out), so reclaim it here — otherwise it leaks on disk.
      this.reclaimCryptoStore(existing.cryptoPrefix);
    }
    return { ...record, accessToken };
  }

  /**
   * Best-effort delete of the Rust crypto-store IndexedDB an account left behind after its
   * device changed (see {@link upsert}). Fire-and-forget: the account already opened its
   * fresh store, so this only reclaims disk — and `deleteDatabase` can block on `onblocked`
   * until the old device's OlmMachine connection releases on GC, which is fine since nothing
   * awaits it. A no-op off-browser (unit tests / non-IDB platforms). An undefined prefix is a
   * migrated legacy account on the SDK default store.
   */
  private reclaimCryptoStore(prefix: string | undefined): void {
    const idb = globalThis.indexedDB;
    if (typeof idb === 'undefined') {
      return;
    }
    for (const dbName of rustCryptoStoreDbNames(prefix)) {
      try {
        idb.deleteDatabase(dbName);
      } catch {
        // Best-effort — a blocked/failed delete just leaves the store for a later sweep.
      }
    }
  }

  private async sweepOrphans(): Promise<void> {
    const idb = globalThis.indexedDB;
    if (typeof idb === 'undefined' || typeof idb.databases !== 'function') {
      return;
    }
    const [databases, registry] = await Promise.all([
      idb.databases().catch(() => []),
      this.readRegistry(),
    ]);
    // Every crypto DB a signed-in account legitimately owns (device-scoped stores plus a
    // legacy account's SDK-default store) — never delete these.
    const owned = new Set<string>();
    for (const account of registry.accounts) {
      for (const dbName of rustCryptoStoreDbNames(account.cryptoPrefix)) {
        owned.add(dbName);
      }
    }
    for (const { name } of databases) {
      if (name && !owned.has(name) && isRustCryptoStoreDbName(name)) {
        try {
          idb.deleteDatabase(name);
        } catch {
          // Best-effort — leave anything we can't delete for a later run.
        }
      }
    }
  }

  private async loadOne(userId?: string): Promise<MatrixSession | null> {
    const registry = await this.readRegistry();
    const targetId = userId ?? registry.activeUserId;
    if (!targetId) {
      return null;
    }
    const record = registry.accounts.find((a) => a.userId === targetId);
    if (!record) {
      return null;
    }
    const accessToken = await this.secure.get(this.tokenKey(targetId));
    return accessToken ? { ...record, accessToken } : null;
  }

  private async setActiveInternal(userId: string): Promise<void> {
    const registry = await this.readRegistry();
    if (registry.accounts.some((a) => a.userId === userId)) {
      registry.activeUserId = userId;
      await this.writeRegistry(registry);
    }
  }

  private async removeInternal(userId: string): Promise<void> {
    const registry = await this.readRegistry();
    registry.accounts = registry.accounts.filter((a) => a.userId !== userId);
    if (registry.activeUserId === userId) {
      registry.activeUserId = registry.accounts[0]?.userId ?? null;
    }
    await this.secure.remove(this.tokenKey(userId));
    await this.writeRegistry(registry);
  }

  private async clearInternal(): Promise<void> {
    const registry = await this.readRegistry();
    await Promise.all(
      registry.accounts.map((a) => this.secure.remove(this.tokenKey(a.userId))),
    );
    await Preferences.remove({ key: ACCOUNTS_KEY });
    // Defensively retire any legacy single-slot residue too.
    await Preferences.remove({ key: LEGACY_SESSION_KEY });
    await this.secure.remove(LEGACY_TOKEN_KEY);
  }

  private async writeRegistry(registry: AccountRegistry): Promise<void> {
    await Preferences.set({
      key: ACCOUNTS_KEY,
      value: JSON.stringify(registry),
    });
  }

  /**
   * Read the account registry, migrating a legacy single-slot session on first run.
   * A freshly parsed object is returned each call, so callers may mutate it safely.
   */
  private async readRegistry(): Promise<AccountRegistry> {
    const { value } = await Preferences.get({ key: ACCOUNTS_KEY });
    if (value) {
      return JSON.parse(value) as AccountRegistry;
    }
    return this.migrateLegacy();
  }

  /**
   * Fold the legacy `matrix.session` slot (+ its token, whether in secure storage or,
   * pre-secure-storage, inline in the JSON) into the registry as the sole active
   * account, then retire the legacy keys. Returns an empty registry when there is
   * nothing (or nothing complete) to migrate.
   */
  private async migrateLegacy(): Promise<AccountRegistry> {
    const empty: AccountRegistry = { activeUserId: null, accounts: [] };
    const { value } = await Preferences.get({ key: LEGACY_SESSION_KEY });
    if (!value) {
      return empty;
    }
    const stored = JSON.parse(value) as Partial<MatrixSession>;
    const accessToken =
      (await this.secure.get(LEGACY_TOKEN_KEY)) ?? stored.accessToken ?? null;
    if (!stored.baseUrl || !stored.userId || !stored.deviceId || !accessToken) {
      return empty;
    }
    const record: AccountRecord = {
      baseUrl: stored.baseUrl,
      userId: stored.userId,
      deviceId: stored.deviceId,
    };
    const registry: AccountRegistry = {
      activeUserId: record.userId,
      accounts: [record],
    };
    await this.secure.set(this.tokenKey(record.userId), accessToken);
    await this.secure.remove(LEGACY_TOKEN_KEY);
    await this.writeRegistry(registry);
    await Preferences.remove({ key: LEGACY_SESSION_KEY });
    return registry;
  }
}
