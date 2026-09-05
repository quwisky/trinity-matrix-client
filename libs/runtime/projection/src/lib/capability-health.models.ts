import type { Observable } from 'rxjs';

/** Internal identity only: never a Matrix identifier or a diagnostic reference. */
export type CapabilityContext = symbol;
export type CapabilityCondition =
  | 'initializing'
  | 'available'
  | 'waiting-for-precondition'
  | 'disabled'
  | 'not-applicable'
  | 'degraded'
  | 'blocked'
  | 'recovering';

/** Producer facts; application policy determines consequence and severity. */
export interface CapabilityHealthFact<
  Capability extends string = string,
  Operation extends string = string,
  Code extends string = string,
> {
  readonly capability: Capability;
  readonly operation: Operation;
  readonly context: CapabilityContext;
  readonly generation: number;
  readonly demanded: boolean;
  readonly preparation: 'pending' | 'acknowledged' | 'failed';
  readonly ownership: 'retained' | 'released';
  readonly condition: CapabilityCondition;
  readonly code: Code;
}

export type CapabilityRecoveryOutcome =
  | { readonly kind: 'pending' }
  | { readonly kind: 'success' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'transition-in-progress' }
  | { readonly kind: 'failure' }
  | { readonly kind: 'partial' };

export type CapabilityRecovery = () => Observable<CapabilityRecoveryOutcome>;

/** Contextual incidents do not implicitly alter persistent capability health. */
export interface CapabilityIncident<
  Capability extends string = string,
  Operation extends string = string,
  Code extends string = string,
> {
  readonly context: CapabilityContext;
  readonly capability: Capability;
  readonly operation: Operation;
  readonly code: Code;
}
