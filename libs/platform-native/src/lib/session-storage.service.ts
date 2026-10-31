import { Injectable, inject } from '@angular/core';
import { Preferences } from '@capacitor/preferences';
import { PushHandoffBridge } from '@trinity/capacitor-push';
import {
  Observable,
  defer,
  firstValueFrom,
  from,
  map,
  of,
  timeout,
} from 'rxjs';
import {
  MatrixSession,
  type OidcSessionBinding,
  isRustCryptoStoreDbName,
  isSyncStoreDbName,
  rustCryptoStoreDbNames,
  syncStoreIndexedDbName,
  trimTrailing,
} from '@trinity/util/matrix';
import { SecureStorageService } from './secure-storage.service';
import { CryptoStoreKeyService } from './crypto-store-key.service';

/**
 * Non-secret per-account record. Both credentials (access token and OIDC refresh token)
 * live in {@link SecureStorageService}, and on a phone the native token vault holds the
 * OIDC pair too; everything else is kept here.
 */
export type AccountRecord = Omit<MatrixSession, 'accessToken' | 'refreshToken'>;

/** A new-account flow attempted to claim an MXID already owned by local state. */
export class AccountAlreadyStoredError extends Error {
  constructor(readonly userId: string) {
    super(`The account ${userId} is already stored on this device.`);
  }
}

/**
 * A sign-in for an account already saved under another homeserver. The saved account
 * is left as it is; the user must remove it before using a different server.
 */
export class AccountHomeserverMismatchError extends Error {
  constructor(
    readonly userId: string,
    readonly storedBaseUrl: string,
  ) {
    super(`${userId} is already signed in through ${storedBaseUrl}.`);
  }
}

interface AccountRegistry {
  activeUserId: string | null;
  accounts: AccountRecord[];
}

/** Secret-free persisted Account inventory consumed by Account Runtime. */
export interface AccountRegistrySnapshot {
  readonly activeAccountId: string | null;
  readonly accounts: readonly AccountRecord[];
}

export type AccountPersistenceConstraint = 'upsert' | 'new';

/**
 * How long a native vault call may hold the write queue. A call that never answers fails
 * like a refusal, so one stuck plugin cannot hang every sign-in and removal behind it.
 */
const NATIVE_VAULT_TIMEOUT_MS = 5000;

/** Whether a removal leaves the native vault record for a pending provider revocation. */
export interface NativeTokenRetention {
  readonly keepNativeTokens?: boolean;
}

const ACCOUNTS_KEY = 'matrix.accounts';
/** Secure-storage key prefixes; the full key is the prefix plus the user id. */
const TOKEN_KEY_PREFIX = 'matrix.accessToken:';
const REFRESH_TOKEN_KEY_PREFIX = 'matrix.refreshToken:';
/** Legacy single-slot keys (migration source), retired on first read. */
const LEGACY_SESSION_KEY = 'matrix.session';
const LEGACY_TOKEN_KEY = 'matrix.accessToken';
/** Device-scoped crypto-store prefix: `${CRYPTO_PREFIX}${userId}:${deviceId}`. */
const CRYPTO_PREFIX = 'trinity-crypto:';

/**
 * Persists signed-in Matrix accounts. Each account's access token (the full bearer
 * credential) goes through {@link SecureStorageService}; the non-secret fields live in a
 * Capacitor Preferences registry that also records the active account. Never write a
 * token to Preferences/localStorage.
 *
 * On first read the legacy single-slot format (`matrix.session` + `matrix.accessToken`)
 * is folded into the registry as the sole active account, without a re-login.
 * Methods return cold Observables.
 */
@Injectable({ providedIn: 'root' })
export class SessionStorageService {
  private readonly secure = inject(SecureStorageService);
  private readonly storeKeys = inject(CryptoStoreKeyService);
  private readonly handoff = inject(PushHandoffBridge);

  /**
   * Serializes registry read-modify-write cycles. The OIDC token refresher calls
   * {@link updateTokens} concurrently with user-driven `save`/`remove`/`clear`; without
   * this chain, overlapping cycles on the shared `matrix.accounts` blob lose an update
   * (a refresh after a logout would resurrect the signed-out account). Every mutation
   * must run through this chain so each sees the prior one's committed result. Reads
   * stay off the chain: one `Preferences.get` + parse is already a consistent snapshot.
   */
  private writeQueue: Promise<unknown> = Promise.resolve();

  private serialize<T>(op: () => Promise<T>): Promise<T> {
    const result = this.writeQueue.then(op, op);
    // Keep the chain alive whatever this op's outcome; callers still get `result`.
    this.writeQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Persist a session and make it the active account (add or replace). Resolves the
   * stored session, carrying the crypto-store prefix it resolved to, so the caller
   * doesn't fall back to the SDK default (which would collide with another account's
   * crypto store).
   */
  save(session: MatrixSession): Observable<MatrixSession> {
    return defer(() =>
      from(this.serialize(() => this.upsert(session, 'upsert', 'activate'))),
    );
  }

  /**
   * Persist a newly created account only when its MXID is absent from the registry.
   * Check and write share one serialized turn, so registration can't overwrite an
   * existing account's token, device binding or crypto-store prefix.
   */
  saveNew(session: MatrixSession): Observable<MatrixSession> {
    return defer(() =>
      from(this.serialize(() => this.upsert(session, 'new', 'activate'))),
    );
  }

  /**
   * Persist authenticated material without moving the Active Account pointer.
   * Account Runtime commits that pointer only after the live Matrix runtime is ready.
   */
  persistForEstablishment(
    session: MatrixSession,
    constraint: AccountPersistenceConstraint,
  ): Observable<MatrixSession> {
    return defer(() =>
      from(
        this.serialize(() =>
          this.upsert(session, constraint, 'preserve-active'),
        ),
      ),
    );
  }

  /** Commit the Active pointer for a live Account through a typed persistence boundary. */
  setActiveForEstablishment(userId: string): Observable<void> {
    return defer(() =>
      from(this.serialize(() => this.setActiveInternal(userId, true))),
    );
  }

  /** Compensate a failed live activation after Account Runtime persisted its pointer. */
  restoreActiveAfterFailedEstablishment(
    userId: string | null,
  ): Observable<void> {
    return defer(() =>
      from(this.serialize(() => this.setActiveInternal(userId, true))),
    );
  }

  /** Load a session — the active account by default, or a specific `userId`. */
  load(userId?: string): Observable<MatrixSession | null> {
    return defer(() => from(this.loadOne(userId)));
  }

  /** The stored (non-secret) account records, for an account switcher. */
  list(): Observable<AccountRecord[]> {
    return defer(() => from(this.readRegistry().then((r) => r.accounts)));
  }

  /** Read the Account inventory and Active Account pointer in one consistent snapshot. */
  snapshot(): Observable<AccountRegistrySnapshot> {
    return defer(() =>
      from(
        this.readRegistry().then((registry) => ({
          activeAccountId: registry.activeUserId,
          accounts: registry.accounts,
        })),
      ),
    );
  }

  /**
   * The stored (non-secret) record for one account, or null. Unlike {@link load} it
   * needs no access token, so it works for a soft-logged-out account.
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

  /**
   * The device a re-authentication may sign back in on, or null when it must sign in as a
   * new device: a keyed store whose key is missing (a restore onto a new phone, a wiped
   * keychain) can never be opened again, so reusing its device would fail every time.
   * A key that is only unavailable (a locked keyring) keeps the device, so the store is
   * never replaced over an outage; that sign-in fails until the keychain is back.
   */
  reusableDeviceId(record: AccountRecord): Observable<string | null> {
    return defer(() =>
      from(
        this.storeKeyMissing(record).then((missing) =>
          missing ? null : record.deviceId,
        ),
      ),
    );
  }

  /** Make `userId` the active account (no-op if it isn't stored). */
  setActive(userId: string): Observable<void> {
    return defer(() =>
      from(this.serialize(() => this.setActiveInternal(userId))),
    );
  }

  /** Remove one account (its record + token); repoint active if it was active. */
  remove(userId: string, options?: NativeTokenRetention): Observable<void> {
    return defer(() =>
      from(this.serialize(() => this.removeInternal(userId, options))),
    );
  }

  /**
   * Remove a vault record left behind by {@link remove} with `keepNativeTokens`, once its
   * revocation resolved or was given up, and one a replaced device's sign-out has used.
   * A no-op while the account is stored with an OIDC binding: that sign-in owns the record.
   */
  removeNativeTokens(userId: string): Observable<void> {
    return defer(() =>
      from(
        this.serialize(async () => {
          const registry = await this.readRegistry();
          const record = registry.accounts.find((a) => a.userId === userId);
          if (!record?.oidc) {
            await this.nativeVault(this.handoff.removeTokens(userId));
          }
        }),
      ),
    );
  }

  /**
   * Remove every vault record but those of accounts stored with an OIDC binding: what an offline
   * sign-out kept for a retry that never came. In one serialized turn, so a sign-in saved
   * meanwhile is on the list; rejects, removing nothing, when the registry can't be read.
   */
  sweepNativeTokens(): Observable<void> {
    return defer(() =>
      this.handoff.available
        ? from(
            this.serialize(async () => {
              const { accounts } = await this.readRegistry();
              // shortcut: a sweep still running natively past this timeout can remove a sign-in
              // landing on an orphaned id; that needs a hung keychain and ends in a soft logout a
              // new sign-in recovers, so hold new sign-ins back longer if it is ever seen.
              await this.nativeVault(
                this.handoff.removeTokensExcept(
                  accounts.filter((a) => a.oidc).map((a) => a.userId),
                ),
              );
            }),
          )
        : of(void 0),
    );
  }

  /**
   * Drop an account's tokens (e.g. after a soft-logout) but keep its registry record, so
   * a later re-authentication restores it on the same crypto store. {@link load} treats
   * a token-less record as absent, so a restart doesn't resurrect it.
   */
  invalidateToken(userId: string): Observable<void> {
    return defer(() =>
      from(
        this.serialize(async () => {
          // Every removal settles before one failing releases the queue.
          const results = await Promise.allSettled([
            this.secure.remove(this.tokenKey(userId)),
            this.secure.remove(this.refreshTokenKey(userId)),
            this.nativeVault(this.handoff.removeTokens(userId)),
          ]);
          const refused = results.find(
            (result) => result.status === 'rejected',
          );
          if (refused) {
            throw refused.reason;
          }
        }),
      ),
    );
  }

  /**
   * Delete the refresh token copy kept here once native holds it, only while the record
   * still holds `lineage`; a no-op for another sign-in or an account no longer stored.
   */
  dropRefreshToken(
    userId: string,
    lineage: string | undefined,
  ): Observable<void> {
    return defer(() =>
      from(
        this.serialize(async () => {
          const registry = await this.readRegistry();
          const record = registry.accounts.find((a) => a.userId === userId);
          if (
            !record ||
            (record.lineage !== undefined && record.lineage !== lineage)
          ) {
            return;
          }
          await this.secure.remove(this.refreshTokenKey(userId));
        }),
      ),
    );
  }

  /**
   * Persist tokens rotated by the OIDC token refresher for an already-stored account.
   * The existing refresh token stays when the provider returned none.
   *
   * A compare-and-swap on the sign-in: writes only while the record still holds the
   * {@link MatrixSession.lineage} the refreshing client started from, checked in the
   * same serialized turn. A no-op once the account was signed out or signed in again
   * mid-refresh. A record saved before lineages existed matches any refresh. The write
   * never changes the lineage.
   */
  updateTokens(
    userId: string,
    lineage: string | undefined,
    accessToken: string,
    refreshToken?: string,
    accessTokenExpiresAt?: number,
  ): Observable<void> {
    return defer(() =>
      from(
        this.serialize(() =>
          this.updateTokensInternal(
            userId,
            lineage,
            accessToken,
            refreshToken,
            accessTokenExpiresAt,
          ),
        ),
      ),
    );
  }

  /**
   * Record provider endpoints for a stored OAuth account whose binding has none yet.
   * A compare-and-swap on the sign-in like {@link updateTokens}, and on the binding: a
   * no-op once the account was signed out or signed in again, when its endpoints are
   * already pinned, when it would drop a recorded issuer confirmation requirement, or
   * when its issuer or client differs. Never changes the lineage.
   */
  updateOidcBinding(
    userId: string,
    lineage: string | undefined,
    oidc: OidcSessionBinding,
  ): Observable<void> {
    return defer(() =>
      from(
        this.serialize(async () => {
          const registry = await this.readRegistry();
          const record = registry.accounts.find((a) => a.userId === userId);
          if (
            !record?.oidc ||
            (record.lineage !== undefined && record.lineage !== lineage) ||
            record.oidc.tokenEndpoint !== undefined ||
            record.oidc.revocationEndpoint !== undefined ||
            (record.oidc.requiresIssuerConfirmation &&
              !oidc.requiresIssuerConfirmation) ||
            record.oidc.issuer !== oidc.issuer ||
            record.oidc.clientId !== oidc.clientId
          ) {
            return;
          }
          record.oidc = oidc;
          await this.writeRegistry(registry);
        }),
      ),
    );
  }

  /** Remove every stored account and its tokens: the last account's sign-out. */
  clear(options?: NativeTokenRetention): Observable<void> {
    return defer(() =>
      from(this.serialize(() => this.clearInternal('registered', options))),
    ).pipe(map(() => undefined));
  }

  /**
   * Like {@link clear}, but hands back the records it removed.
   *
   * The factory reset needs them: the registry is the only map from account to its secure
   * key names and IndexedDB names, and Electron secure storage cannot be enumerated.
   * Returning them from the same `serialize()` turn keeps the read safe: a token refresh
   * between a separate read and the clear could resurrect an account the wipe had
   * already accounted for.
   */
  clearAll(): Observable<readonly AccountRecord[]> {
    return defer(() =>
      from(this.serialize(() => this.clearInternal('everything'))),
    );
  }

  /**
   * Delete every `…::matrix-sdk-crypto[-meta]` IndexedDB not owned by a registered
   * account. Meant to run once at startup: a fresh page load holds no connection to a
   * prior session's stores, so `deleteDatabase` won't block. Best-effort; a no-op where
   * `indexedDB.databases()` is unavailable (e.g. Firefox) or off-browser.
   */
  sweepOrphanedCryptoStores(): Observable<void> {
    return defer(() => from(this.sweepOrphans()));
  }

  private async nativeVault(call: Observable<unknown>): Promise<void> {
    await firstValueFrom(call.pipe(timeout(NATIVE_VAULT_TIMEOUT_MS)));
  }

  private tokenKey(userId: string): string {
    return TOKEN_KEY_PREFIX + userId;
  }

  private refreshTokenKey(userId: string): string {
    return REFRESH_TOKEN_KEY_PREFIX + userId;
  }

  private async upsert(
    session: MatrixSession,
    constraint: AccountPersistenceConstraint,
    activation: 'activate' | 'preserve-active',
  ): Promise<MatrixSession> {
    const { accessToken, refreshToken, ...incoming } = session;
    const registry = await this.readRegistry();
    const existing = registry.accounts.find(
      (a) => a.userId === incoming.userId,
    );
    if (constraint === 'new' && existing) {
      throw new AccountAlreadyStoredError(incoming.userId);
    }
    if (existing && !sameHomeserver(existing.baseUrl, incoming.baseUrl)) {
      throw new AccountHomeserverMismatchError(
        existing.userId,
        existing.baseUrl,
      );
    }
    const deviceChanged = !!existing && existing.deviceId !== incoming.deviceId;
    // Every save is a new sign-in's tokens: a refresh from an earlier one must not land.
    const lineage = crypto.randomUUID();
    const newPrefix =
      incoming.cryptoPrefix ??
      `${CRYPTO_PREFIX}${incoming.userId}:${incoming.deviceId}`;
    if (
      registry.accounts.some(
        (a) => a.userId !== incoming.userId && a.cryptoPrefix === newPrefix,
      )
    ) {
      throw new Error(
        `The crypto store for ${incoming.userId} already belongs to another account.`,
      );
    }
    const record: AccountRecord =
      existing && !deviceChanged
        ? // Same-device re-login: reuse the exact crypto store (including a migrated
          // legacy account's absent SDK-default prefix) so no re-verification is forced.
          // The incoming session is authoritative for expiry and OIDC binding.
          {
            ...existing,
            accessTokenExpiresAt: incoming.accessTokenExpiresAt,
            oidc: incoming.oidc,
            lineage,
          }
        : // A new account, or one whose device changed, binds a crypto store scoped to THIS
          // device. Reusing an earlier device's store under a new device makes the Rust
          // OlmMachine reject the mismatch ("the account in the store doesn't match the
          // account in the constructor").
          {
            // Keep the saved base URL: an equivalent spelling is no reason to rewrite it.
            baseUrl: existing?.baseUrl ?? incoming.baseUrl,
            userId: incoming.userId,
            deviceId: incoming.deviceId,
            accessTokenExpiresAt: incoming.accessTokenExpiresAt,
            oidc: incoming.oidc,
            cryptoPrefix: newPrefix,
            cryptoStoreKeyed: true,
            lineage,
          };
    registry.accounts = [
      ...registry.accounts.filter((a) => a.userId !== incoming.userId),
      record,
    ];
    if (activation === 'activate') {
      registry.activeUserId = incoming.userId;
    }
    const createsKey = !existing || deviceChanged;
    if (createsKey) {
      // A new store's key is written BEFORE the tokens and the registry: a keyed record
      // without its key could never open its store, and a failure here must leave the
      // stored device's tokens as they were. A same-device re-login keeps whatever its
      // existing store has, including no key at all.
      await this.storeKeys.create(newPrefix);
    }
    try {
      await this.secure.set(this.tokenKey(incoming.userId), accessToken);
      // Remove any stale refresh token when re-logging in without one, so no dead
      // credential lingers.
      if (refreshToken !== undefined) {
        await this.secure.set(
          this.refreshTokenKey(incoming.userId),
          refreshToken,
        );
      } else {
        await this.secure.remove(this.refreshTokenKey(incoming.userId));
        // A new device's sign-in leaves the old record: the replaced device's sign-out
        // still has to revoke it, and removes it afterwards.
        if (existing?.oidc && !deviceChanged) {
          // A refusal leaves a record the next removal of this account or a startup sweep
          // can clear; until then it is unused residue.
          await this.nativeVault(
            this.handoff.removeTokens(incoming.userId),
          ).catch(() => undefined);
        }
      }
      await this.writeRegistry(registry);
    } catch (error) {
      // No record names the new store yet. Its key would make a retry of this same
      // sign-in refuse, since a store key is never replaced.
      if (createsKey) {
        await this.storeKeys.remove(newPrefix).catch(() => undefined);
      }
      throw error;
    }
    if (existing && deviceChanged) {
      // No sign-out wiped the old device's store, so reclaim it here or it leaks on disk.
      this.reclaimCryptoStore(existing.cryptoPrefix);
      await this.removeStoreKey(existing);
    }
    return {
      ...record,
      accessToken,
      ...(refreshToken !== undefined ? { refreshToken } : {}),
    };
  }

  private async updateTokensInternal(
    userId: string,
    lineage: string | undefined,
    accessToken: string,
    refreshToken?: string,
    accessTokenExpiresAt?: number,
  ): Promise<void> {
    const registry = await this.readRegistry();
    const record = registry.accounts.find((a) => a.userId === userId);
    if (!record) {
      return; // signed out mid-refresh — drop the rotated tokens on the floor
    }
    if (record.lineage !== undefined && record.lineage !== lineage) {
      return; // signed in again mid-refresh — these tokens belong to the old sign-in
    }
    await this.secure.set(this.tokenKey(userId), accessToken);
    // Truthiness, not `!== undefined`: a provider that rotated nothing may answer
    // `refresh_token: ''` (which the SDK accepts), and writing that would destroy a
    // still-valid credential no restart could recover.
    if (refreshToken) {
      await this.secure.set(this.refreshTokenKey(userId), refreshToken);
    }
    record.accessTokenExpiresAt = accessTokenExpiresAt;
    await this.writeRegistry(registry);
  }

  /**
   * Best-effort delete of the crypto-store IndexedDB left behind after a device change
   * (see {@link upsert}). Fire-and-forget: `deleteDatabase` can block until the old
   * OlmMachine connection releases on GC, and nothing awaits it. A no-op off-browser.
   * An undefined prefix is a migrated legacy account on the SDK default store.
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
        // Best-effort: a failed delete leaves the store for a later sweep.
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
    // Databases a registered account owns (crypto stores and sync store): never delete.
    const owned = new Set<string>();
    const orphanedStores = new Set<string>();
    for (const account of registry.accounts) {
      for (const dbName of rustCryptoStoreDbNames(account.cryptoPrefix)) {
        owned.add(dbName);
      }
      owned.add(syncStoreIndexedDbName(account.userId));
    }
    for (const { name } of databases) {
      // Sync stores are swept too: the factory reset can leave one behind when a second
      // tab holds it open, and the next cold start has no connection to it yet.
      const orphaned =
        !!name &&
        !owned.has(name) &&
        (isRustCryptoStoreDbName(name) || isSyncStoreDbName(name));
      if (orphaned) {
        try {
          idb.deleteDatabase(name);
        } catch {
          // Best-effort: leave what we can't delete for a later run.
        }
        if (isRustCryptoStoreDbName(name)) {
          orphanedStores.add(name.slice(0, name.lastIndexOf('::')));
        }
      }
    }
    if (orphanedStores.size > 0) {
      await this.serialize(() => this.removeOrphanedStoreKeys(orphanedStores));
    }
  }

  /**
   * Delete the keys of swept stores. Serialized and re-reading the registry, so a
   * sign-in that binds one of these prefixes meanwhile keeps the key it just created.
   */
  private async removeOrphanedStoreKeys(prefixes: Set<string>): Promise<void> {
    const registry = await this.readRegistry();
    for (const prefix of prefixes) {
      if (!registry.accounts.some((a) => a.cryptoPrefix === prefix)) {
        await this.storeKeys.remove(prefix).catch(() => undefined);
      }
    }
  }

  /**
   * Delete a store's key, best-effort. Callers run it AFTER the registry stops naming the
   * store: deleting first, then failing the registry write, would leave a keyed record
   * whose store can never open. A key left behind is harmless residue that the
   * installation reset removes.
   */
  private async removeStoreKey(record: AccountRecord): Promise<void> {
    if (record.cryptoStoreKeyed && record.cryptoPrefix) {
      await this.storeKeys.remove(record.cryptoPrefix).catch(() => undefined);
    }
  }

  /** Whether a keyed store's key is gone for good (not merely unreachable right now). */
  private async storeKeyMissing(record: AccountRecord): Promise<boolean> {
    if (!record.cryptoStoreKeyed || !record.cryptoPrefix) {
      return false;
    }
    const read = await this.storeKeys
      .read(record.cryptoPrefix)
      .catch(() => ({ kind: 'unavailable' }) as const);
    return read.kind === 'missing';
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
    const [accessToken, refreshToken] = await Promise.all([
      this.secure.get(this.tokenKey(targetId)),
      this.secure.get(this.refreshTokenKey(targetId)),
    ]);
    return accessToken
      ? { ...record, accessToken, ...(refreshToken ? { refreshToken } : {}) }
      : null;
  }

  private async setActiveInternal(
    userId: string | null,
    requireStored = false,
  ): Promise<void> {
    const registry = await this.readRegistry();
    if (userId === null) {
      registry.activeUserId = null;
      await this.writeRegistry(registry);
      return;
    }
    if (registry.accounts.some((a) => a.userId === userId)) {
      registry.activeUserId = userId;
      await this.writeRegistry(registry);
    } else if (requireStored) {
      throw new Error(
        `Cannot activate an Account that is not stored: ${userId}`,
      );
    }
  }

  private async removeInternal(
    userId: string,
    options?: NativeTokenRetention,
  ): Promise<void> {
    const registry = await this.readRegistry();
    const removed = registry.accounts.find((a) => a.userId === userId);
    registry.accounts = registry.accounts.filter((a) => a.userId !== userId);
    if (registry.activeUserId === userId) {
      registry.activeUserId = registry.accounts[0]?.userId ?? null;
    }
    await this.secure.remove(this.tokenKey(userId));
    await this.secure.remove(this.refreshTokenKey(userId));
    if (!options?.keepNativeTokens) {
      await this.nativeVault(this.handoff.removeTokens(userId));
    }
    await this.writeRegistry(registry);
    if (removed) {
      await this.removeStoreKey(removed);
    }
  }

  private async clearInternal(
    vault: 'registered' | 'everything',
    options?: NativeTokenRetention,
  ): Promise<readonly AccountRecord[]> {
    const registry = await this.readRegistry();
    const removals: Promise<void>[] = [];
    for (const account of registry.accounts) {
      removals.push(this.secure.remove(this.tokenKey(account.userId)));
      removals.push(this.secure.remove(this.refreshTokenKey(account.userId)));
    }
    await Promise.all(removals);
    if (vault === 'everything') {
      await this.nativeVault(this.handoff.removeAllTokens());
    } else if (!options?.keepNativeTokens) {
      // Only these accounts' records: another account's kept record still awaits its
      // retry's revocation.
      for (const account of registry.accounts) {
        await this.nativeVault(this.handoff.removeTokens(account.userId));
      }
    }
    await Preferences.remove({ key: ACCOUNTS_KEY });
    // Retire any legacy single-slot residue too.
    await Preferences.remove({ key: LEGACY_SESSION_KEY });
    await this.secure.remove(LEGACY_TOKEN_KEY);
    await Promise.all(
      registry.accounts.map((account) => this.removeStoreKey(account)),
    );
    return registry.accounts;
  }

  private async writeRegistry(registry: AccountRegistry): Promise<void> {
    await Preferences.set({
      key: ACCOUNTS_KEY,
      value: JSON.stringify(registry),
    });
  }

  /**
   * Read the registry, migrating a legacy session on first run. Returns a fresh object,
   * so callers may mutate it safely.
   */
  private async readRegistry(): Promise<AccountRegistry> {
    const { value } = await Preferences.get({ key: ACCOUNTS_KEY });
    if (value) {
      return JSON.parse(value) as AccountRegistry;
    }
    return this.migrateLegacy();
  }

  /**
   * Fold the legacy `matrix.session` slot (its token is in secure storage or, in the
   * oldest format, inline in the JSON) into the registry as the sole active account, then
   * retire the legacy keys. Returns an empty registry when there is nothing complete to
   * migrate.
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

/**
 * Whether two homeserver base URLs address the same server: scheme and host case, a
 * default port and trailing slashes do not matter, the path does. An unparseable value
 * only equals an identical one.
 */
export function sameHomeserver(a: string, b: string): boolean {
  const key = (raw: string): string => {
    try {
      const { protocol, host, pathname } = new URL(raw);
      return `${protocol}//${host}${trimTrailing(pathname, '/')}`;
    } catch {
      return raw;
    }
  };
  return key(a) === key(b);
}
