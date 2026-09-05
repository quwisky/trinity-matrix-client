import { Injectable, inject } from '@angular/core';
import { Observable, defer, of, take, throwIfEmpty, timeout } from 'rxjs';
import { APPLICATION_RUNTIME_ADAPTER } from './application-runtime.adapter';
import type {
  ApplicationStartupStage,
  ApplicationStartupStageOutcome,
} from './application-runtime.models';
import { requiredStartupPolicyForStage } from './application-startup.policy';

/** Selects, bounds, and validates one required startup-stage command. */
@Injectable({ providedIn: 'root' })
export class ApplicationStartupStageWorkflow {
  private readonly adapter = inject(APPLICATION_RUNTIME_ADAPTER);

  run(
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
    const command = defer(commands[stage]);
    const policy = requiredStartupPolicyForStage(stage);
    const bounded =
      !policy || stage === 'session-capabilities'
        ? command
        : command.pipe(
            timeout({
              first: policy.budgetMs,
              with: () =>
                of({
                  kind: 'blocked',
                  recovery: 'retry-startup',
                  diagnostic: { code: policy.timeoutCode },
                } as const),
            }),
          );
    return bounded.pipe(
      take(1),
      throwIfEmpty(
        () =>
          new Error(`Application Runtime stage '${stage}' emitted nothing.`),
      ),
    );
  }
}
