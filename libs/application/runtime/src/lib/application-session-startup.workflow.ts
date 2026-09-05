import { Injectable, inject } from '@angular/core';
import {
  Observable,
  connect,
  forkJoin,
  map,
  merge,
  of,
  switchMap,
  take,
  throwIfEmpty,
  timeout,
} from 'rxjs';
import { APPLICATION_RUNTIME_ADAPTER } from './application-runtime.adapter';
import type {
  ApplicationSessionEvent,
  ApplicationStartupProducerSettlement,
  ApplicationStartupStageOutcome,
} from './application-runtime.models';
import { requiredStartupPolicyForStage } from './application-startup.policy';
import { optionalSessionSettlements } from './application-startup-settlements';

export type ApplicationSessionStartupEvent =
  | {
      readonly kind: 'settled';
      readonly outcome: ApplicationStartupStageOutcome;
    }
  | {
      readonly kind: 'blocked';
      readonly outcome: Extract<
        ApplicationStartupStageOutcome,
        { readonly kind: 'blocked' }
      >;
    };

/** Settles required preparation and optional siblings, then retains live session ownership. */
@Injectable({ providedIn: 'root' })
export class ApplicationSessionStartupWorkflow {
  private readonly adapter = inject(APPLICATION_RUNTIME_ADAPTER);

  run(readiness: Observable<void>): Observable<ApplicationSessionStartupEvent> {
    const policy = requiredStartupPolicyForStage('session-capabilities')!;
    const session = this.adapter.runSession(readiness).pipe(
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
    return session.pipe(
      connect((events) =>
        forkJoin({
          preparation: events.pipe(
            take(1),
            map((event) => event),
          ),
          optional: this.adapter.establishSessionCapabilities().pipe(
            take(1),
            throwIfEmpty(
              () =>
                new Error(
                  "Application Runtime stage 'session-capabilities' emitted nothing.",
                ),
            ),
          ),
        }).pipe(
          switchMap(({ preparation, optional }) => {
            const outcome = this.stageOutcome(preparation, optional);
            if (outcome.kind === 'blocked') {
              return of({ kind: 'settled', outcome } as const);
            }
            return merge(
              of({ kind: 'settled', outcome } as const),
              events.pipe(
                map((event): ApplicationSessionStartupEvent => {
                  if (event.kind === 'blocked') {
                    return { kind: 'blocked', outcome: event };
                  }
                  throw new Error(
                    'Application Runtime session prepared more than once.',
                  );
                }),
              ),
            );
          }),
        ),
      ),
    );
  }

  private stageOutcome(
    preparation: ApplicationSessionEvent,
    optional: ApplicationStartupStageOutcome,
  ): ApplicationStartupStageOutcome {
    const roomLibrary: ApplicationStartupProducerSettlement = {
      producer: 'room-library',
      stage: 'session-capabilities',
      status: preparation.kind === 'prepared' ? 'ready' : 'blocked',
      ...(preparation.kind === 'blocked'
        ? { diagnostic: preparation.diagnostic }
        : {}),
    };
    return preparation.kind === 'blocked'
      ? {
          ...preparation,
          settlements: [roomLibrary, ...optionalSessionSettlements(optional)],
        }
      : {
          ...optional,
          settlements: [roomLibrary, ...optionalSessionSettlements(optional)],
        };
  }
}
