import { Injectable, Injector, inject, signal } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  EMPTY,
  Observable,
  catchError,
  defer,
  finalize,
  from,
  fromEventPattern,
  ignoreElements,
  map,
  merge,
  of,
  startWith,
  switchMap,
} from 'rxjs';
import {
  TrustCryptoPort,
  type TrustMatrixClient,
} from '@trinity/data-access/matrix-client';
import {
  TRUST_HEALTH_EVENTS,
  type TrustHealthSnapshot,
} from './trust-health.service';
import { readTrustSnapshot } from './trust-snapshot';

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
  private readonly cryptoPort = inject(TrustCryptoPort);
  private readonly _summaries = signal<
    ReadonlyMap<string, AccountTrustSummary>
  >(new Map());

  readonly summaries = this._summaries.asReadonly();

  /** Owned by the Application Runtime session; releases every listener on unsubscribe. */
  run(): Observable<never> {
    return toObservable(this.cryptoPort.liveAccountIds, {
      injector: this.injector,
    }).pipe(
      switchMap((ids) => {
        this.retain(ids);
        return merge(...ids.map((id) => this.watch(id)));
      }),
      ignoreElements(),
      finalize(() => this._summaries.set(new Map())),
    );
  }

  /** Re-read one Account on each of its crypto events; a newer read cancels an older one. */
  private watch(accountId: string): Observable<void> {
    return defer(() => {
      const context = this.cryptoPort.forAccount(accountId);
      if (!context) return EMPTY;
      const { client, crypto } = context;
      return changesOf(client).pipe(
        startWith(undefined),
        switchMap(() =>
          crypto
            ? from(readTrustSnapshot(client, crypto)).pipe(
                catchError(() => of(null)),
              )
            : of(null),
        ),
        map((snapshot) => this.publish(accountId, summarizeTrust(snapshot))),
      );
    });
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

/** Any crypto or account-data change that can move this Account's summary. */
function changesOf(client: TrustMatrixClient): Observable<void> {
  return merge(
    ...TRUST_HEALTH_EVENTS.map((event) =>
      fromEventPattern<unknown>(
        (handler) => client.on(event as never, handler as never),
        (handler) => client.off(event as never, handler as never),
      ),
    ),
  ).pipe(map(() => undefined));
}
