import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import type {
  CapabilityContext,
  CapabilityRecoveryOutcome,
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
  NativePushHealth,
  NativePushLifetimeEvent,
} from './notification-health.models';
import { PushGatewayService } from './push-gateway.service';
import { PushService } from './push.service';

const PREPARATION_BUDGET_MS = 10_000;

/** Retains native activation listeners and owns exact push-registration recovery. */
@Injectable({ providedIn: 'root' })
export class NativePushLifetime {
  private readonly injector = inject(Injector);
  private readonly matrix = inject(MatrixClientService);
  private readonly gateway = inject(PushGatewayService);
  private readonly push = inject(PushService);
  private readonly context: CapabilityContext = Symbol();
  private readonly changes = new Subject<NativePushHealth>();
  private generation = 0;
  private current: NativePushHealth | null = null;
  private retry: (() => void) | null = null;
  private demandCurrent: (() => boolean) | null = null;

  run(): Observable<NativePushLifetimeEvent> {
    return new Observable((subscriber) => {
      if (this.retry) throw new Error('Native push lifetime already owned.');
      let prerequisite: ReturnType<PushService['runtimePrerequisite']> | null =
        null;
      let prepared = false;
      let listener = new Subscription();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let ownsListener = false;
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
        condition: NativePushHealth['condition'],
        code: NativePushHealth['code'],
        preparation: NativePushHealth['preparation'],
      ): void => {
        if (!this.current || subscriber.closed) return;
        this.current = {
          ...this.current,
          condition,
          code,
          preparation:
            this.current.preparation === 'acknowledged' &&
            preparation === 'failed'
              ? 'acknowledged'
              : preparation,
          ownership: ownsListener ? 'retained' : 'released',
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
        ownsListener = false;
        listener.unsubscribe();
        listener = new Subscription();
      };
      const release = (): void => {
        if (!ownsListener) return;
        ownsListener = false;
        publish('degraded', 'push-listener-ownership-released', 'failed');
      };
      const attach = (): void => {
        ownsListener = true;
        let released = false;
        const owned = this.push.run().subscribe({
          next: (destination) =>
            subscriber.next({ kind: 'activated', destination }),
          error: () => {
            released = true;
            release();
          },
          complete: () => {
            released = true;
            release();
          },
        });
        if (released || !ownsListener) {
          owned.unsubscribe();
          return;
        }
        listener.add(owned);
        watchdog = setTimeout(
          () => publish('degraded', 'push-registration-timeout', 'failed'),
          PREPARATION_BUDGET_MS,
        );
      };
      const apply = (): void => {
        if (applying) return;
        const next = this.push.runtimePrerequisite();
        if (next === prerequisite && this.current) return;
        applying = true;
        try {
          disconnect();
          prerequisite = next;
          const demanded = next === 'ready';
          this.current = {
            capability: 'push',
            operation: 'registration',
            context: this.context,
            generation: ++this.generation,
            demanded,
            preparation: demanded ? 'pending' : 'acknowledged',
            ownership: 'released',
            condition:
              next === 'ready'
                ? 'initializing'
                : next === 'unsupported'
                  ? 'not-applicable'
                  : 'waiting-for-precondition',
            code:
              next === 'ready'
                ? 'push-registration-preparing'
                : next === 'unsupported'
                  ? 'push-registration-unsupported'
                  : next === 'not-configured'
                    ? 'push-registration-not-configured'
                    : 'push-registration-no-account',
          };
          publish(
            this.current.condition,
            this.current.code,
            this.current.preparation,
          );
          if (demanded) attach();
        } finally {
          applying = false;
        }
      };
      const observeStatus = (): void => {
        if (!this.current?.demanded || !ownsListener) return;
        const state = this.push.runtimeStatus();
        if (state.status === 'idle') return;
        publish(
          state.status === 'available'
            ? 'available'
            : state.status === 'disabled'
              ? 'disabled'
              : 'degraded',
          state.code,
          state.status === 'available' || state.status === 'disabled'
            ? 'acknowledged'
            : 'failed',
        );
      };

      this.demandCurrent = () =>
        prerequisite === 'ready' && this.push.runtimePrerequisite() === 'ready';
      this.retry = () => {
        if (!this.current || !this.demandCurrent?.()) return;
        const retained = this.current.ownership === 'retained';
        if (!retained) disconnect();
        this.current = { ...this.current, generation: ++this.generation };
        publish('recovering', 'push-registration-preparing', 'pending');
        if (retained) {
          listener.add(
            this.push.register().subscribe({ error: () => observeStatus() }),
          );
          watchdog = setTimeout(
            () => publish('degraded', 'push-registration-timeout', 'failed'),
            PREPARATION_BUDGET_MS,
          );
        } else attach();
      };
      apply();
      const stateChanges = effect(
        () => {
          this.push.runtimeStatus();
          untracked(observeStatus);
        },
        { injector: this.injector },
      );
      const demandChanges = effect(
        () => {
          this.matrix.accountIds();
          this.gateway.configured();
          untracked(apply);
        },
        { injector: this.injector },
      );
      return () => {
        stateChanges.destroy();
        demandChanges.destroy();
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
        const result = this.changes
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
                  : fact.condition === 'disabled' ||
                      fact.condition === 'not-applicable'
                    ? 'unavailable'
                    : 'failure',
            })),
            timeout(PREPARATION_BUDGET_MS),
            catchError(() => of({ kind: 'failure' } as const)),
          )
          .subscribe(subscriber);
        this.retry?.();
        return () => result.unsubscribe();
      });
    });
  }
}
