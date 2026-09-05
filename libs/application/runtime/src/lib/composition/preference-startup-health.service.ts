import { Injectable, inject } from '@angular/core';
import type { CapabilityRecoveryOutcome } from '@trinity/runtime/projection';
import {
  Observable,
  catchError,
  defaultIfEmpty,
  defer,
  forkJoin,
  map,
  of,
  take,
} from 'rxjs';
import type { ApplicationStartupStageOutcome } from '../application-runtime.models';
import { CapabilityHealthService } from '../capability-health.service';
import {
  PREFERENCE_STARTUP_PRODUCERS,
  PREFERENCE_STARTUP_PRODUCER_POLICIES,
  type PreferencePreparationEvidence,
  type PreferenceStartupProducer,
  type PreferenceStartupSources,
} from './preference-startup.policy';
import { RetainedFirstResult } from './retained-first-result';

interface PreferenceAttemptKey {
  readonly producer: PreferenceStartupProducer;
  readonly ownershipGeneration: number;
}

/** Owns independent preference preparation and projects only value-free scoped health. */
@Injectable({ providedIn: 'root' })
export class PreferenceStartupHealthService {
  private readonly health = inject(CapabilityHealthService);
  private readonly installationContext = Symbol('installation-preferences');
  private readonly active = new Map<
    PreferenceStartupProducer,
    RetainedFirstResult<PreferenceAttemptKey, PreferencePreparationEvidence>
  >();
  private readonly generations = new Map<PreferenceStartupProducer, number>();

  hydrate(
    sources: PreferenceStartupSources,
  ): Observable<ApplicationStartupStageOutcome> {
    return defer(() =>
      forkJoin(
        Object.fromEntries(
          PREFERENCE_STARTUP_PRODUCERS.map((producer) => [
            producer,
            this.observe(producer, sources[producer]),
          ]),
        ) as Record<
          PreferenceStartupProducer,
          Observable<PreferencePreparationEvidence>
        >,
      ).pipe(
        map((results) => {
          const blocked = PREFERENCE_STARTUP_PRODUCERS.find(
            (producer) => results[producer].kind === 'blocked',
          );
          if (blocked) {
            const evidence = results[blocked];
            const code =
              evidence.kind === 'ready'
                ? 'preference-safe-baseline-unavailable'
                : evidence.code;
            return {
              kind: 'blocked',
              recovery: 'reset-preferences',
              diagnostic: { code },
              settlements: [
                {
                  producer: 'preference-hydration',
                  stage: 'preference-hydration',
                  status: 'blocked',
                  diagnostic: { code },
                },
              ],
            } as const;
          }
          const degraded = PREFERENCE_STARTUP_PRODUCERS.some(
            (producer) => results[producer].kind === 'defaulted',
          );
          return {
            kind: 'ready',
            settlements: [
              {
                producer: 'preference-hydration',
                stage: 'preference-hydration',
                status: degraded ? 'degraded' : 'ready',
                ...(degraded
                  ? {
                      diagnostic: {
                        code: 'preference-hydration-degraded',
                      },
                    }
                  : {}),
              },
            ],
          } as const;
        }),
      ),
    );
  }

  private observe(
    producer: PreferenceStartupProducer,
    source: () => Observable<PreferencePreparationEvidence>,
  ): Observable<PreferencePreparationEvidence> {
    let attempt = this.active.get(producer);
    if (
      attempt &&
      attempt.key.ownershipGeneration !== this.health.ownershipGeneration()
    ) {
      attempt.owner.unsubscribe();
      this.active.delete(producer);
      attempt = undefined;
    }
    attempt ??= this.start(producer, source);
    const policy = PREFERENCE_STARTUP_PRODUCER_POLICIES[producer];
    return attempt.observe(policy.budgetMs, () => {
      const evidence = {
        kind: 'defaulted',
        code: policy.timeoutCode,
      } as const;
      this.report(producer, evidence, source);
      return evidence;
    });
  }

  private start(
    producer: PreferenceStartupProducer,
    source: () => Observable<PreferencePreparationEvidence>,
  ): RetainedFirstResult<PreferenceAttemptKey, PreferencePreparationEvidence> {
    const policy = PREFERENCE_STARTUP_PRODUCER_POLICIES[producer];
    const attempt = new RetainedFirstResult<
      PreferenceAttemptKey,
      PreferencePreparationEvidence
    >({
      producer,
      ownershipGeneration: this.health.ownershipGeneration(),
    });
    this.active.set(producer, attempt);
    attempt.start(
      defer(source).pipe(
        take(1),
        defaultIfEmpty({
          kind: 'defaulted',
          code: policy.defaultCode,
        } as const),
        catchError(() =>
          of({
            kind: 'defaulted',
            code: policy.defaultCode,
          } as const),
        ),
      ),
      (evidence, settled) => {
        if (
          this.active.get(producer) !== settled ||
          settled.key.ownershipGeneration !== this.health.ownershipGeneration()
        )
          return;
        this.active.delete(producer);
        this.report(
          producer,
          evidence,
          evidence.kind === 'defaulted' || evidence.kind === 'blocked'
            ? (evidence.recover ?? source)
            : source,
        );
      },
    );
    return attempt;
  }

  private report(
    producer: PreferenceStartupProducer,
    evidence: PreferencePreparationEvidence,
    source: () => Observable<PreferencePreparationEvidence>,
  ): number {
    const generation = (this.generations.get(producer) ?? 0) + 1;
    this.generations.set(producer, generation);
    this.reportGeneration(producer, generation, evidence, source);
    return generation;
  }

  private reportGeneration(
    producer: PreferenceStartupProducer,
    generation: number,
    evidence: PreferencePreparationEvidence,
    source: () => Observable<PreferencePreparationEvidence>,
  ): void {
    const policy = PREFERENCE_STARTUP_PRODUCER_POLICIES[producer];
    const available = evidence.kind === 'ready';
    const blocked = evidence.kind === 'blocked';
    const applicable = evidence.kind !== 'not-applicable';
    this.health.report(
      {
        capability: 'preferences',
        operation: policy.operation,
        context: this.installationContext,
        generation,
        demanded: applicable,
        preparation: blocked ? 'failed' : 'acknowledged',
        ownership:
          applicable && this.active.has(producer) ? 'retained' : 'released',
        condition: available
          ? 'available'
          : blocked
            ? 'blocked'
            : applicable
              ? 'degraded'
              : 'not-applicable',
        code: available ? `${producer}-hydration-ready` : evidence.code,
      },
      () =>
        this.recover(
          producer,
          generation,
          evidence.kind === 'defaulted' || evidence.kind === 'blocked'
            ? (evidence.recover ?? source)
            : source,
        ),
    );
  }

  private recover(
    producer: PreferenceStartupProducer,
    generation: number,
    source: () => Observable<PreferencePreparationEvidence>,
  ): Observable<CapabilityRecoveryOutcome> {
    return defer(() => {
      if (this.generations.get(producer) !== generation) {
        return of({ kind: 'unavailable' } as const);
      }
      const nextGeneration = generation + 1;
      this.generations.set(producer, nextGeneration);
      const policy = PREFERENCE_STARTUP_PRODUCER_POLICIES[producer];
      this.health.report(
        {
          capability: 'preferences',
          operation: policy.operation,
          context: this.installationContext,
          generation: nextGeneration,
          demanded: true,
          preparation: 'pending',
          ownership: 'retained',
          condition: 'recovering',
          code: `${producer}-hydration-retrying`,
        },
        () => this.recover(producer, nextGeneration, source),
      );
      return this.observe(producer, source).pipe(
        map((evidence): CapabilityRecoveryOutcome => ({
          kind:
            evidence.kind === 'ready'
              ? 'success'
              : evidence.kind === 'not-applicable'
                ? 'unavailable'
                : evidence.kind === 'defaulted'
                  ? 'partial'
                  : 'failure',
        })),
      );
    });
  }
}
