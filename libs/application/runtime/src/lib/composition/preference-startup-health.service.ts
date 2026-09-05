import { Injectable, inject } from '@angular/core';
import type { CapabilityRecoveryOutcome } from '@trinity/runtime/projection';
import {
  Observable,
  ReplaySubject,
  Subscription,
  catchError,
  defaultIfEmpty,
  defer,
  forkJoin,
  map,
  of,
  race,
  take,
  timer,
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

interface OwnedPreferencePreparation {
  readonly completion: ReplaySubject<PreferencePreparationEvidence>;
  readonly owner: Subscription;
}

/** Owns independent preference preparation and projects only value-free scoped health. */
@Injectable({ providedIn: 'root' })
export class PreferenceStartupHealthService {
  private readonly health = inject(CapabilityHealthService);
  private readonly installationContext = Symbol('installation-preferences');
  private readonly active = new Map<
    PreferenceStartupProducer,
    OwnedPreferencePreparation
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
          for (const producer of PREFERENCE_STARTUP_PRODUCERS) {
            this.report(producer, results[producer], sources[producer]);
          }
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
    const attempt = this.active.get(producer) ?? this.start(producer, source);
    const policy = PREFERENCE_STARTUP_PRODUCER_POLICIES[producer];
    return race(
      attempt.completion,
      timer(policy.budgetMs).pipe(
        map((): PreferencePreparationEvidence => ({
          kind: 'defaulted',
          code: policy.timeoutCode,
        })),
      ),
    ).pipe(take(1));
  }

  private start(
    producer: PreferenceStartupProducer,
    source: () => Observable<PreferencePreparationEvidence>,
  ): OwnedPreferencePreparation {
    const policy = PREFERENCE_STARTUP_PRODUCER_POLICIES[producer];
    const completion = new ReplaySubject<PreferencePreparationEvidence>(1);
    const attempt: OwnedPreferencePreparation = {
      completion,
      owner: new Subscription(),
    };
    this.active.set(producer, attempt);
    attempt.owner.add(
      defer(source)
        .pipe(
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
        )
        .subscribe((evidence) => {
          if (this.active.get(producer) !== attempt) return;
          this.active.delete(producer);
          completion.next(evidence);
          completion.complete();
          attempt.owner.unsubscribe();
        }),
    );
    return attempt;
  }

  private report(
    producer: PreferenceStartupProducer,
    evidence: PreferencePreparationEvidence,
    source: () => Observable<PreferencePreparationEvidence>,
  ): void {
    const generation = (this.generations.get(producer) ?? 0) + 1;
    this.generations.set(producer, generation);
    this.reportGeneration(producer, generation, evidence, source);
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
    this.health.report(
      {
        capability: 'preferences',
        operation: policy.operation,
        context: this.installationContext,
        generation,
        demanded: true,
        preparation: blocked ? 'failed' : 'acknowledged',
        ownership: this.active.has(producer) ? 'retained' : 'released',
        condition: available ? 'available' : blocked ? 'blocked' : 'degraded',
        code: available ? `${producer}-hydration-ready` : evidence.code,
      },
      () =>
        this.recover(
          producer,
          generation,
          evidence.kind === 'ready' ? source : (evidence.recover ?? source),
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
        map((evidence): CapabilityRecoveryOutcome => {
          this.reportGeneration(
            producer,
            nextGeneration,
            evidence,
            evidence.kind === 'ready' ? source : (evidence.recover ?? source),
          );
          return {
            kind:
              evidence.kind === 'ready'
                ? 'success'
                : evidence.kind === 'defaulted'
                  ? 'partial'
                  : 'failure',
          };
        }),
      );
    });
  }
}
