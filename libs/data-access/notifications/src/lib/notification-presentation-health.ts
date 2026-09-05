import type {
  CapabilityContext,
  CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import {
  Observable,
  Subject,
  catchError,
  defer,
  filter,
  map,
  of,
  take,
  timeout,
} from 'rxjs';
import type {
  NotificationIncident,
  NotificationPresentationHealth,
} from './notification-health.models';
import type { NotificationRuntimeEvent } from './notification-intent';

const RECOVERY_BUDGET_MS = 10_000;

/** Value-free presentation health state kept separate from message-delivery mechanics. */
export class NotificationPresentationHealthTracker {
  private readonly context: CapabilityContext = Symbol();
  private readonly changes = new Subject<NotificationPresentationHealth>();
  private generation = 0;
  private current: NotificationPresentationHealth | null = null;
  private emit: ((event: NotificationRuntimeEvent) => void) | null = null;

  start(emit: (event: NotificationRuntimeEvent) => void): void {
    this.emit = emit;
    this.current = null;
  }

  reset(): void {
    this.emit = null;
    this.current = null;
  }

  begin(): void {
    this.generation += 1;
    this.publish(
      'initializing',
      'notification-presentation-preparing',
      'pending',
      true,
    );
  }

  publish(
    condition: NotificationPresentationHealth['condition'],
    code: NotificationPresentationHealth['code'],
    preparation: NotificationPresentationHealth['preparation'],
    ownsPresentation: boolean,
  ): void {
    if (!this.emit) return;
    const demanded = code !== 'notification-presentation-not-demanded';
    this.current = {
      capability: 'notifications',
      operation: 'presentation',
      context: this.context,
      generation: this.generation,
      demanded,
      preparation,
      ownership: ownsPresentation ? 'retained' : 'released',
      condition,
      code,
    };
    this.emit({ kind: 'health', fact: this.current });
    this.changes.next(this.current);
  }

  incident(
    operation: NotificationIncident['operation'],
    code: NotificationIncident['code'],
  ): void {
    this.emit?.({
      kind: 'incident',
      incident: {
        context: this.context,
        capability: 'notifications',
        operation,
        code,
      },
    });
  }

  recover(
    context: CapabilityContext,
    generation: number,
    retry: () => void,
  ): Observable<CapabilityRecoveryOutcome> {
    return defer(() => {
      if (
        !this.emit ||
        !this.current?.demanded ||
        this.current.context !== context ||
        this.current.generation !== generation
      )
        return of({ kind: 'unavailable' } as const);
      return new Observable<CapabilityRecoveryOutcome>((subscriber) => {
        const result = this.changes
          .pipe(
            filter(
              (fact) =>
                fact.context === context &&
                fact.generation > generation &&
                fact.condition !== 'initializing' &&
                fact.condition !== 'recovering',
            ),
            take(1),
            map((fact): CapabilityRecoveryOutcome => ({
              kind:
                fact.condition === 'available'
                  ? 'success'
                  : fact.condition === 'disabled' ||
                      fact.condition === 'not-applicable'
                    ? 'unavailable'
                    : 'failure',
            })),
            timeout(RECOVERY_BUDGET_MS),
            catchError(() => of({ kind: 'failure' } as const)),
          )
          .subscribe(subscriber);
        retry();
        return () => result.unsubscribe();
      });
    });
  }
}
