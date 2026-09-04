import { InjectionToken } from '@angular/core';

/** Relationship mutations whose authorization is owned by Room Administration. */
export type RoomLibraryGovernanceAction = 'invite' | 'curate-space';

/** A synchronous decision from the latest authoritative Room state. */
export type RoomLibraryGovernanceDecision =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'rejected'; readonly reason: string };

export interface RoomLibraryGovernanceKey {
  readonly accountId: string;
  readonly roomId: string;
}

/**
 * Narrow policy interface consumed by Room Library.
 *
 * The application composes the Room Administration adapter. Keeping this interface in
 * Room Library makes relationship ownership independent of the governance implementation.
 */
export interface RoomLibraryGovernancePolicy {
  authorize(
    key: RoomLibraryGovernanceKey,
    action: RoomLibraryGovernanceAction,
  ): RoomLibraryGovernanceDecision;
}

export const ROOM_LIBRARY_GOVERNANCE_POLICY =
  new InjectionToken<RoomLibraryGovernancePolicy>(
    'ROOM_LIBRARY_GOVERNANCE_POLICY',
  );

export class RoomLibraryGovernanceError extends Error {
  constructor(
    readonly decision: Extract<
      RoomLibraryGovernanceDecision,
      { kind: 'rejected' }
    >,
  ) {
    super(decision.reason);
    this.name = 'RoomLibraryGovernanceError';
  }
}

/** Throw the policy rejection from inside a cold Room Library command. */
export function assertRoomLibraryGovernance(
  decision: RoomLibraryGovernanceDecision,
): void {
  if (decision.kind === 'rejected') {
    throw new RoomLibraryGovernanceError(decision);
  }
}
