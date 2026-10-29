import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  Observable,
  finalize,
  ignoreElements,
  map,
  merge,
  switchMap,
} from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { plainEqual } from '@trinity/util/matrix';
import type { TrustHealthSnapshot } from './trust-health.service';
import { TRUST_ENGINE } from './trust-engine.token';
import { deriveTrustSnapshot } from './trust-snapshot';

/** How one signed-in Account's device on this installation stands, for Account lists. */
export type AccountTrustSummary =
  'verified' | 'unverified' | 'not-set-up' | 'unknown';

/** Collapse a status read into the four things an Account list can say. */
export function summarizeTrust(
  snapshot: TrustHealthSnapshot | null,
): AccountTrustSummary {
  if (!snapshot) return 'unknown';
  // Cross-signed by its identity: verified, whatever else is missing, including recovery
  // that only the device holding the identity's keys can set up.
  if (snapshot.thisDeviceVerified) return 'verified';
  switch (snapshot.status) {
    case 'ready':
      // Holds the identity and its recovery; nothing here for a mark to warn about.
      return 'verified';
    case 'needs-recovery':
    case 'needs-verification':
      return 'unverified';
    case 'needs-setup':
      return 'not-set-up';
    default: {
      const unhandled: never = snapshot.status;
      void unhandled;
      return 'unknown';
    }
  }
}

/**
 * Trust status for every live Account, not only the active one ({@link TrustHealthService}
 * owns that). Background Accounts sync too, and an unverified one stops receiving room
 * keys from MSC4153 strict senders without anything on screen saying so.
 */
@Injectable({ providedIn: 'root' })
export class TrustAccountStatusService {
  private readonly injector = inject(Injector);
  private readonly session = inject(SessionStateService);
  private readonly engine = inject(TRUST_ENGINE);
  private readonly _summaries = signal<
    ReadonlyMap<string, AccountTrustSummary>
  >(new Map());
  /** Live Accounts with their client generation, so a replaced client is followed. */
  private readonly clients = computed(
    () =>
      this.session.snapshot().accounts.map(({ accountId, generation }) => ({
        accountId,
        generation,
      })),
    { equal: plainEqual },
  );

  readonly summaries = this._summaries.asReadonly();

  /** Owned by the Application Runtime session; releases every subscription on unsubscribe. */
  run(): Observable<never> {
    return toObservable(this.clients, { injector: this.injector }).pipe(
      switchMap((clients) => {
        this.retain(clients.map(({ accountId }) => accountId));
        return merge(...clients.map(({ accountId }) => this.watch(accountId)));
      }),
      ignoreElements(),
      finalize(() => this._summaries.set(new Map())),
    );
  }

  /** One Account's summary after each change; a failed read or no crypto says `unknown`. */
  private watch(accountId: string): Observable<void> {
    return this.engine
      .facts(accountId)
      .pipe(
        map((result) =>
          this.publish(
            accountId,
            summarizeTrust(
              result.ok ? deriveTrustSnapshot(result.value) : null,
            ),
          ),
        ),
      );
  }

  private publish(accountId: string, summary: AccountTrustSummary): void {
    if (this._summaries().get(accountId) === summary) return;
    this._summaries.update((current) =>
      new Map(current).set(accountId, summary),
    );
  }

  /** Drop Accounts that are no longer live. */
  private retain(ids: readonly string[]): void {
    const keep = new Set(ids);
    const current = this._summaries();
    if ([...current.keys()].every((id) => keep.has(id))) return;
    this._summaries.set(new Map([...current].filter(([id]) => keep.has(id))));
  }
}
