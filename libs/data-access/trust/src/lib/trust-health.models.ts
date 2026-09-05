import type { CapabilityHealthFact } from '@trinity/runtime/projection';

/** Trust owns stable producer codes; Application Runtime owns their presentation. */
export type TrustCapabilityHealth = CapabilityHealthFact<
  'trust',
  'projection',
  | 'trust-ready'
  | 'trust-preparing'
  | 'trust-dormant'
  | 'trust-reconciliation-failed'
  | 'trust-ownership-released'
  | 'trust-preparation-timeout'
>;
