import { Injectable, inject, signal } from '@angular/core';
import {
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
  throwIfEmpty,
  throwError,
} from 'rxjs';
import { CapabilityHealthService } from './capability-health.service';
import { APPLICATION_RUNTIME_ADAPTER } from './application-runtime.adapter';
import {
  APPLICATION_STARTUP_STAGES,
  type ApplicationRecoveryOutcome,
  type ApplicationRuntimeState,
  type ApplicationRuntimeWarning,
  type ApplicationStartOutcome,
  type ApplicationStartupStage,
  type ApplicationStartupStageOutcome,
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
        this.attemptUntilReady(() => {
          preferenceLifetimeStart.next();
          preferenceLifetimeStart.complete();
          // A synchronous source fault closes the merged owner during this callback.
          // Do not advance startup and overwrite its classified blocker afterward.
          if (preferenceFailed) throw new Error('Preference lifetime failed.');
        }),
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
  ): Observable<ApplicationStartOutcome> {
    return this.runAttempt(onPreferencesHydrated).pipe(
      switchMap((outcome) =>
        outcome.kind === 'ready'
          ? of(outcome)
          : concat(
              of(outcome),
              this.retries.pipe(
                take(1),
                switchMap(() => this.attemptUntilReady(onPreferencesHydrated)),
              ),
            ),
      ),
    );
  }

  private runAttempt(
    onPreferencesHydrated: () => void,
  ): Observable<ApplicationStartOutcome> {
    return defer(() => {
      const attempt = ++this.attempt;
      this.health.reset();
      return defer(() =>
        this.runStage(attempt, 0, [], onPreferencesHydrated),
      ).pipe(catchError(() => of(this.unknownFailure(attempt))));
    });
  }

  private unknownFailure(attempt: number): ApplicationStartOutcome {
    const current = this.runtimeState();
    const stage =
      current.phase === 'starting' ? current.stage : 'session-capabilities';
    const warnings = 'warnings' in current ? current.warnings : [];
    const failure = {
      stage,
      recovery: 'retry-startup',
      diagnostic: { code: 'application-adapter-failed' },
    } as const;
    this.runtimeState.set({ phase: 'blocked', attempt, failure, warnings });
    return { kind: 'blocked', attempt, failure, warnings };
  }

  private runStage(
    attempt: number,
    index: number,
    warnings: readonly ApplicationRuntimeWarning[],
    onPreferencesHydrated: () => void,
  ): Observable<ApplicationStartOutcome> {
    const stage = APPLICATION_STARTUP_STAGES[index];
    if (!stage) {
      const outcome = { kind: 'ready', attempt, warnings } as const;
      this.runtimeState.set({ phase: 'ready', attempt, warnings });
      return of(outcome);
    }
    this.runtimeState.set({ phase: 'starting', attempt, stage, warnings });
    if (stage === 'session-capabilities') {
      return this.runSessionStage(
        attempt,
        index,
        stage,
        warnings,
        onPreferencesHydrated,
      );
    }
    return this.stageCommand(stage).pipe(
      take(1),
      throwIfEmpty(
        () =>
          new Error(`Application Runtime stage '${stage}' emitted nothing.`),
      ),
      switchMap((outcome) =>
        this.advanceStage(
          attempt,
          index,
          stage,
          warnings,
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
    onPreferencesHydrated: () => void,
  ): Observable<ApplicationStartOutcome> {
    const readiness = new ReplaySubject<void>(1);
    return this.adapter.runSession(readiness).pipe(
      connect((events) =>
        events.pipe(
          take(1),
          switchMap((event) => {
            if (event.kind === 'warning') {
              return throwError(
                () =>
                  new Error(
                    'Application Runtime session warned before preparation.',
                  ),
              );
            }
            if (event.kind === 'blocked') {
              return this.advanceStage(
                attempt,
                index,
                stage,
                warnings,
                event,
                onPreferencesHydrated,
              );
            }
            return this.stageCommand(stage).pipe(
              take(1),
              throwIfEmpty(
                () =>
                  new Error(
                    `Application Runtime stage '${stage}' emitted nothing.`,
                  ),
              ),
              switchMap((outcome) =>
                this.advanceStage(
                  attempt,
                  index,
                  stage,
                  warnings,
                  outcome,
                  onPreferencesHydrated,
                ),
              ),
              switchMap((outcome) => {
                if (outcome.kind === 'blocked') return of(outcome);
                return merge(
                  events.pipe(
                    tap((sessionEvent) => {
                      if (sessionEvent.kind !== 'warning') {
                        throw new Error(
                          'Application Runtime session prepared more than once.',
                        );
                      }
                      this.recordSessionWarning(sessionEvent.warning);
                    }),
                    ignoreElements(),
                  ),
                  defer(() => {
                    readiness.next();
                    readiness.complete();
                    return of(outcome);
                  }),
                );
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
    outcome: ApplicationStartupStageOutcome,
    onPreferencesHydrated: () => void,
  ): Observable<ApplicationStartOutcome> {
    const nextWarnings = [...warnings, ...(outcome.warnings ?? [])];
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
      } as const;
      this.runtimeState.set({
        phase: 'blocked',
        attempt,
        failure,
        warnings: nextWarnings,
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
      onPreferencesHydrated,
    );
  }

  private stageCommand(
    stage: ApplicationStartupStage,
  ): Observable<ApplicationStartupStageOutcome> {
    const commands: Record<
      ApplicationStartupStage,
      () => Observable<ApplicationStartupStageOutcome>
    > = {
      'host-negotiation': () => this.adapter.negotiateHost(),
      'preference-hydration': () => this.adapter.hydratePreferences(),
      'account-restoration': () => this.adapter.restoreAccounts(),
      'session-capabilities': () => this.adapter.establishSessionCapabilities(),
      'workspace-restoration': () => this.adapter.restoreWorkspace(),
      readiness: () => this.adapter.awaitReadiness(),
    };
    return defer(commands[stage]);
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
