import { Injectable, computed, signal } from '@angular/core';
import type { Observable } from 'rxjs';
import {
  catchError,
  concat,
  defaultIfEmpty,
  defer,
  filter,
  finalize,
  of,
  tap,
  take,
  takeUntil,
  timeout,
  Subject,
} from 'rxjs';
import type {
  CapabilityContext,
  CapabilityHealthFact,
  CapabilityIncident,
  CapabilityRecovery,
  CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import { capabilityStatusCopy } from './capability-status.catalog';

export interface ApplicationCapabilityHealth extends CapabilityHealthFact {
  readonly reference: string;
  readonly occurrence: number;
  readonly severity: 'none' | 'limited' | 'blocking';
}

export interface CapabilityPresentationScope {
  readonly kind: 'account';
  readonly accountId: string;
}

export interface CapabilityRecoveryState {
  readonly reference: string;
  readonly generation: number;
  readonly outcome: CapabilityRecoveryOutcome;
}

export interface CapabilityRecoveryNotice {
  readonly sequence: number;
  readonly fact: ApplicationCapabilityHealth;
}

export type ApplicationCapabilityRecoveryTarget = Pick<
  ApplicationCapabilityHealth,
  'reference' | 'generation'
>;

export interface ApplicationCapabilityDiagnostic {
  readonly reference: string;
  readonly capability: string;
  readonly operation: string;
  readonly code: string;
  readonly condition: ApplicationCapabilityHealth['condition'];
  readonly stage: 'startup' | 'session';
  readonly attempt: number;
  readonly version: string;
  readonly platform: 'web' | 'ios' | 'android' | 'desktop';
}

interface Registration {
  readonly fact: ApplicationCapabilityHealth;
  readonly recovery: CapabilityRecovery;
}

/** Application-owned policy and scope ledger; subscriptions remain session-owned. */
@Injectable({ providedIn: 'root' })
export class CapabilityHealthService {
  private readonly registrations = new Map<
    CapabilityContext,
    Map<string, Registration>
  >();
  private readonly snapshot = signal<readonly ApplicationCapabilityHealth[]>(
    [],
  );
  private readonly recoveringReferences = signal<ReadonlySet<string>>(
    new Set(),
  );
  private readonly presentationScopes = new Map<
    CapabilityContext,
    CapabilityPresentationScope
  >();
  private readonly recoveryState = signal<
    ReadonlyMap<string, CapabilityRecoveryState>
  >(new Map());
  private readonly incidentState = signal<readonly CapabilityIncident[]>([]);
  private readonly recoveryNoticeState =
    signal<CapabilityRecoveryNotice | null>(null);
  private readonly stopped = new Subject<void>();
  private nextReference = 0;
  private nextRecoveryNotice = 0;
  private epoch = 0;

  readonly health = this.snapshot.asReadonly();
  readonly problems = computed(() =>
    this.health().filter((entry) => entry.severity !== 'none'),
  );
  readonly incidents = this.incidentState.asReadonly();
  readonly recoveries = this.recoveryState.asReadonly();
  readonly recoveryNotice = this.recoveryNoticeState.asReadonly();

  /** Session identity for retained producers that must reject publication after reset. */
  ownershipGeneration(): number {
    return this.epoch;
  }

  report(fact: CapabilityHealthFact, recovery: CapabilityRecovery): void {
    const operations =
      this.registrations.get(fact.context) ?? new Map<string, Registration>();
    const key = `${fact.capability}:${fact.operation}`;
    const previous = operations.get(key)?.fact;
    if (previous && fact.generation < previous.generation) return;
    if (
      previous?.condition === 'not-applicable' &&
      fact.generation === previous.generation &&
      fact.condition !== 'not-applicable'
    )
      return;
    const expected =
      !fact.demanded ||
      fact.condition === 'disabled' ||
      fact.condition === 'not-applicable';
    const failed =
      fact.condition === 'degraded' || fact.condition === 'blocked';
    const unresolved =
      !expected &&
      previous?.severity !== undefined &&
      previous.severity !== 'none' &&
      fact.condition !== 'available';
    const condition =
      unresolved && fact.condition === 'waiting-for-precondition'
        ? previous.condition
        : fact.condition;
    const safeDiagnosticReason =
      unresolved && fact.condition === 'waiting-for-precondition'
        ? previous.code
        : capabilityStatusCopy({ ...fact, condition }).safeDiagnosticReason;
    const severity = expected
      ? 'none'
      : failed || unresolved
        ? condition === 'blocked'
          ? 'blocking'
          : 'limited'
        : 'none';
    const reference = previous?.reference ?? `scope-${++this.nextReference}`;
    // Copy explicitly: adapter additions must never leak through health or diagnostics.
    const current: ApplicationCapabilityHealth = {
      capability: fact.capability,
      operation: fact.operation,
      context: fact.context,
      generation: fact.generation,
      demanded: fact.demanded,
      preparation: fact.preparation,
      ownership: fact.ownership,
      condition,
      code: safeDiagnosticReason,
      reference,
      severity,
      occurrence:
        (previous?.occurrence ?? 0) +
        (severity !== 'none' &&
        isNewOrWorse(previous, severity, condition, safeDiagnosticReason)
          ? 1
          : 0),
    };
    this.publishRecoveryNotice(previous, current);
    operations.set(key, { fact: current, recovery });
    this.registrations.set(fact.context, operations);
    this.publish();
  }

  /** Associate opaque health identity with view-only Account presentation. */
  presentForAccount(context: CapabilityContext, accountId: string): void {
    this.presentationScopes.set(context, { kind: 'account', accountId });
  }

  presentationScope(
    target: Pick<ApplicationCapabilityHealth, 'context'>,
  ): CapabilityPresentationScope | null {
    return this.presentationScopes.get(target.context) ?? null;
  }

  incident(incident: CapabilityIncident): void {
    this.incidentState.update((entries) => [
      ...entries.slice(-19),
      {
        context: incident.context,
        capability: incident.capability,
        operation: incident.operation,
        code: incident.code,
      },
    ]);
  }

  recoveryInProgress(target: ApplicationCapabilityRecoveryTarget): boolean {
    return this.recoveringReferences().has(target.reference);
  }

  recover(
    target: ApplicationCapabilityRecoveryTarget,
  ): Observable<CapabilityRecoveryOutcome> {
    return defer(() => {
      const registration = [...this.registrations.values()]
        .flatMap((entries) => [...entries.values()])
        .find(
          ({ fact }) =>
            fact.reference === target.reference &&
            fact.generation === target.generation &&
            fact.demanded &&
            fact.severity !== 'none',
        );
      if (!registration) return of({ kind: 'unavailable' } as const);
      if (this.recoveryInProgress(target))
        return of({ kind: 'transition-in-progress' } as const);
      const epoch = this.epoch;
      this.recoveringReferences.update((references) =>
        new Set(references).add(target.reference),
      );
      this.publishRecovery(target, { kind: 'pending' });
      return concat(
        of({ kind: 'pending' } as const),
        defer(registration.recovery).pipe(
          filter((outcome) => outcome.kind !== 'pending'),
          take(1),
          timeout({
            first: 10_000,
            with: () => of({ kind: 'timeout' } as const),
          }),
          defaultIfEmpty({ kind: 'failure' } as CapabilityRecoveryOutcome),
          catchError(() => of({ kind: 'failure' } as const)),
        ),
      ).pipe(
        tap((outcome) => this.publishRecovery(target, outcome)),
        takeUntil(this.stopped),
        finalize(() => {
          if (epoch !== this.epoch) return;
          this.recoveringReferences.update((references) => {
            const next = new Set(references);
            next.delete(target.reference);
            return next;
          });
        }),
      );
    });
  }

  /** Explicit export boundary: no context identity, producer values or raw exceptions. */
  diagnostics(
    stage: 'startup' | 'session',
    attempt: number,
    version: string,
    platform: 'web' | 'ios' | 'android' | 'desktop',
  ): readonly ApplicationCapabilityDiagnostic[] {
    return this.health().map((entry) => ({
      reference: entry.reference,
      capability: entry.capability,
      operation: entry.operation,
      code: entry.code,
      condition: entry.condition,
      stage,
      attempt,
      version,
      platform,
    }));
  }

  reset(): void {
    this.epoch += 1;
    this.stopped.next();
    this.recoveringReferences.set(new Set());
    this.presentationScopes.clear();
    this.recoveryState.set(new Map());
    this.registrations.clear();
    this.snapshot.set([]);
    this.incidentState.set([]);
    this.recoveryNoticeState.set(null);
  }

  private publish(): void {
    const next = [...this.registrations.values()].flatMap((entries) =>
      [...entries.values()].map(({ fact }) => fact),
    );
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot()))
      this.snapshot.set(next);
  }

  private publishRecovery(
    target: ApplicationCapabilityRecoveryTarget,
    outcome: CapabilityRecoveryOutcome,
  ): void {
    this.recoveryState.update((recoveries) => {
      const next = new Map(recoveries);
      next.set(target.reference, { ...target, outcome });
      return next;
    });
  }

  private publishRecoveryNotice(
    previous: ApplicationCapabilityHealth | undefined,
    current: ApplicationCapabilityHealth,
  ): void {
    if (JSON.stringify(previous) === JSON.stringify(current)) return;
    if (
      previous?.severity !== 'none' &&
      current.severity === 'none' &&
      current.condition === 'available'
    ) {
      this.recoveryNoticeState.set({
        sequence: ++this.nextRecoveryNotice,
        fact: current,
      });
      return;
    }
    if (
      previous?.severity !== current.severity ||
      previous?.condition !== current.condition
    )
      this.recoveryNoticeState.set(null);
  }
}

function isNewOrWorse(
  previous: ApplicationCapabilityHealth | undefined,
  severity: ApplicationCapabilityHealth['severity'],
  condition: ApplicationCapabilityHealth['condition'],
  safeDiagnosticReason: string,
): boolean {
  if (!previous || previous.severity === 'none') return true;
  const rank = { none: 0, limited: 1, blocking: 2 } as const;
  if (rank[severity] > rank[previous.severity]) return true;
  return (
    severity === previous.severity &&
    (condition === 'degraded' || condition === 'blocked') &&
    condition === previous.condition &&
    safeDiagnosticReason !== previous.code
  );
}
