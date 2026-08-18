import { Injectable, effect, inject, signal } from '@angular/core';
import type { MatrixClient } from 'matrix-js-sdk';
import { Observable, forkJoin, map, of } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import type { HomeserverInfo } from './homeserver-info.model';
import {
  fetchCapabilities,
  fetchSpecVersions,
  probeServerSoftware,
} from './probe-homeserver';

/** A cached answer, kept with the client that produced it. */
interface CachedInfo {
  readonly client: MatrixClient;
  readonly info: HomeserverInfo;
}

/**
 * What each signed-in account's homeserver is running — software and version, the URL it is
 * reached at, its spec versions and the capabilities worth showing.
 *
 * **Per account, not per active account.** Every signed-in account has its own live client
 * and they all sync concurrently, and the point of the surface is checking *a* server, which
 * may well not be the one currently in view. So this keys on `accountIds()` and reads each
 * answer through that account's own client, like `AccountProfilesService` and
 * `UnreadAggregatorService` — not through `projectFromClient`, which follows the active one.
 *
 * **Cached for the session, in memory only.** Nothing here is written to Capacitor
 * Preferences: a server version is a fact about right now, and persisting it would let the
 * app confidently show a value from a previous run. {@link refresh} is the deliberate
 * re-check — the motivating use case is noticing that the value *changed*, which a value
 * fetched once at login cannot do.
 *
 * **Nothing here fails.** The probes resolve a null-object instead of throwing (see
 * `probe-homeserver.ts`), so an unreachable server produces a record whose remote fields are
 * null and the UI reads "Unknown". No error reaches a toast, which is a requirement of the
 * feature rather than an accident of the implementation.
 */
@Injectable({ providedIn: 'root' })
export class HomeserverInfoService {
  private readonly matrix = inject(MatrixClientService);

  private readonly cache = new Map<string, CachedInfo>();

  private readonly _infos = signal<ReadonlyMap<string, HomeserverInfo>>(
    new Map(),
  );
  /**
   * Every account that has been probed this session, keyed by user id.
   *
   * An **absent** entry means "not asked yet"; a **present** one whose fields are null means
   * "asked, and the server gave nothing usable". Those are different things to a reader —
   * one is a spinner, the other is "Unknown" — so they are different states here.
   */
  readonly infos = this._infos.asReadonly();

  constructor() {
    // Accounts come and go, and a re-add hands the same user id a NEW client object. Both
    // are read so the effect re-runs on either; `evictStale` then decides what survives.
    effect(() => {
      this.matrix.accountIds();
      this.matrix.activeUserId();
      this.evictStale();
    });
  }

  /** This account's answer, or null when it has not been probed yet. */
  infoFor(userId: string): HomeserverInfo | null {
    return this._infos().get(userId) ?? null;
  }

  /**
   * Probe this account unless a cached answer is already held. Cold — runs on subscribe.
   * This is what a block does when it first renders.
   */
  load(userId: string): Observable<void> {
    return this.cache.has(userId) ? of(undefined) : this.refresh(userId);
  }

  /**
   * Re-probe this account, ignoring anything cached. Cold. Backs "Check again".
   *
   * Always re-issues the requests, which is the whole point: every value here is reachable
   * from an SDK call that would have replayed a cached answer instead (see
   * `probe-homeserver.ts`), and a refresh that cannot observe a change is not a refresh.
   */
  refresh(userId: string): Observable<void> {
    const client = this.matrix.clientFor(userId);
    if (!client) {
      // Signed in but not started yet, or stopped underneath us. Not an error: the account
      // effect re-runs when it appears, and the block simply has nothing to show meanwhile.
      return of(undefined);
    }
    // Trailing slash stripped before it is compared or shown: `AuthService` already
    // normalises what it stores, but `discovered` is a straight string comparison and a
    // stray slash would report every account as delegated.
    const baseUrl = client.baseUrl.replace(/\/+$/, '');
    const serverName = client.getDomain() ?? serverNameOf(userId);
    const token = client.getAccessToken();

    return forkJoin({
      software: probeServerSoftware(baseUrl, serverName),
      versions: fetchSpecVersions(baseUrl, token),
      capabilities: fetchCapabilities(baseUrl, token),
    }).pipe(
      map(({ software, versions, capabilities }) => {
        this.store(userId, client, {
          userId,
          serverName,
          baseUrl,
          discovered: baseUrl !== `https://${serverName}`,
          software,
          specVersions: versions?.versions ?? null,
          unstableFeatures: versions?.unstableFeatures ?? null,
          capabilities,
        });
      }),
    );
  }

  /** Probe every signed-in account that has no answer yet. Cold. */
  loadAll(): Observable<void> {
    const pending = this.matrix
      .accountIds()
      .filter((userId) => !this.cache.has(userId));
    return pending.length
      ? forkJoin(pending.map((userId) => this.refresh(userId))).pipe(
          map(() => undefined),
        )
      : of(undefined);
  }

  /** Re-probe every signed-in account, ignoring the cache. Cold. */
  refreshAll(): Observable<void> {
    const accounts = this.matrix.accountIds();
    return accounts.length
      ? forkJoin(accounts.map((userId) => this.refresh(userId))).pipe(
          map(() => undefined),
        )
      : of(undefined);
  }

  private store(
    userId: string,
    client: MatrixClient,
    info: HomeserverInfo,
  ): void {
    // A probe that finished after its account was removed — or after a re-add replaced the
    // client — must not resurrect an entry, or reinstate one keyed to a client nobody holds.
    if (this.matrix.clientFor(userId) !== client) {
      return;
    }
    this.cache.set(userId, { client, info });
    this.publish();
  }

  /**
   * Drop answers that no longer describe anything: accounts that signed out, and accounts
   * whose user id now maps to a **different client object**.
   *
   * The second case is the one that is easy to miss — re-adding an already signed-in account
   * stops and re-creates its client, against a base URL the user may have just changed. The
   * user id is identical, so a cache keyed on it alone would keep showing the old server's
   * version. Same identity re-check `AccountProfilesService` and `UnreadAggregatorService`
   * both make.
   */
  private evictStale(): void {
    let changed = false;
    for (const [userId, held] of this.cache) {
      if (this.matrix.clientFor(userId) !== held.client) {
        this.cache.delete(userId);
        changed = true;
      }
    }
    if (changed) {
      this.publish();
    }
  }

  private publish(): void {
    const next = new Map<string, HomeserverInfo>();
    for (const [userId, held] of this.cache) {
      next.set(userId, held.info);
    }
    this._infos.set(next);
  }
}

/** `example.org` from `@a:example.org`, for the case the client has no domain to give. */
function serverNameOf(userId: string): string {
  return userId.replace(/^.*?:/, '');
}
