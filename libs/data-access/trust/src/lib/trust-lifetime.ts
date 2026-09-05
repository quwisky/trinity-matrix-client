import type { TrustCapabilityHealth } from './trust-health.models';
import { Injectable, Injector, effect, inject, untracked } from '@angular/core';
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
import { TrustCryptoPort } from '@trinity/data-access/matrix-client';
import {
  ProjectionRuntime,
  type CapabilityContext,
  type CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import { TrustService } from './trust.service';
import { TrustVerificationService } from './trust-verification.service';

const PROJECTIONS = ['trust.health', 'crypto.verification-requests'] as const;
type TrustProjectionId = (typeof PROJECTIONS)[number];

export type TrustLifetimeEvent =
  | { readonly kind: 'prepared' }
  | { readonly kind: 'health'; readonly fact: TrustCapabilityHealth };

/** Trust projections and exact-scope recovery retained for one Application Runtime session. */
@Injectable({ providedIn: 'root' })
export class TrustLifetime {
  private readonly injector = inject(Injector);
  private readonly runtime = inject(ProjectionRuntime);
  private readonly crypto = inject(TrustCryptoPort);
  private readonly health = inject(TrustService);
  private readonly verification = inject(TrustVerificationService);
  private readonly changes = new Subject<TrustCapabilityHealth>();
  private generation = 0;
  private current: TrustCapabilityHealth | null = null;
  private retry: (() => void) | null = null;
  private accountCurrent: (() => boolean) | null = null;

  /** Attach on subscribe and release with the owning Application Runtime session. */
  run(): Observable<TrustLifetimeEvent> {
    return new Observable((subscriber) => {
      if (this.retry) throw new Error('Trust lifetime already owned.');
      const contexts = new Map<string, CapabilityContext>();
      const states = new Map<
        TrustProjectionId,
        'released' | 'reconciling' | 'failed' | 'available'
      >();
      let accountId: string | null = null;
      let prepared = false;
      let observations = new Subscription();
      let projections = new Subscription();
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      let ownsProjections = false;
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
        condition: TrustCapabilityHealth['condition'],
        code: TrustCapabilityHealth['code'],
        preparation: TrustCapabilityHealth['preparation'],
      ): void => {
        if (!this.current || subscriber.closed) return;
        this.current = {
          ...this.current,
          ownership: ownsProjections ? 'retained' : 'released',
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
      const evaluate = (): void => {
        if (!this.current || !ownsProjections) return;
        if (PROJECTIONS.some((id) => states.get(id) === 'released')) {
          ownsProjections = false;
          publish('degraded', 'trust-ownership-released', 'failed');
        } else if (PROJECTIONS.some((id) => states.get(id) === 'failed')) {
          publish('degraded', 'trust-reconciliation-failed', 'failed');
        } else if (PROJECTIONS.every((id) => states.get(id) === 'available')) {
          publish('available', 'trust-ready', 'acknowledged');
        }
      };
      const disconnect = (): void => {
        clearWatchdog();
        observations.unsubscribe();
        observations = new Subscription();
        projections.unsubscribe();
        projections = new Subscription();
        ownsProjections = false;
        states.clear();
      };
      const ownershipReleased = (): void => {
        if (!ownsProjections) return;
        ownsProjections = false;
        publish('degraded', 'trust-ownership-released', 'failed');
      };
      const observe = (id: TrustProjectionId): void => {
        observations.add(
          this.runtime
            .observe(id, { kind: 'active-account' })
            .subscribe((state) => {
              if (!this.accountCurrent?.() || !ownsProjections) return;
              states.set(id, state.condition);
              evaluate();
            }),
        );
      };
      const armWatchdog = (): void => {
        clearWatchdog();
        watchdog = setTimeout(
          () => publish('degraded', 'trust-preparation-timeout', 'failed'),
          10_000,
        );
      };
      const attach = (): void => {
        ownsProjections = true;
        for (const id of PROJECTIONS) states.set(id, 'reconciling');
        projections.add(
          defer(() => this.health.runProjection()).subscribe({
            error: ownershipReleased,
            complete: ownershipReleased,
          }),
        );
        if (!ownsProjections) return;
        projections.add(
          defer(() => this.verification.runProjection()).subscribe({
            error: ownershipReleased,
            complete: ownershipReleased,
          }),
        );
        if (!ownsProjections) return;
        for (const id of PROJECTIONS) observe(id);
        if (
          this.current?.condition === 'initializing' ||
          this.current?.condition === 'recovering'
        )
          armWatchdog();
      };
      const apply = (): void => {
        if (applying) return;
        const nextAccount = this.crypto.activeAccountId();
        if (nextAccount === accountId && this.current) return;
        applying = true;
        try {
          if (this.current)
            publish('not-applicable', 'trust-dormant', 'acknowledged');
          disconnect();
          accountId = nextAccount;
          const demanded = accountId !== null;
          const key = accountId ?? '';
          let context = contexts.get(key);
          if (!context) {
            context = Symbol();
            contexts.set(key, context);
          }
          this.current = {
            context,
            generation: ++this.generation,
            capability: 'trust',
            operation: 'projection',
            demanded,
            preparation: demanded ? 'pending' : 'acknowledged',
            ownership: 'released',
            condition: demanded ? 'initializing' : 'not-applicable',
            code: demanded ? 'trust-preparing' : 'trust-dormant',
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

      this.accountCurrent = () =>
        accountId !== null && accountId === this.crypto.activeAccountId();
      this.retry = () => {
        if (!this.current || !this.accountCurrent?.()) return;
        const retained = this.current.ownership === 'retained';
        const retryable = PROJECTIONS.filter(
          (id) => states.get(id) !== 'available',
        );
        if (!retained) disconnect();
        this.current = { ...this.current, generation: ++this.generation };
        publish('recovering', 'trust-preparing', 'pending');
        armWatchdog();
        if (!retained) {
          attach();
        } else {
          if (retryable.includes('trust.health')) this.health.retryProjection();
          if (retryable.includes('crypto.verification-requests'))
            this.verification.retryProjection();
        }
      };
      apply();
      const accountChanges = effect(
        () => {
          this.crypto.activeAccountId();
          untracked(apply);
        },
        { injector: this.injector },
      );
      return () => {
        accountChanges.destroy();
        this.retry = null;
        this.accountCurrent = null;
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
        !this.accountCurrent?.() ||
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
