import { Injectable, effect, inject, signal } from '@angular/core';
import {
  Observable,
  defer,
  finalize,
  forkJoin,
  map,
  of,
  shareReplay,
} from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { HOMESERVER_ENGINE } from './homeserver-engine';
import type { HomeserverInfo } from './homeserver-info.model';

/** A cached answer, kept with the session generation that produced it. */
interface CachedInfo {
  readonly generation: number;
  readonly info: HomeserverInfo;
}

/**
 * What each signed-in account's homeserver is running — software and version, the URL it is
 * reached at, its spec versions and the capabilities worth showing.
 *
 * **Per account, not per active account.** Every signed-in account has its own live client
 * and they all sync concurrently, and the point of the surface is checking *a* server, which
 * may not be the one in view. So this keys on `accountIds()` and probes each account by id
 * through the {@link HomeserverEngine}, not through the active one.
 *
 * **Cached for the session, in memory only.** Nothing is written to Capacitor Preferences:
 * a server version is a fact about right now, and persisting it would show a value from a
 * previous run as if current. {@link refresh} is the deliberate re-check.
 *
 * **Nothing here fails.** `HomeserverEngine.probe` never errors; it resolves a record
 * of nulls instead, so an unreachable server produces a record whose remote fields are
 * null and the UI reads "Unknown". No error reaches a toast; the feature requires that.
 */
@Injectable({ providedIn: 'root' })
export class HomeserverInfoService {
  private readonly session = inject(SessionStateService);
  private readonly engine = inject(HOMESERVER_ENGINE);

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
    // Accounts come and go, and a re-add bumps the generation of the same user id; the
    // snapshot changes on both, so `evictStale` decides what survives.
    effect(() => {
      this.session.snapshot();
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
   * A probe is only written to {@link cache} once the engine's probe resolves, so without
   * this every caller arriving meanwhile starts its own: each block loads on init, and the
   * account menu re-triggers a lookup on every toggle. Sharing the in-flight observable also
   * stops an older, slower response landing on top of a newer one. Same shape as
   * `MatrixClientService.starting`.
   */
  private readonly inFlight = new Map<string, Observable<void>>();

  /**
   * Re-probe this account, ignoring anything cached. Cold. Backs "Check again".
   *
   * Always re-issues the requests, which is the whole point: every value here is reachable
   * from an engine call that must not replay a cached answer, and a refresh that cannot observe a change is not a refresh.
   */
  refresh(userId: string): Observable<void> {
    const running = this.inFlight.get(userId);
    if (running) {
      return running;
    }
    // Wholly inside `defer`, so this really is cold as documented: the generation is read
    // on SUBSCRIBE, and the engine reads the client and token then too.
    const request = defer(() => {
      const generation = this.session.status(userId)?.generation;
      if (generation === undefined) {
        // A user id held past sign-out, or one passed in from elsewhere: not an error.
        return of(undefined);
      }
      return this.engine.probe(userId).pipe(
        map((probe) => {
          if (probe) {
            this.store(userId, generation, {
              userId,
              serverName: probe.serverName,
              baseUrl: probe.baseUrl,
              software: probe.software,
              specVersions: probe.specVersions,
              unstableFeatures: probe.unstableFeatures,
              capabilities: probe.capabilities,
              discovered: !sameOrigin(
                probe.baseUrl,
                `https://${probe.serverName}`,
              ),
            });
          }
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
    const pending = this.session
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
    const accounts = this.session.accountIds();
    return accounts.length
      ? forkJoin(accounts.map((userId) => this.refresh(userId))).pipe(
          map(() => undefined),
        )
      : of(undefined);
  }

  private store(
    userId: string,
    generation: number,
    info: HomeserverInfo,
  ): void {
    // A probe that finished after its account was removed — or after a re-add replaced the
    // session — must not resurrect an entry for a session nobody holds.
    if (this.session.status(userId)?.generation !== generation) {
      return;
    }
    this.cache.set(userId, { generation, info });
    this.publish();
  }

  /**
   * Drop answers that no longer describe anything: accounts that signed out, and accounts
   * whose user id now has a **different session generation**.
   *
   * The second case is easy to miss: re-adding an already signed-in account stops and
   * re-creates its client, against a base URL the user may have just changed. The user id is
   * identical, so a cache keyed on it alone would keep showing the old server's version.
   */
  private evictStale(): void {
    let changed = false;
    for (const [userId, held] of this.cache) {
      if (this.session.status(userId)?.generation !== held.generation) {
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
