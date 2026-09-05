import type { CapabilityHealthFact } from '@trinity/runtime/projection';

export type RoomAdministrationOperation = 'permissions' | 'members' | 'bans';

export type RoomAdministrationHealth = CapabilityHealthFact<
  'room-administration',
  RoomAdministrationOperation,
  | 'room-administration-preparing'
  | 'room-administration-ready'
  | 'room-administration-not-demanded'
  | 'room-administration-reconciliation-failed'
  | 'room-administration-ownership-released'
  | 'room-administration-preparation-timeout'
>;

export type RoomAdministrationLifetimeEvent =
  | { readonly kind: 'prepared' }
  | { readonly kind: 'health'; readonly fact: RoomAdministrationHealth };

export type RoomAdministrationAvailability =
  'coherent' | 'stale' | 'unavailable';

/**
 * A projection-backed value whose authority is explicit.
 *
 * Stale data is deliberately separate from `current`, so a command cannot accidentally
 * treat a retained informational snapshot as current authorization.
 */
export type RoomAdministrationView<T> =
  | {
      readonly availability: 'coherent';
      readonly current: T;
      readonly stale: null;
    }
  | {
      readonly availability: 'stale';
      readonly current: null;
      readonly stale: T;
    }
  | {
      readonly availability: 'unavailable';
      readonly current: null;
      readonly stale: null;
    };
