import { Injectable, inject } from '@angular/core';
import {
  HostBadgeService,
  HostUpdatesService,
  type HostCapabilitySupport,
  type HostOperationOutcome,
} from '@trinity/runtime/host';
import type {
  CapabilityContext,
  CapabilityHealthFact,
  CapabilityRecoveryOutcome,
} from '@trinity/runtime/projection';
import { Observable, catchError, defer, map, of } from 'rxjs';
import { CapabilityHealthService } from '../capability-health.service';

type HostHealthOperation = 'badge:support' | 'updates:check';

/** Application policy for finite Host outcomes; live stream ownership stays in the session. */
@Injectable({ providedIn: 'root' })
export class HostSessionHealthService {
  private readonly health = inject(CapabilityHealthService);
  private readonly badge = inject(HostBadgeService);
  private readonly updates = inject(HostUpdatesService);
  private readonly contexts = new Map<string, CapabilityContext>();
  private readonly generations = new Map<HostHealthOperation, number>();

  badgeSupport(support: HostCapabilitySupport): void {
    this.reportSupport('badge:support', support);
  }

  /** True means the caller should present contextual feedback for this write only. */
  badgeWrite(outcome: HostOperationOutcome): boolean {
    if (outcome.kind === 'completed') return false;
    if (outcome.kind === 'unavailable') {
      this.badgeSupport(outcome);
      return false;
    }
    this.health.incident({
      context: this.context('badge:support'),
      capability: 'badge',
      operation: 'write',
      code: 'badge-write-failed',
    });
    return true;
  }

  checkUpdates(): Observable<void> {
    return defer(() => this.updates.check()).pipe(
      map((outcome) => {
        this.reportUpdate(outcome);
      }),
      catchError(() => {
        this.reportUpdate({
          kind: 'rejected',
          diagnostic: { code: 'update-check-failed' },
        });
        return of(void 0);
      }),
    );
  }

  incident(
    capability: 'host' | 'workspace',
    operation: string,
    code: string,
  ): void {
    this.health.incident({
      context: this.context(`${capability}:${operation}`),
      capability,
      operation,
      code,
    });
  }

  private reportSupport(
    key: Extract<HostHealthOperation, 'badge:support'>,
    support: HostCapabilitySupport,
  ): void {
    const available = support.kind === 'supported';
    const expected =
      support.kind === 'unavailable' &&
      (support.reason === 'not-supported' ||
        support.reason === 'not-implemented');
    this.report(
      key,
      available ? 'available' : expected ? 'not-applicable' : 'degraded',
      available
        ? 'badge-ready'
        : expected
          ? 'badge-unsupported'
          : 'badge-support-unavailable',
      () =>
        this.badge.support().pipe(
          map((next): CapabilityRecoveryOutcome => {
            this.reportSupport(key, next);
            return next.kind === 'supported'
              ? { kind: 'success' }
              : next.reason === 'not-supported' ||
                  next.reason === 'not-implemented'
                ? { kind: 'unavailable' }
                : { kind: 'failure' };
          }),
          catchError(() => of({ kind: 'failure' } as const)),
        ),
    );
  }

  private reportUpdate(outcome: HostOperationOutcome): void {
    const available = outcome.kind === 'completed';
    const expected =
      outcome.kind === 'unavailable' &&
      (outcome.reason === 'not-supported' ||
        outcome.reason === 'not-implemented');
    this.report(
      'updates:check',
      available ? 'available' : expected ? 'not-applicable' : 'degraded',
      available
        ? 'update-check-ready'
        : expected
          ? 'updates-unsupported'
          : 'update-check-failed',
      () =>
        this.checkUpdates().pipe(
          map((): CapabilityRecoveryOutcome => {
            const current = this.healthFor('updates:check');
            return current?.condition === 'available'
              ? { kind: 'success' }
              : current?.condition === 'not-applicable'
                ? { kind: 'unavailable' }
                : { kind: 'failure' };
          }),
        ),
    );
  }

  private report(
    key: HostHealthOperation,
    condition: CapabilityHealthFact['condition'],
    code: string,
    recovery: () => Observable<CapabilityRecoveryOutcome>,
  ): void {
    const generation = (this.generations.get(key) ?? 0) + 1;
    this.generations.set(key, generation);
    const [capability, operation] = key.split(':') as [string, string];
    this.health.report(
      {
        capability,
        operation,
        context: this.context(key),
        generation,
        demanded: condition !== 'not-applicable',
        preparation: condition === 'degraded' ? 'failed' : 'acknowledged',
        ownership: 'released',
        condition,
        code,
      },
      () =>
        defer(() =>
          this.generations.get(key) === generation
            ? recovery()
            : of({ kind: 'unavailable' } as const),
        ),
    );
  }

  private context(key: string): CapabilityContext {
    const context = this.contexts.get(key) ?? Symbol();
    this.contexts.set(key, context);
    return context;
  }

  private healthFor(key: HostHealthOperation) {
    const [capability, operation] = key.split(':');
    return this.health
      .health()
      .find(
        (fact) =>
          fact.context === this.context(key) &&
          fact.capability === capability &&
          fact.operation === operation,
      );
  }
}
