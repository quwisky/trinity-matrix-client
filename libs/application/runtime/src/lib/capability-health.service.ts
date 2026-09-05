import type {
  IdentityPresenceHealth,
  IdentityPresenceIncident,
} from '@trinity/data-access/identity';
import { Injectable, computed, signal } from '@angular/core';
import {
  catchError,
  concat,
  defaultIfEmpty,
  defer,
  filter,
  finalize,
  of,
  take,
  takeUntil,
  timeout,
  Subject,
} from 'rxjs';
import type {
  CapabilityContext,
  CapabilityRecovery,
  CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';

export interface ApplicationCapabilityHealth extends IdentityPresenceHealth {
  readonly reference: string;
  readonly occurrence: number;
  readonly severity: 'none' | 'limited' | 'blocking';
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
  private readonly pending = signal(false);
  private readonly stopped = new Subject<void>();
  private nextReference = 0;
  private epoch = 0;

  readonly health = this.snapshot.asReadonly();
  readonly recovering = this.pending.asReadonly();
  readonly problems = computed(() =>
    this.health().filter((entry) => entry.severity !== 'none'),
  );
  private readonly incidentState = signal<readonly IdentityPresenceIncident[]>(
    [],
  );
  readonly incidents = this.incidentState.asReadonly();

  report(fact: IdentityPresenceHealth, recovery: CapabilityRecovery): void {
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
    const severity = expected
      ? 'none'
      : failed || unresolved
        ? 'limited'
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
      code:
        unresolved && fact.condition === 'waiting-for-precondition'
          ? previous.code
          : fact.code,
      reference,
      severity,
      occurrence:
        (previous?.occurrence ?? 0) +
        (severity !== 'none' && previous?.severity !== 'limited' ? 1 : 0),
    };
    operations.set(key, { fact: current, recovery });
    this.registrations.set(fact.context, operations);
    this.publish();
  }

  incident(incident: IdentityPresenceIncident): void {
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

  recover(reference: string, generation: number) {
    return defer(() => {
      if (this.pending())
        return of({ kind: 'transition-in-progress' } as const);
      const registration = [...this.registrations.values()]
        .flatMap((entries) => [...entries.values()])
        .find(
          ({ fact }) =>
            fact.reference === reference &&
            fact.generation === generation &&
            fact.demanded &&
            fact.severity !== 'none',
        );
      if (!registration) return of({ kind: 'unavailable' } as const);
      const epoch = this.epoch;
      this.pending.set(true);
      return concat(
        of({ kind: 'pending' } as const),
        defer(registration.recovery).pipe(
          filter((outcome) => outcome.kind !== 'pending'),
          take(1),
          timeout(10_000),
          defaultIfEmpty({ kind: 'failure' } as CapabilityRecoveryOutcome),
          catchError(() => of({ kind: 'failure' } as const)),
        ),
      ).pipe(
        takeUntil(this.stopped),
        finalize(() => {
          if (epoch === this.epoch) this.pending.set(false);
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
  ) {
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
    this.pending.set(false);
    this.registrations.clear();
    this.snapshot.set([]);
    this.incidentState.set([]);
  }

  private publish(): void {
    const next = [...this.registrations.values()].flatMap((entries) =>
      [...entries.values()].map(({ fact }) => fact),
    );
    if (JSON.stringify(next) !== JSON.stringify(this.snapshot()))
      this.snapshot.set(next);
  }
}
