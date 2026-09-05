import type { IdentityPresenceHealth } from './identity-health.models';
import {
  Injectable,
  Injector,
  effect,
  inject,
  untracked,
  type Signal,
} from '@angular/core';
import {
  Observable,
  Subject,
  Subscription,
  defer,
  filter,
  map,
  of,
  take,
  timeout,
  catchError,
} from 'rxjs';
import { IdentityMatrixPort } from '@trinity/data-access/matrix-client';
import {
  ProjectionRuntime,
  type CapabilityContext,
  type CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import { IdentityPresenceService } from './identity-presence.service';

export type IdentityLifetimeEvent =
  | { readonly kind: 'prepared' }
  | { readonly kind: 'health'; readonly fact: IdentityPresenceHealth };

/** Identity owns demand and retry; Application Runtime owns this single lifetime. */
@Injectable({ providedIn: 'root' })
export class IdentityLifetime {
  private readonly injector = inject(Injector);
  private readonly projections = inject(ProjectionRuntime);
  private readonly matrix = inject(IdentityMatrixPort);
  private readonly presence = inject(IdentityPresenceService);
  private readonly changes = new Subject<IdentityPresenceHealth>();
  private generation = 0;
  private current: IdentityPresenceHealth | null = null;
  private retry: (() => void) | null = null;
  private demandCurrent: (() => boolean) | null = null;

  run(demanded: Signal<boolean>): Observable<IdentityLifetimeEvent> {
    return new Observable((subscriber) => {
      if (this.retry) throw new Error('Identity lifetime already owned.');
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
        condition: IdentityPresenceHealth['condition'],
        code: IdentityPresenceHealth['code'],
        preparation: IdentityPresenceHealth['preparation'],
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
      const attach = (): void => {
        const generation = this.current?.generation;
        ownsProjection = true;
        let failed = false;
        projection.add(
          defer(() => this.presence.runProjection()).subscribe({
            error: () => {
              failed = true;
              ownsProjection = false;
              publish('degraded', 'presence-ownership-released', 'failed');
            },
            complete: () => {
              failed = true;
              ownsProjection = false;
              publish('degraded', 'presence-ownership-released', 'failed');
            },
          }),
        );
        if (failed) return;
        observation.add(
          this.projections
            .observe('identity.presence', { kind: 'active-account' })
            .subscribe((state) => {
              if (
                generation !== this.current?.generation ||
                !ownsProjection ||
                !this.demandCurrent?.()
              )
                return;
              if (state.condition === 'available')
                publish('available', 'presence-ready', 'acknowledged');
              else if (state.condition === 'failed')
                publish('degraded', 'presence-reconciliation-failed', 'failed');
              else if (state.condition === 'released') {
                ownsProjection = false;
                publish('degraded', 'presence-ownership-released', 'failed');
              }
            }),
        );
        if (
          this.current?.condition === 'initializing' ||
          this.current?.condition === 'recovering'
        ) {
          watchdog = setTimeout(
            () => publish('degraded', 'presence-preparation-timeout', 'failed'),
            10_000,
          );
        }
      };
      const apply = (): void => {
        if (applying) return;
        const nextAccount = this.matrix.activeAccountId();
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
            publish('not-applicable', 'presence-not-demanded', 'acknowledged');
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
            capability: 'identity',
            operation: 'presence',
            demanded: required,
            preparation: required ? 'pending' : 'acknowledged',
            ownership: 'released',
            condition: required ? 'initializing' : 'not-applicable',
            code: required ? 'presence-preparing' : 'presence-not-demanded',
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
        accountId === this.matrix.activeAccountId() && required && demanded();
      this.retry = () => {
        disconnect();
        if (!this.current) return;
        this.current = { ...this.current, generation: ++this.generation };
        publish('recovering', 'presence-preparing', 'pending');
        attach();
      };
      apply();
      const changes = effect(
        () => {
          this.matrix.activeAccountId();
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
      ) {
        return of({ kind: 'unavailable' } as const);
      }
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
            timeout(10_000),
            catchError(() => of({ kind: 'failure' } as const)),
          )
          .subscribe(subscriber);
        this.retry?.();
        return () => observation.unsubscribe();
      });
    });
  }
}
