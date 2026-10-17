import type { CapabilityHealthFact } from '@trinity/runtime/projection';

/** A degraded, retained, demanded, failed-preparation fact; override what a test reads. */
export function healthFact<
  Capability extends string,
  Operation extends string,
  Code extends string,
>(
  over: Partial<CapabilityHealthFact<Capability, Operation, Code>> &
    Pick<
      CapabilityHealthFact<Capability, Operation, Code>,
      'capability' | 'operation' | 'context' | 'code'
    >,
): CapabilityHealthFact<Capability, Operation, Code> {
  return {
    generation: 1,
    demanded: true,
    preparation: 'failed',
    ownership: 'retained',
    condition: 'degraded',
    ...over,
  };
}
