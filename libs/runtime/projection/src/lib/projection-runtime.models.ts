import type { Observable } from 'rxjs';

/** One frame budget for an in-process barrier after its projections acknowledge. */
export const PROJECTION_RUNTIME_BASELINE = {
  maxLocalBarrierDurationMs: 16,
} as const;

export type ProjectionScope =
  | { readonly kind: 'active-account' }
  | { readonly kind: 'all-live-accounts' }
  | { readonly kind: 'exact-account'; readonly accountId: string }
  | {
      readonly kind: 'exact-conversation';
      readonly accountId: string;
      readonly roomId: string;
    };

export interface ProjectionResources {
  readonly listenerCount: number;
  /** Deterministic retained payload size; not a JavaScript heap estimate. */
  readonly retainedBytes: number;
}

export interface ProjectionReconcileContext {
  readonly generation: number;
  /** Commit only while this reconciliation still belongs to the live generation. */
  publish(commit: () => void): boolean;
}

export interface ProjectionDefinition {
  readonly id: string;
  readonly scope: ProjectionScope;
  /** Attach invalidation sources and return their teardown. */
  readonly attach: (invalidate: () => void) => void | (() => void);
  /** Rebuild from the authoritative source; async work is generation-gated. */
  readonly reconcile: (context: ProjectionReconcileContext) => Observable<void>;
  /** Clear every read model value owned by this projection. */
  readonly reset: () => void;
  /** Current deterministic resource counts for diagnostics and baselines. */
  readonly resources?: () => ProjectionResources;
}

export interface ProjectionLease {
  /** Schedule a coalesced reconciliation in a fresh generation. */
  invalidate(): void;
  /** Detach, cancel queued work, and reset. Idempotent. */
  release(): void;
}

export interface ProjectionAcknowledgement {
  readonly projectionId: string;
  readonly generation: number;
}

export interface ProjectionReadiness {
  readonly scope: ProjectionScope;
  readonly durationMs: number;
  readonly projectionCount: number;
  readonly listenerCount: number;
  readonly retainedBytes: number;
  readonly acknowledgements: readonly ProjectionAcknowledgement[];
}

export interface ProjectionRuntimeDiagnostics {
  readonly activeProjections: number;
  readonly listenerCount: number;
  readonly retainedBytes: number;
  readonly reconciliations: number;
  readonly reconcileDurationMs: number;
  readonly completedBarriers: number;
  readonly lastBarrierDurationMs: number | null;
}
