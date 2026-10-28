import { Injectable, inject } from '@angular/core';
import { AdministeredRoomStore } from './administered-room.store';
import { maySendState } from './room-power';

export interface RoomPinGovernanceKey {
  readonly accountId: string;
  readonly roomId: string;
}

export type RoomPinDecision =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'rejected';
      readonly failure: 'conversation-unavailable' | 'not-allowed';
    };

/** Room Administration's pinned-message governance over the administered room. */
@Injectable({ providedIn: 'root' })
export class RoomPinGovernanceService {
  private readonly store = inject(AdministeredRoomStore);

  canMutate(key: RoomPinGovernanceKey): boolean {
    return this.authorize(key).kind === 'allowed';
  }

  /** Pinning and unpinning alike; the timeline checks that a message to pin exists. */
  authorize(key: RoomPinGovernanceKey): RoomPinDecision {
    const room = this.store.room(key.accountId, key.roomId);
    if (!room) return { kind: 'rejected', failure: 'conversation-unavailable' };
    return maySendState(room.powerLevels, room.ownPower, 'm.room.pinned_events')
      ? { kind: 'allowed' }
      : { kind: 'rejected', failure: 'not-allowed' };
  }
}
