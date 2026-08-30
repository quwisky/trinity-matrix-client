import { Injectable, effect, inject, signal } from '@angular/core';
import type { MatrixClient } from 'matrix-js-sdk';
import {
  Observable,
  defer,
  finalize,
  forkJoin,
  map,
  of,
  shareReplay,
} from 'rxjs';
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
 * answer through that account's own client, like `AccountIdentitiesService` and
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

  /**
   * Probe this account unless a cached answer is already held. Cold — runs on subscribe.
   * This is what a block does when it first renders.
   */
  load(userId: string): Observable<void> {
    return this.cache.has(userId) ? of(undefined) : this.refresh(userId);
  }

  /**
   * Probes that have been started and not yet finished, keyed by user id.
   *
   * A probe is only written to {@link cache} once its whole `forkJoin` settles, so without
   * this every caller that arrives during those seconds starts its own — and #171 reaches
   * exactly that: each block loads on init, and the account menu re-triggers a lookup on
   * every toggle. Sharing the in-flight observable also removes the ordering hazard a
   * second concurrent probe would create, since an older, slower response can no longer
   * land on top of a newer one. Same shape as `MatrixClientService.starting`.
   */
  private readonly inFlight = new Map<string, Observable<void>>();

  /**
   * Re-probe this account, ignoring anything cached. Cold. Backs "Check again".
   *
   * Always re-issues the requests, which is the whole point: every value here is reachable
   * from an SDK call that would have replayed a cached answer instead (see
   * `probe-homeserver.ts`), and a refresh that cannot observe a change is not a refresh.
   */
  refresh(userId: string): Observable<void> {
    const running = this.inFlight.get(userId);
    if (running) {
      return running;
    }
    // Wholly inside `defer`, so this really is cold as documented: the client, its base URL
    // and its access token are read on SUBSCRIBE, not when the observable is built. A token
    // read at build time would be the stale one after an OIDC rotation.
    const request = defer(() => {
      const client = this.matrix.clientFor(userId);
      if (!client) {
        // A user id held past sign-out, or one passed in from elsewhere. Every id in
        // `accountIds()` has a live client, so this is a stale caller rather than an
        // account still warming up — and it is not an error either way.
        return of(undefined);
      }
      // Trailing slash stripped before it is shown: `AuthService` normalises what it
      // stores, but a stray slash would still reach the URL row.
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
            discovered: !sameOrigin(baseUrl, `https://${serverName}`),
            software,
            specVersions: versions?.versions ?? null,
            unstableFeatures: versions?.unstableFeatures ?? null,
            capabilities,
          });
        }),
      );
    }).pipe(
      finalize(() => this.inFlight.delete(userId)),
      // `refCount: false` so a second caller arriving mid-flight joins the same request
      // instead of starting another; the `finalize` above is what stops it being a cache.
      shareReplay({ bufferSize: 1, refCount: false }),
    );
    this.inFlight.set(userId, request);
    return request;
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
   * version. Same identity re-check `AccountIdentitiesService` and `UnreadAggregatorService`
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

/**
 * Whether two URLs address the same origin.
 *
 * Compared as origins rather than as strings so `https://Example.org` and an explicit
 * `https://example.org:443` are not reported as delegation — `URL.origin` lower-cases the
 * host and drops the default port. An unparseable value falls back to inequality, which
 * reports delegation, which is the honest answer when we cannot tell.
 */
function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/** `example.org` from `@a:example.org`, for the case the client has no domain to give. */
function serverNameOf(userId: string): string {
  return userId.replace(/^.*?:/, '');
}
