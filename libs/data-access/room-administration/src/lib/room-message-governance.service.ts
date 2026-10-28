import { Injectable, inject } from '@angular/core';
import { AdministeredRoomStore } from './administered-room.store';
import { mayAct, mayRedactEvent, maySendEvent } from './room-power';

export interface RoomMessageGovernanceKey {
  readonly accountId: string;
  readonly roomId: string;
}

/** A message the timeline holds, named by its sender. */
export interface RoomMessageRedactionRequest extends RoomMessageGovernanceKey {
  readonly senderId: string;
}

export type RoomMessageRedactionDecision =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'rejected';
      readonly failure: 'conversation-unavailable' | 'not-allowed';
    };

/** Room Administration's message-governance decisions over the administered room. */
@Injectable({ providedIn: 'root' })
export class RoomMessageGovernanceService {
  private readonly store = inject(AdministeredRoomStore);

  canRedactOthers(key: RoomMessageGovernanceKey): boolean {
    const room = this.store.room(key.accountId, key.roomId);
    return (
      !!room &&
      maySendEvent(room.powerLevels, room.ownPower, 'm.room.redaction') &&
      mayAct(room.powerLevels, room.ownPower, 'redact')
    );
  }

  canSendMessages(key: RoomMessageGovernanceKey): boolean {
    const room = this.store.room(key.accountId, key.roomId);
    return (
      !!room && maySendEvent(room.powerLevels, room.ownPower, 'm.room.message')
    );
  }

  authorizeRedaction(
    request: RoomMessageRedactionRequest,
  ): RoomMessageRedactionDecision {
    const room = this.store.room(request.accountId, request.roomId);
    if (!room) return { kind: 'rejected', failure: 'conversation-unavailable' };
    return mayRedactEvent(
      room.powerLevels,
      room.ownPower,
      room.ownMembership,
      request.senderId === room.ownUserId,
    )
      ? { kind: 'allowed' }
      : { kind: 'rejected', failure: 'not-allowed' };
  }
}
