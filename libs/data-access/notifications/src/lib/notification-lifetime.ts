import {
  Injectable,
  Injector,
  effect,
  inject,
  type Signal,
  untracked,
} from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  ProjectionRuntime,
  type CapabilityContext,
  type CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import {
  Observable,
  Subject,
  Subscription,
  catchError,
  defer,
  filter,
  map,
  of,
  take,
  timeout,
} from 'rxjs';
import type {
  NotificationLifetimeEvent,
  NotificationRuleHealth,
} from './notification-health.models';
import { RoomNotificationsService } from './room-notifications.service';

const PREPARATION_BUDGET_MS = 10_000;

/** Owns Room-rule projection demand and exact active-Account recovery. */
@Injectable({ providedIn: 'root' })
export class NotificationLifetime {
  private readonly injector = inject(Injector);
  private readonly projections = inject(ProjectionRuntime);
  private readonly matrix = inject(MatrixClientService);
  private readonly roomNotifications = inject(RoomNotificationsService);
  private readonly changes = new Subject<NotificationRuleHealth>();
  private generation = 0;
  private current: NotificationRuleHealth | null = null;
  private retry: (() => void) | null = null;
  private demandCurrent: (() => boolean) | null = null;

  /** Attach on routed Room demand and release with the owning Runtime session. */
  run(demanded: Signal<boolean>): Observable<NotificationLifetimeEvent> {
    return new Observable((subscriber) => {
      if (this.retry) throw new Error('Notification lifetime already owned.');
      const contexts = new Map<string, CapabilityContext>();
      let accountId: string | null = null;
      let required = false;
      let prepared = false;
      let observation = new Subscription();
      let projection = new Subscription();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let ownsProjection = false;
      let applying = false;

      const clearWatchdog = (): void => {
        clearTimeout(watchdog);
        watchdog = undefined;
      };
      const acknowledge = (): void => {
        if (prepared) return;
        prepared = true;
        subscriber.next({ kind: 'prepared' });
      };
      const publish = (
        condition: NotificationRuleHealth['condition'],
        code: NotificationRuleHealth['code'],
        preparation: NotificationRuleHealth['preparation'],
      ): void => {
        if (!this.current || subscriber.closed) return;
        this.current = {
          ...this.current,
          ownership: ownsProjection ? 'retained' : 'released',
          condition,
          code,
          preparation:
            this.current.preparation === 'acknowledged' &&
            preparation === 'failed'
              ? 'acknowledged'
              : preparation,
        };
        subscriber.next({ kind: 'health', fact: this.current });
        this.changes.next(this.current);
        if (condition !== 'initializing' && condition !== 'recovering') {
          clearWatchdog();
          acknowledge();
        }
      };
      const disconnect = (): void => {
        clearWatchdog();
        observation.unsubscribe();
        observation = new Subscription();
        ownsProjection = false;
        projection.unsubscribe();
        projection = new Subscription();
      };
      const ownershipReleased = (): void => {
        if (!ownsProjection) return;
        ownsProjection = false;
        publish('degraded', 'room-rules-ownership-released', 'failed');
      };
      const attach = (): void => {
        ownsProjection = true;
        let released = false;
        const owned = defer(() =>
          this.roomNotifications.runProjection(),
        ).subscribe({
          error: () => {
            released = true;
            ownershipReleased();
          },
          complete: () => {
            released = true;
            ownershipReleased();
          },
        });
        if (released || !ownsProjection) {
          owned.unsubscribe();
          return;
        }
        projection.add(owned);
        observation.add(
          this.projections
            .observe('notifications.room-rules', { kind: 'active-account' })
            .subscribe((state) => {
              if (!ownsProjection || !this.demandCurrent?.()) return;
              if (state.condition === 'available')
                publish('available', 'room-rules-ready', 'acknowledged');
              else if (state.condition === 'failed')
                publish(
                  'degraded',
                  'room-rules-reconciliation-failed',
                  'failed',
                );
              else if (state.condition === 'released') ownershipReleased();
            }),
        );
        if (
          this.current?.condition === 'initializing' ||
          this.current?.condition === 'recovering'
        ) {
          watchdog = setTimeout(
            () =>
              publish('degraded', 'room-rules-preparation-timeout', 'failed'),
            PREPARATION_BUDGET_MS,
          );
        }
      };
      const apply = (): void => {
        if (applying) return;
        const nextAccount = this.matrix.activeUserId();
        const nextRequired = !!nextAccount && demanded();
        if (
          nextAccount === accountId &&
          nextRequired === required &&
          this.current
        )
          return;
        applying = true;
        try {
          if (this.current)
            publish(
              'not-applicable',
              'room-rules-not-demanded',
              'acknowledged',
            );
          disconnect();
          accountId = nextAccount;
          required = nextRequired;
          const key = accountId ?? '';
          let context = contexts.get(key);
          if (!context) {
            context = Symbol();
            contexts.set(key, context);
          }
          this.current = {
            context,
            generation: ++this.generation,
            capability: 'notifications',
            operation: 'room-rules',
            demanded: required,
            preparation: required ? 'pending' : 'acknowledged',
            ownership: 'released',
            condition: required ? 'initializing' : 'not-applicable',
            code: required ? 'room-rules-preparing' : 'room-rules-not-demanded',
          };
          publish(
            this.current.condition,
            this.current.code,
            this.current.preparation,
          );
          if (required) attach();
        } finally {
          applying = false;
        }
      };

      this.demandCurrent = () =>
        accountId === this.matrix.activeUserId() && required && demanded();
      this.retry = () => {
        if (!this.current || !this.demandCurrent?.()) return;
        const retained = this.current.ownership === 'retained';
        if (!retained) disconnect();
        this.current = { ...this.current, generation: ++this.generation };
        publish('recovering', 'room-rules-preparing', 'pending');
        if (retained) this.roomNotifications.retryProjection();
        else attach();
      };
      apply();
      const changes = effect(
        () => {
          this.matrix.activeUserId();
          demanded();
          untracked(apply);
        },
        { injector: this.injector },
      );
      return () => {
        changes.destroy();
        this.retry = null;
        this.demandCurrent = null;
        this.current = null;
        disconnect();
      };
    });
  }

  recover(
    context: CapabilityContext,
    generation: number,
  ): Observable<CapabilityRecoveryOutcome> {
    return defer(() => {
      if (
        !this.retry ||
        !this.demandCurrent?.() ||
        this.current?.context !== context ||
        this.current.generation !== generation
      )
        return of({ kind: 'unavailable' } as const);
      return new Observable<CapabilityRecoveryOutcome>((subscriber) => {
        const observation = this.changes
          .pipe(
            filter(
              (fact) =>
                fact.context === context &&
                fact.generation > generation &&
                fact.condition !== 'recovering',
            ),
            take(1),
            map((fact): CapabilityRecoveryOutcome => ({
              kind:
                fact.condition === 'available'
                  ? 'success'
                  : fact.condition === 'not-applicable'
                    ? 'unavailable'
                    : 'failure',
            })),
            timeout(PREPARATION_BUDGET_MS),
            catchError(() => of({ kind: 'failure' } as const)),
          )
          .subscribe(subscriber);
        this.retry?.();
        return () => observation.unsubscribe();
      });
    });
  }
}
