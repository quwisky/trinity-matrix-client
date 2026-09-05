import {
  Injectable,
  Injector,
  effect,
  inject,
  type Signal,
  untracked,
} from '@angular/core';
import { Observable, Subscription, forkJoin } from 'rxjs';
import { ProjectionRuntime } from './projection-runtime.service';

export interface ActiveAccountProjectionLifetimeConfig {
  readonly activeAccountId: Signal<string | null>;
  readonly demanded?: Signal<boolean>;
  readonly connect: () => void;
  readonly disconnect: () => void;
  /** Optional cold preparation that must settle before the initial ready event. */
  readonly prepare?: () => Observable<void>;
}

/** Retains active-Account projections while a session capability demands them. */
@Injectable({ providedIn: 'root' })
export class ActiveAccountProjectionLifetime {
  private readonly injector = inject(Injector);
  private readonly projections = inject(ProjectionRuntime);

  /** Prepare once, react to Account/demand changes, and release exactly once. */
  run(config: ActiveAccountProjectionLifetimeConfig): Observable<void> {
    return new Observable<void>((subscriber) => {
      let accountId = config.activeAccountId();
      let demanded = config.demanded?.() ?? true;
      let attached = false;
      let prepared = false;
      let barrier = new Subscription();

      const finishPreparation = (): void => {
        if (prepared) return;
        prepared = true;
        subscriber.next();
      };
      const disconnect = (): void => {
        barrier.unsubscribe();
        barrier = new Subscription();
        if (!attached) return;
        attached = false;
        config.disconnect();
      };
      const fail = (error: unknown): void => {
        try {
          disconnect();
          subscriber.error(error);
        } catch (cleanupError: unknown) {
          subscriber.error(
            new AggregateError(
              [error, cleanupError],
              'Projection lifetime and cleanup failed.',
            ),
          );
        }
      };
      const connect = (): void => {
        if (attached) return;
        try {
          config.connect();
          attached = true;
          const projectionReadiness = this.projections.waitFor({
            kind: 'active-account',
          });
          const preparation: Observable<unknown> = config.prepare
            ? forkJoin([projectionReadiness, config.prepare()])
            : projectionReadiness;
          barrier = preparation.subscribe({
            next: finishPreparation,
            error: fail,
          });
        } catch (error: unknown) {
          attached = false;
          try {
            config.disconnect();
          } catch (cleanupError: unknown) {
            subscriber.error(
              new AggregateError(
                [error, cleanupError],
                'Projection attachment and cleanup failed.',
              ),
            );
            return;
          }
          subscriber.error(error);
        }
      };
      const apply = (): void => {
        if (!accountId || !demanded) {
          try {
            disconnect();
          } catch (error: unknown) {
            subscriber.error(error);
            return;
          }
          finishPreparation();
          return;
        }
        connect();
      };

      apply();
      if (subscriber.closed) return;

      const changes = effect(
        () => {
          const nextAccountId = config.activeAccountId();
          const nextDemanded = config.demanded?.() ?? true;
          if (nextAccountId === accountId && nextDemanded === demanded) return;
          accountId = nextAccountId;
          demanded = nextDemanded;
          untracked(apply);
        },
        { injector: this.injector },
      );

      return () => {
        changes.destroy();
        disconnect();
      };
    });
  }
}
