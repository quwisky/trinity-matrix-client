import { Injectable, inject } from '@angular/core';
import {
  SpaceRoomOrderService,
  type RoomOrderHydrationOutcome,
  type RoomOrderHydrationSettlement,
  type RoomOrderRuntimeEvent,
} from '@trinity/data-access/room-library';
import type {
  CapabilityContext,
  CapabilityHealthFact,
  CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import { Observable, catchError, defaultIfEmpty, defer, map, of } from 'rxjs';
import { APPLICATION_STARTUP_PRODUCER_POLICIES } from '../application-startup.policy';
import { CapabilityHealthService } from '../capability-health.service';
import { RetainedFirstResult } from './retained-first-result';

interface RoomOrderAttemptKey {
  readonly operation: 'room-order';
  readonly ownershipGeneration: number;
}

/** Keeps per-Account ordering identity private while making each failed scope recoverable. */
@Injectable({ providedIn: 'root' })
export class RoomOrderHealthService {
  private readonly order = inject(SpaceRoomOrderService);
  private readonly health = inject(CapabilityHealthService);
  private readonly contexts = new Map<string, CapabilityContext>();
  private readonly generations = new Map<string, number>();
  private demanded = new Set<string>();
  private active: RetainedFirstResult<
    RoomOrderAttemptKey,
    RoomOrderHydrationOutcome
  > | null = null;

  hydrate(): Observable<RoomOrderHydrationOutcome> {
    return defer(() => {
      if (
        this.active &&
        this.active.key.ownershipGeneration !==
          this.health.ownershipGeneration()
      ) {
        this.active.owner.unsubscribe();
        this.active = null;
      }
      const attempt = this.active ?? this.start();
      const policy = APPLICATION_STARTUP_PRODUCER_POLICIES['room-order'];
      return attempt.observe(policy.budgetMs, () => {
        const accounts = this.defaultedAccounts();
        this.reportBatch(accounts, policy.timeoutCode);
        return { kind: 'partial', accounts } as const;
      });
    });
  }

  reportRuntime(event: RoomOrderRuntimeEvent): void {
    this.reportBatch(event.accounts);
  }

  private start(): RetainedFirstResult<
    RoomOrderAttemptKey,
    RoomOrderHydrationOutcome
  > {
    const attempt = new RetainedFirstResult<
      RoomOrderAttemptKey,
      RoomOrderHydrationOutcome
    >({
      operation: 'room-order',
      ownershipGeneration: this.health.ownershipGeneration(),
    });
    this.active = attempt;
    const unavailable = (): RoomOrderHydrationOutcome => ({
      kind: 'partial',
      accounts: this.defaultedAccounts(),
    });
    attempt.start(
      this.order.hydrateKnownAccounts().pipe(
        defaultIfEmpty(unavailable()),
        catchError(() => of(unavailable())),
      ),
      (outcome, settled) => {
        if (
          this.active !== settled ||
          settled.key.ownershipGeneration !== this.health.ownershipGeneration()
        )
          return;
        this.reportBatch(outcome.accounts);
        this.active = null;
      },
    );
    return attempt;
  }

  private defaultedAccounts(): readonly RoomOrderHydrationSettlement[] {
    return this.order
      .knownAccountIds()
      .map((accountId): RoomOrderHydrationSettlement => ({
        accountId,
        kind: 'defaulted',
        diagnostic: { code: 'room-order-storage-unavailable' },
      }));
  }

  private reportBatch(
    accounts: readonly RoomOrderHydrationSettlement[],
    overrideCode?: string,
  ): void {
    const next = new Set(accounts.map((account) => account.accountId));
    for (const accountId of this.demanded) {
      if (!next.has(accountId)) {
        this.reportOne({ accountId, kind: 'not-applicable' });
      }
    }
    this.demanded = next;
    for (const account of accounts) this.reportOne(account, overrideCode);
  }

  private reportOne(
    settlement: RoomOrderHydrationSettlement,
    overrideCode?: string,
  ): void {
    const accountId = settlement.accountId;
    const context = this.contexts.get(accountId) ?? Symbol('room-order-health');
    this.contexts.set(accountId, context);
    const generation = (this.generations.get(accountId) ?? 0) + 1;
    this.generations.set(accountId, generation);
    const ready = settlement.kind === 'ready';
    const applicable = settlement.kind !== 'not-applicable';
    const fact = {
      capability: 'room-library',
      operation: 'hydrate-order',
      context,
      generation,
      demanded: applicable,
      preparation: ready ? 'acknowledged' : 'failed',
      ownership:
        applicable && this.active
          ? ('retained' as const)
          : ('released' as const),
      condition: ready
        ? ('available' as const)
        : applicable
          ? ('degraded' as const)
          : ('not-applicable' as const),
      code: ready
        ? 'room-order-hydration-ready'
        : applicable
          ? (overrideCode ?? settlement.diagnostic.code)
          : 'room-order-account-removed',
    } satisfies CapabilityHealthFact;
    this.health.report(fact, () => this.recover(accountId, generation));
  }

  private recover(
    accountId: string,
    generation: number,
  ): Observable<CapabilityRecoveryOutcome> {
    return defer(() => {
      if (this.generations.get(accountId) !== generation) {
        return of({ kind: 'unavailable' } as const);
      }
      return this.order.retryHydration(accountId).pipe(
        map((settlement): CapabilityRecoveryOutcome => {
          this.reportOne(settlement);
          return settlement.kind === 'ready'
            ? { kind: 'success' }
            : settlement.kind === 'not-applicable'
              ? { kind: 'unavailable' }
              : { kind: 'partial' };
        }),
        catchError(() => of({ kind: 'failure' } as const)),
      );
    });
  }
}
