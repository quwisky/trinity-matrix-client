import { Injectable, inject, signal } from '@angular/core';
import {
  Observable,
  ReplaySubject,
  Subject,
  concat,
  defer,
  ignoreElements,
  map,
  merge,
  of,
  switchMap,
  take,
  takeUntil,
  tap,
  throwIfEmpty,
} from 'rxjs';
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
      const stop = new Subject<void>();
      const preferenceLifetimeStart = new ReplaySubject<void>(1);
      this.activeStop = stop;
      return merge(
        preferenceLifetimeStart.pipe(
          take(1),
          switchMap(() => this.adapter.runPreferenceLifetime()),
          tap((warning) => this.recordSessionWarning(warning)),
          ignoreElements(),
        ),
        this.attemptUntilReady(() => {
          preferenceLifetimeStart.next();
          preferenceLifetimeStart.complete();
        }).pipe(
          switchMap((outcome) =>
            outcome.kind === 'blocked'
              ? of(outcome)
              : concat(
                  of(outcome),
                  this.adapter.runSession().pipe(
                    tap((warning) => this.recordSessionWarning(warning)),
                    ignoreElements(),
                  ),
                ),
          ),
        ),
      ).pipe(
        takeUntil(stop),
        tap({
          finalize: () => {
            preferenceLifetimeStart.complete();
            stop.complete();
            if (this.activeStop === stop) this.activeStop = null;
            this.runtimeState.set({ phase: 'stopped' });
          },
        }),
      );
    });
  }

  recover(): Observable<ApplicationRecoveryOutcome> {
    return defer(() => {
      const state = this.runtimeState();
      if (state.phase !== 'blocked') {
        return of({ kind: 'unavailable', reason: 'not-blocked' } as const);
      }
      return this.adapter.recover(state.failure.recovery).pipe(
        take(1),
        throwIfEmpty(
          () => new Error('Application Runtime recovery emitted nothing.'),
        ),
        map((outcome): ApplicationRecoveryOutcome => {
          if (outcome.kind === 'unavailable') return outcome;
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
      return this.runStage(attempt, 0, [], onPreferencesHydrated);
    });
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
