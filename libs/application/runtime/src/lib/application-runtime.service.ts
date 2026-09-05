import { Injectable, inject, signal } from '@angular/core';
import {
  EMPTY,
  Observable,
  ReplaySubject,
  Subject,
  concat,
  connect,
  catchError,
  timeout,
  defer,
  defaultIfEmpty,
  finalize,
  ignoreElements,
  map,
  merge,
  of,
  switchMap,
  take,
  takeUntil,
  tap,
  throwError,
} from 'rxjs';
import { CapabilityHealthService } from './capability-health.service';
import { APPLICATION_RUNTIME_ADAPTER } from './application-runtime.adapter';
import { APPLICATION_STARTUP_WATCHDOG_BUDGET_MS } from './application-startup.policy';
import {
  recoveryStartIndex,
  settlementsBefore,
  stageSettlements,
  warningsBefore,
  withDependencySkips,
} from './application-startup-settlements';
import { ApplicationSessionStartupWorkflow } from './application-session-startup.workflow';
import { startupFailureOutcome } from './application-startup-failure';
import { ApplicationStartupStageWorkflow } from './application-startup-stage.workflow';
import {
  APPLICATION_STARTUP_STAGES,
  type ApplicationRecoveryOutcome,
  type ApplicationRuntimeState,
  type ApplicationRuntimeWarning,
  type ApplicationStartOutcome,
  type ApplicationStartupStage,
  type ApplicationStartupStageOutcome,
  type ApplicationStartupProducerSettlement,
  type ApplicationStopOutcome,
} from './application-runtime.models';

export class ApplicationRuntimeAlreadyRunningError extends Error {
  constructor() {
    super('Application Runtime already has an active owner.');
  }
}

@Injectable({ providedIn: 'root' })
export class ApplicationRuntimeService {
  private readonly adapter = inject(APPLICATION_RUNTIME_ADAPTER);
  private readonly health = inject(CapabilityHealthService);
  private readonly sessionStartup = inject(ApplicationSessionStartupWorkflow);
  private readonly stageWorkflow = inject(ApplicationStartupStageWorkflow);
  private readonly runtimeState = signal<ApplicationRuntimeState>({
    phase: 'stopped',
  });
  private readonly retries = new Subject<void>();
  private activeStop: Subject<void> | null = null;
  private attempt = 0;

  readonly state = this.runtimeState.asReadonly();

  /**
   * The application lifetime. The subscriber owns startup, every session-long stream,
   * and teardown; unsubscribing is equivalent to an explicit stop.
   */
  run(): Observable<ApplicationStartOutcome> {
    return defer(() => {
      if (this.activeStop) {
        throw new ApplicationRuntimeAlreadyRunningError();
      }
      this.health.reset();
      const stop = new Subject<void>();
      this.activeStop = stop;
      return this.runOwnedSession().pipe(
        takeUntil(stop),
        tap({
          finalize: () => {
            stop.complete();
            if (this.activeStop === stop) this.activeStop = null;
            this.health.reset();
            this.runtimeState.set({ phase: 'stopped' });
          },
        }),
      );
    });
  }

  private runOwnedSession(): Observable<ApplicationStartOutcome> {
    return defer(() => {
      const preferenceLifetimeStart = new ReplaySubject<void>(1);
      let preferenceFailed = false;
      return merge(
        preferenceLifetimeStart.pipe(
          take(1),
          switchMap(() => this.adapter.runPreferenceLifetime()),
          tap({
            next: (warning) => this.recordSessionWarning(warning),
            error: () => {
              preferenceFailed = true;
            },
          }),
          ignoreElements(),
        ),
        this.attemptUntilReady(
          () => {
            preferenceLifetimeStart.next();
            preferenceLifetimeStart.complete();
            // A synchronous source fault closes the merged owner during this callback.
            // Do not advance startup and overwrite its classified blocker afterward.
            if (preferenceFailed)
              throw new Error('Preference lifetime failed.');
          },
          0,
          [],
          [],
        ),
      ).pipe(
        finalize(() => preferenceLifetimeStart.complete()),
        catchError(() =>
          concat(
            of(this.unknownFailure(this.attempt)),
            this.retries.pipe(
              take(1),
              switchMap(() => this.runOwnedSession()),
            ),
          ),
        ),
      );
    });
  }

  recover(): Observable<ApplicationRecoveryOutcome> {
    return defer(() => {
      const state = this.runtimeState();
      if (state.phase !== 'blocked') {
        return of({ kind: 'unavailable', reason: 'not-blocked' } as const);
      }
      const owner = this.activeStop;
      return defer(() => this.adapter.recover(state.failure.recovery)).pipe(
        timeout(10_000),
        catchError(() =>
          of({ kind: 'unavailable', reason: 'recovery-failed' } as const),
        ),
        take(1),
        defaultIfEmpty({
          kind: 'unavailable',
          reason: 'recovery-failed',
        } as const),
        map((outcome): ApplicationRecoveryOutcome => {
          if (outcome.kind === 'unavailable') return outcome;
          const current = this.runtimeState();
          if (
            owner !== this.activeStop ||
            current.phase !== 'blocked' ||
            current.attempt !== state.attempt
          ) {
            return { kind: 'unavailable', reason: 'transition-in-progress' };
          }
          this.retries.next();
          return { kind: 'accepted' };
        }),
      );
    });
  }

  stop(): Observable<ApplicationStopOutcome> {
    return defer(() => {
      const stop = this.activeStop;
      if (!stop) return of({ kind: 'already-stopped' } as const);
      this.runtimeState.set({ phase: 'stopping', attempt: this.attempt });
      stop.next();
      return of({ kind: 'stopped' } as const);
    });
  }

  private attemptUntilReady(
    onPreferencesHydrated: () => void,
    startIndex: number,
    warnings: readonly ApplicationRuntimeWarning[],
    settlements: readonly ApplicationStartupProducerSettlement[],
  ): Observable<ApplicationStartOutcome> {
    return this.runAttempt(
      onPreferencesHydrated,
      startIndex,
      warnings,
      settlements,
    ).pipe(
      switchMap((outcome) =>
        outcome.kind === 'ready'
          ? of(outcome)
          : concat(
              of(outcome),
              this.retries.pipe(
                take(1),
                switchMap(() => {
                  const resumeIndex = recoveryStartIndex(outcome.failure.stage);
                  return this.attemptUntilReady(
                    onPreferencesHydrated,
                    resumeIndex,
                    warningsBefore(resumeIndex, outcome.warnings),
                    settlementsBefore(resumeIndex, outcome.settlements),
                  );
                }),
              ),
            ),
      ),
    );
  }

  private runAttempt(
    onPreferencesHydrated: () => void,
    startIndex: number,
    warnings: readonly ApplicationRuntimeWarning[],
    settlements: readonly ApplicationStartupProducerSettlement[],
  ): Observable<ApplicationStartOutcome> {
    return defer(() => {
      const attempt = ++this.attempt;
      return defer(() =>
        this.runStage(
          attempt,
          startIndex,
          warnings,
          settlements,
          onPreferencesHydrated,
        ),
      ).pipe(
        timeout({
          first: APPLICATION_STARTUP_WATCHDOG_BUDGET_MS,
          with: () => of(this.watchdogFailure(attempt)),
        }),
        catchError(() => of(this.unknownFailure(attempt))),
      );
    });
  }

  private watchdogFailure(attempt: number): ApplicationStartOutcome {
    return this.publishFailure(
      startupFailureOutcome(
        attempt,
        this.runtimeState(),
        'application-startup-watchdog-expired',
      ),
    );
  }

  private unknownFailure(attempt: number): ApplicationStartOutcome {
    return this.publishFailure(
      startupFailureOutcome(
        attempt,
        this.runtimeState(),
        'application-adapter-failed',
      ),
    );
  }

  private publishFailure(
    outcome: Extract<ApplicationStartOutcome, { readonly kind: 'blocked' }>,
  ): ApplicationStartOutcome {
    this.runtimeState.set({
      phase: 'blocked',
      attempt: outcome.attempt,
      failure: outcome.failure,
      warnings: outcome.warnings,
      settlements: outcome.settlements,
    });
    return outcome;
  }

  private runStage(
    attempt: number,
    index: number,
    warnings: readonly ApplicationRuntimeWarning[],
    settlements: readonly ApplicationStartupProducerSettlement[],
    onPreferencesHydrated: () => void,
  ): Observable<ApplicationStartOutcome> {
    const stage = APPLICATION_STARTUP_STAGES[index];
    if (!stage) {
      const outcome = {
        kind: 'ready',
        attempt,
        warnings,
        settlements,
      } as const;
      this.runtimeState.set({ phase: 'ready', attempt, warnings, settlements });
      return of(outcome);
    }
    this.runtimeState.set({
      phase: 'starting',
      attempt,
      stage,
      warnings,
      settlements,
    });
    if (stage === 'session-capabilities') {
      return this.runSessionStage(
        attempt,
        index,
        stage,
        warnings,
        settlements,
        onPreferencesHydrated,
      );
    }
    return this.stageWorkflow
      .run(stage)
      .pipe(
        switchMap((outcome) =>
          this.advanceStage(
            attempt,
            index,
            stage,
            warnings,
            settlements,
            outcome,
            onPreferencesHydrated,
          ),
        ),
      );
  }

  private runSessionStage(
    attempt: number,
    index: number,
    stage: ApplicationStartupStage,
    warnings: readonly ApplicationRuntimeWarning[],
    settlements: readonly ApplicationStartupProducerSettlement[],
    onPreferencesHydrated: () => void,
  ): Observable<ApplicationStartOutcome> {
    const readiness = new ReplaySubject<void>(1);
    return this.sessionStartup.run(readiness).pipe(
      connect((events) =>
        events.pipe(
          take(1),
          switchMap((event) => {
            if (event.kind !== 'settled') {
              return throwError(
                () =>
                  new Error(
                    'Application Runtime session emitted live state before settlement.',
                  ),
              );
            }
            return this.advanceStage(
              attempt,
              index,
              stage,
              warnings,
              settlements,
              event.outcome,
              onPreferencesHydrated,
            );
          }),
          switchMap((outcome) => {
            if (outcome.kind === 'blocked') return of(outcome);
            return merge(
              events.pipe(
                switchMap((event) => {
                  if (event.kind === 'warning') {
                    this.recordSessionWarning(event.warning);
                    return EMPTY;
                  }
                  if (event.kind === 'blocked') {
                    const current = this.runtimeState();
                    const currentWarnings =
                      'warnings' in current ? current.warnings : warnings;
                    const currentSettlements =
                      'settlements' in current
                        ? current.settlements
                        : settlements;
                    return this.advanceStage(
                      attempt,
                      index,
                      stage,
                      currentWarnings,
                      currentSettlements,
                      event.outcome,
                      onPreferencesHydrated,
                    );
                  }
                  return throwError(
                    () =>
                      new Error(
                        'Application Runtime session prepared more than once.',
                      ),
                  );
                }),
              ),
              defer(() => {
                readiness.next();
                readiness.complete();
                return of(outcome);
              }),
            );
          }),
        ),
      ),
      finalize(() => readiness.complete()),
    );
  }

  private advanceStage(
    attempt: number,
    index: number,
    stage: ApplicationStartupStage,
    warnings: readonly ApplicationRuntimeWarning[],
    settlements: readonly ApplicationStartupProducerSettlement[],
    outcome: ApplicationStartupStageOutcome,
    onPreferencesHydrated: () => void,
  ): Observable<ApplicationStartOutcome> {
    const nextWarnings = [...warnings, ...(outcome.warnings ?? [])];
    const outcomeSettlements = stageSettlements(stage, outcome);
    const settledProducers = new Set(
      outcomeSettlements.map((settlement) => settlement.producer),
    );
    const nextSettlements = [
      ...settlements.filter(
        (settlement) => !settledProducers.has(settlement.producer),
      ),
      ...outcomeSettlements,
    ];
    if (outcome.kind === 'blocked') {
      const failure = {
        stage,
        recovery: outcome.recovery,
        diagnostic: outcome.diagnostic,
      } as const;
      const blocked = {
        kind: 'blocked',
        attempt,
        failure,
        warnings: nextWarnings,
        settlements: withDependencySkips(stage, nextSettlements, []),
      } as const;
      this.runtimeState.set({
        phase: 'blocked',
        attempt,
        failure,
        warnings: nextWarnings,
        settlements: blocked.settlements,
      });
      return of(blocked);
    }
    if (stage === 'preference-hydration') {
      onPreferencesHydrated();
    }
    return this.runStage(
      attempt,
      index + 1,
      nextWarnings,
      nextSettlements,
      onPreferencesHydrated,
    );
  }

  private recordSessionWarning(warning: ApplicationRuntimeWarning): void {
    const state = this.runtimeState();
    if (state.phase !== 'ready') return;
    this.runtimeState.set({
      ...state,
      warnings: [...state.warnings, warning],
    });
  }
}
