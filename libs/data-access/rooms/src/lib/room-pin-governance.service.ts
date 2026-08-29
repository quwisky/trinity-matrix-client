import { Injectable, inject } from '@angular/core';
import { EventType } from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { liveRoomState } from '@trinity/util/matrix';

export interface RoomPinGovernanceKey {
  readonly accountId: string;
  readonly roomId: string;
}

export type RoomPinGovernanceOperation = 'pin' | 'unpin';

export type RoomPinDecision =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'rejected';
      readonly failure:
        'conversation-unavailable' | 'message-unavailable' | 'not-allowed';
    };

/** Matrix adapter for Room Administration's pinned-message governance. */
@Injectable({ providedIn: 'root' })
export class RoomPinGovernanceService {
  private readonly matrix = inject(MatrixClientService);

  canMutate(key: RoomPinGovernanceKey): boolean {
    const context = this.context(key);
    return Boolean(
      context &&
      liveRoomState(context.room)?.maySendStateEvent(
        EventType.RoomPinnedEvents,
        context.userId,
      ),
    );
  }

  authorize(
    key: RoomPinGovernanceKey,
    operation: RoomPinGovernanceOperation,
    eventId: string,
  ): RoomPinDecision {
    const context = this.context(key);
    if (!context) {
      return { kind: 'rejected', failure: 'conversation-unavailable' };
    }
    // Pinning must name a message this exact Conversation can resolve. Unpinning is
    // intentionally allowed for an unloaded/redacted event so stale state can still
    // be repaired instead of trapping an unremovable id in m.room.pinned_events.
    if (operation === 'pin' && !context.room.findEventById(eventId)) {
      return { kind: 'rejected', failure: 'message-unavailable' };
    }
    return this.canMutate(key)
      ? { kind: 'allowed' }
      : { kind: 'rejected', failure: 'not-allowed' };
  }

  private context(key: RoomPinGovernanceKey) {
    const client = this.matrix.clientFor(key.accountId);
    const room = client?.getRoom(key.roomId) ?? null;
    const userId = client?.getUserId() ?? null;
    return room && userId ? { room, userId } : null;
  }
}
