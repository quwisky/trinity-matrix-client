import { Injectable, signal } from '@angular/core';
import {
  Observable,
  Subject,
  Subscription,
  defer,
  distinctUntilChanged,
  map,
  startWith,
} from 'rxjs';
import type {
  ProjectionDefinition,
  ProjectionLease,
  ProjectionReadiness,
  ProjectionResources,
  ProjectionRuntimeDiagnostics,
  ProjectionScope,
} from './projection-runtime.models';

interface ProjectionEntry {
  readonly key: string;
  readonly definition: ProjectionDefinition;
  generation: number;
  acknowledgedGeneration: number;
  active: boolean;
  scheduled: boolean;
  reconciliation: ReconciliationAttempt | null;
  detach: () => void;
  failure: { readonly generation: number; readonly error: unknown } | null;
}

interface ReconciliationAttempt {
  readonly generation: number;
  readonly startedAt: number;
  readonly subscription: Subscription;
  settled: boolean;
}

interface RetirementOptions {
  readonly announceChange: boolean;
}

const EMPTY_RESOURCES: ProjectionResources = {
  listenerCount: 0,
  retainedBytes: 0,
};

const INITIAL_DIAGNOSTICS: ProjectionRuntimeDiagnostics = {
  activeProjections: 0,
  listenerCount: 0,
  retainedBytes: 0,
  reconciliations: 0,
  reconcileDurationMs: 0,
  completedBarriers: 0,
  lastBarrierDurationMs: null,
};

/**
 * Owns projection lifecycle without owning product state or an event bus.
 *
 * A concrete adapter supplies one authoritative read and its invalidation listeners.
 * The runtime coalesces bursts, cancels replaced work, rejects stale generation
 * publishes, resets on release, and exposes a finite readiness barrier.
 */
@Injectable({ providedIn: 'root' })
export class ProjectionRuntime {
  private readonly entries = new Map<string, ProjectionEntry>();
  private readonly runtimeChanges = new Subject<void>();
  private readonly runtimeDiagnostics = signal(INITIAL_DIAGNOSTICS);
  private nextGeneration = 0;
  private reconciliations = 0;
  private reconcileDurationMs = 0;
  private completedBarriers = 0;
  private lastBarrierDurationMs: number | null = null;

  readonly diagnostics = this.runtimeDiagnostics.asReadonly();

  activate(definition: ProjectionDefinition): ProjectionLease {
    const key = projectionKey(definition.id, definition.scope);
    const previous = this.entries.get(key);
    if (previous) {
      try {
        this.retire(previous, { announceChange: false });
      } catch (error: unknown) {
        this.announceRuntimeChange();
        throw error;
      }
    }

    const entry: ProjectionEntry = {
      key,
      definition,
      generation: ++this.nextGeneration,
      acknowledgedGeneration: 0,
      active: true,
      scheduled: false,
      reconciliation: null,
      detach: () => undefined,
      failure: null,
    };
    this.entries.set(key, entry);

    try {
      entry.detach =
        definition.attach(() => this.invalidate(entry)) ?? (() => undefined);
      this.reconcile(entry);
    } catch (error: unknown) {
      this.retireAfterActivationFailure(entry, error);
    }
    this.announceRuntimeChange();

    return {
      invalidate: () => this.invalidate(entry),
      release: () => {
        if (this.entries.get(key) === entry) {
          this.retire(entry, { announceChange: true });
        }
      },
    };
  }

  /**
   * Reattach every live projection in `scope`, then acknowledge their new generations.
   *
   * Account switching uses this after committing the new Active Account. Attachment
   * callbacks resolve their authoritative source at reattach time, so no caller has to
   * know which listeners or read models participate in the transition.
   */
  transition(scope: ProjectionScope): Observable<ProjectionReadiness> {
    return defer(() => {
      for (const entry of this.entries.values()) {
        if (sameScope(entry.definition.scope, scope)) {
          this.reattach(entry);
        }
      }
      this.announceRuntimeChange();
      return this.waitFor(scope);
    });
  }

  /** Observe current reconciliation without taking ownership or exposing adapter errors. */
  observe(
    id: string,
    scope: ProjectionScope,
  ): Observable<ProjectionObservation> {
    return this.runtimeChanges.pipe(
      startWith(undefined),
      map((): ProjectionObservation => {
        const entry = this.entries.get(projectionKey(id, scope));
        if (!entry) return { condition: 'released', generation: 0 };
        return {
          generation: entry.generation,
          condition: entry.failure
            ? 'failed'
            : entry.acknowledgedGeneration === entry.generation
              ? 'available'
              : 'reconciling',
        };
      }),
      distinctUntilChanged(
        (left, right) =>
          left.condition === right.condition &&
          left.generation === right.generation,
      ),
    );
  }

  /**
   * Wait for the current generations in `scope`.
   *
   * A capability-owned lifetime can name its projections so an unrelated
   * sibling failure cannot poison its readiness barrier.
   */
  waitFor(
    scope: ProjectionScope,
    projectionIds?: readonly string[],
  ): Observable<ProjectionReadiness> {
    return defer(
      () =>
        new Observable<ProjectionReadiness>((subscriber) => {
          const startedAt = performance.now();
          const includedIds = projectionIds
            ? new Set(projectionIds)
            : undefined;
          const keys = [...this.entries.values()]
            .filter(
              (entry) =>
                sameScope(entry.definition.scope, scope) &&
                (!includedIds || includedIds.has(entry.definition.id)),
            )
            .map((entry) => entry.key);
          let finished = false;

          const evaluate = (): void => {
            if (finished) return;
            const entries = keys
              .map((key) => this.entries.get(key))
              .filter((entry): entry is ProjectionEntry => entry !== undefined);
            const failed = entries.find(
              (entry) => entry.failure?.generation === entry.generation,
            );
            if (failed?.failure) {
              finished = true;
              subscriber.error(failed.failure.error);
              return;
            }
            if (
              entries.some(
                (entry) => entry.acknowledgedGeneration !== entry.generation,
              )
            ) {
              return;
            }

            const resources = sumResources(entries);
            const durationMs = performance.now() - startedAt;
            const result: ProjectionReadiness = {
              scope,
              durationMs,
              projectionCount: entries.length,
              ...resources,
              acknowledgements: entries.map((entry) => ({
                projectionId: entry.definition.id,
                generation: entry.generation,
              })),
            };
            finished = true;
            this.completedBarriers += 1;
            this.lastBarrierDurationMs = durationMs;
            this.publishDiagnostics();
            subscriber.next(result);
            subscriber.complete();
          };

          const runtimeChangeSubscription =
            this.runtimeChanges.subscribe(evaluate);
          evaluate();
          return () => runtimeChangeSubscription.unsubscribe();
        }),
    );
  }

  private invalidate(entry: ProjectionEntry): void {
    if (this.entries.get(entry.key) !== entry) return;
    entry.generation = ++this.nextGeneration;
    entry.failure = null;
    this.cancelReconciliation(entry);
    this.announceRuntimeChange();
    this.schedule(entry);
  }

  private reattach(entry: ProjectionEntry): void {
    entry.scheduled = false;
    this.cancelReconciliation(entry);
    entry.generation = ++this.nextGeneration;
    entry.acknowledgedGeneration = 0;
    entry.failure = null;

    try {
      entry.detach();
      entry.definition.reset();
      entry.detach =
        entry.definition.attach(() => this.invalidate(entry)) ??
        (() => undefined);
      this.reconcile(entry);
    } catch (error: unknown) {
      entry.detach = () => undefined;
      entry.failure = { generation: entry.generation, error };
    }
  }

  private schedule(entry: ProjectionEntry): void {
    if (!entry.active || entry.reconciliation || entry.scheduled) return;
    entry.scheduled = true;
    queueMicrotask(() => {
      if (!entry.scheduled) return;
      entry.scheduled = false;
      this.reconcile(entry);
    });
  }

  private reconcile(entry: ProjectionEntry): void {
    if (!entry.active || entry.reconciliation) return;
    entry.scheduled = false;
    const generation = entry.generation;
    const attempt: ReconciliationAttempt = {
      generation,
      startedAt: performance.now(),
      subscription: new Subscription(),
      settled: false,
    };
    entry.reconciliation = attempt;
    const context = {
      generation,
      publish: (commit: () => void): boolean => {
        if (
          this.entries.get(entry.key) !== entry ||
          entry.generation !== generation
        ) {
          return false;
        }
        commit();
        return true;
      },
    };

    let reconciliation: Observable<void>;
    try {
      reconciliation = entry.definition.reconcile(context);
    } catch (error: unknown) {
      this.finishReconciliation(entry, attempt, { error });
      return;
    }

    attempt.subscription.add(
      reconciliation.subscribe({
        complete: () => this.finishReconciliation(entry, attempt, null),
        error: (error: unknown) =>
          this.finishReconciliation(entry, attempt, { error }),
      }),
    );
  }

  private finishReconciliation(
    entry: ProjectionEntry,
    attempt: ReconciliationAttempt,
    failure: { readonly error: unknown } | null,
  ): void {
    if (attempt.settled) return;
    attempt.settled = true;
    attempt.subscription.unsubscribe();
    if (entry.reconciliation === attempt) {
      entry.reconciliation = null;
    }
    this.recordReconciliation(attempt);
    if (!entry.active) return;

    if (entry.generation !== attempt.generation) {
      this.announceRuntimeChange();
      this.schedule(entry);
      return;
    }
    if (failure) {
      entry.failure = {
        generation: attempt.generation,
        error: failure.error,
      };
    } else {
      entry.acknowledgedGeneration = attempt.generation;
    }
    this.announceRuntimeChange();
  }

  private cancelReconciliation(entry: ProjectionEntry): void {
    const attempt = entry.reconciliation;
    if (!attempt || attempt.settled) return;
    attempt.settled = true;
    entry.reconciliation = null;
    attempt.subscription.unsubscribe();
    this.recordReconciliation(attempt);
  }

  private recordReconciliation(attempt: ReconciliationAttempt): void {
    this.reconciliations += 1;
    this.reconcileDurationMs += performance.now() - attempt.startedAt;
  }

  private retire(entry: ProjectionEntry, options: RetirementOptions): void {
    entry.active = false;
    entry.scheduled = false;
    this.cancelReconciliation(entry);
    if (this.entries.get(entry.key) === entry) {
      this.entries.delete(entry.key);
    }
    const failures: unknown[] = [];
    try {
      entry.detach();
    } catch (error: unknown) {
      failures.push(error);
    }
    try {
      entry.definition.reset();
    } catch (resetFailure: unknown) {
      failures.push(resetFailure);
    }
    if (options.announceChange) this.announceRuntimeChange();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'Projection detach and reset failed.');
    }
  }

  private retireAfterActivationFailure(
    entry: ProjectionEntry,
    activationFailure: unknown,
  ): never {
    try {
      this.retire(entry, { announceChange: true });
    } catch (cleanupFailure: unknown) {
      throw new AggregateError(
        [activationFailure, cleanupFailure],
        'Projection activation and cleanup failed.',
      );
    }
    throw activationFailure;
  }

  private announceRuntimeChange(): void {
    this.publishDiagnostics();
    this.runtimeChanges.next();
  }

  private publishDiagnostics(): void {
    const resources = sumResources([...this.entries.values()]);
    this.runtimeDiagnostics.set({
      activeProjections: this.entries.size,
      ...resources,
      reconciliations: this.reconciliations,
      reconcileDurationMs: this.reconcileDurationMs,
      completedBarriers: this.completedBarriers,
      lastBarrierDurationMs: this.lastBarrierDurationMs,
    });
  }
}

function projectionKey(id: string, scope: ProjectionScope): string {
  return `${id.length}:${id}:${scopeKey(scope)}`;
}

function sameScope(left: ProjectionScope, right: ProjectionScope): boolean {
  return scopeKey(left) === scopeKey(right);
}

function scopeKey(scope: ProjectionScope): string {
  switch (scope.kind) {
    case 'active-account':
      return 'active-account';
    case 'all-live-accounts':
      return 'all-live-accounts';
    case 'exact-account':
      return `exact-account:${scope.accountId.length}:${scope.accountId}`;
    case 'exact-conversation':
      return `exact-conversation:${scope.accountId.length}:${scope.accountId}:${scope.roomId.length}:${scope.roomId}`;
  }
}

function sumResources(
  entries: readonly ProjectionEntry[],
): ProjectionResources {
  return entries.reduce<ProjectionResources>((total, entry) => {
    const current = entry.definition.resources?.() ?? EMPTY_RESOURCES;
    return {
      listenerCount: total.listenerCount + current.listenerCount,
      retainedBytes: total.retainedBytes + current.retainedBytes,
    };
  }, EMPTY_RESOURCES);
}

export interface ProjectionObservation {
  readonly generation: number;
  readonly condition: 'released' | 'reconciling' | 'failed' | 'available';
}
