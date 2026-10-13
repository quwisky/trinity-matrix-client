import { Injectable, inject } from '@angular/core';
import { Observable, defer, of, take, throwIfEmpty, timeout } from 'rxjs';
import { APPLICATION_RUNTIME_ADAPTER } from './application-runtime.adapter';
import type {
  ApplicationSessionLockOutcome,
  ApplicationStartupStage,
  ApplicationStartupStageOutcome,
} from './application-runtime.models';
import { requiredStartupPolicyForStage } from './application-startup.policy';

/** Every stage but the session lock, whose `waiting` answer is not a stage outcome. */
export type ApplicationCommandStage = Exclude<
  ApplicationStartupStage,
  'session-lock'
>;

/** Selects, bounds, and validates one required startup-stage command. */
@Injectable({ providedIn: 'root' })
export class ApplicationStartupStageWorkflow {
  private readonly adapter = inject(APPLICATION_RUNTIME_ADAPTER);

  run(
    stage: ApplicationCommandStage,
  ): Observable<ApplicationStartupStageOutcome> {
    const commands: Record<
      ApplicationCommandStage,
      () => Observable<ApplicationStartupStageOutcome>
    > = {
      'host-negotiation': () => this.adapter.negotiateHost(),
      'preference-hydration': () => this.adapter.hydratePreferences(),
      'account-restoration': () => this.adapter.restoreAccounts(),
      'session-capabilities': () => this.adapter.establishSessionCapabilities(),
      'workspace-restoration': () => this.adapter.restoreWorkspace(),
      readiness: () => this.adapter.awaitReadiness(),
    };
    const command = defer(commands[stage]);
    const policy = requiredStartupPolicyForStage(stage);
    let bounded: Observable<ApplicationStartupStageOutcome> = command;
    if (
      policy &&
      policy.budgetMs !== null &&
      stage !== 'session-capabilities'
    ) {
      const { budgetMs, timeoutCode } = policy;
      bounded = command.pipe(
        timeout({
          first: budgetMs,
          with: () =>
            of({
              kind: 'blocked',
              recovery: 'retry-startup',
              diagnostic: { code: timeoutCode },
            } as const),
        }),
      );
    }
    return bounded.pipe(
      take(1),
      throwIfEmpty(
        () =>
          new Error(`Application Runtime stage '${stage}' emitted nothing.`),
      ),
    );
  }

  /**
   * The session-lock stage. No stage deadline (its policy has none): `waiting` ends the
   * attempt, and the wait for another tab happens outside the startup watchdog.
   */
  sessionLock(): Observable<ApplicationSessionLockOutcome> {
    return defer(() => this.adapter.acquireSessionLock()).pipe(
      take(1),
      throwIfEmpty(
        () =>
          new Error(
            "Application Runtime stage 'session-lock' emitted nothing.",
          ),
      ),
    );
  }

  /** Emits once, when a tab that waited for the session lock holds it. */
  sessionLockGranted(): Observable<void> {
    return defer(() => this.adapter.awaitSessionLock()).pipe(take(1));
  }
}
