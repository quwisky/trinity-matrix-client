import type {
  CapabilityHealthFact,
  CapabilityIncident,
} from '@trinity/runtime/projection';

/** Identity owns its stable producer codes; the application owns their presentation. */
export type IdentityPresenceHealth = CapabilityHealthFact<
  'identity',
  'presence',
  | 'presence-ready'
  | 'presence-preparing'
  | 'presence-not-demanded'
  | 'presence-reconciliation-failed'
  | 'presence-ownership-released'
  | 'presence-preparation-timeout'
  | 'presence-recovery-failed'
>;

export type IdentityPresenceIncident = CapabilityIncident<
  'identity',
  'presence',
  'presence-command-failed'
>;
