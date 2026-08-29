import { Injectable, inject } from '@angular/core';
import { EventType } from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { liveRoomState } from '@trinity/util/matrix';

export interface RoomMessageGovernanceKey {
  readonly accountId: string;
  readonly roomId: string;
}

export interface RoomMessageRedactionRequest extends RoomMessageGovernanceKey {
  readonly messageId: string;
}

export type RoomMessageRedactionDecision =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'rejected';
      readonly failure:
        'conversation-unavailable' | 'message-unavailable' | 'not-allowed';
    };

/** Matrix adapter for Room Administration's message-governance decisions. */
@Injectable({ providedIn: 'root' })
export class RoomMessageGovernanceService {
  private readonly matrix = inject(MatrixClientService);

  canRedactOthers(key: RoomMessageGovernanceKey): boolean {
    const context = this.context(key);
    if (!context) return false;
    const { room, userId } = context;
    const state = liveRoomState(room);
    const member = room.getMember(userId);
    return Boolean(
      state?.maySendEvent?.(EventType.RoomRedaction, userId) &&
      state?.hasSufficientPowerLevelFor?.('redact', member?.powerLevel ?? 0),
    );
  }

  authorizeRedaction(
    request: RoomMessageRedactionRequest,
  ): RoomMessageRedactionDecision {
    const context = this.context(request);
    if (!context) {
      return { kind: 'rejected', failure: 'conversation-unavailable' };
    }
    const event = context.room.findEventById(request.messageId);
    if (!event) return { kind: 'rejected', failure: 'message-unavailable' };
    return liveRoomState(context.room)?.maySendRedactionForEvent?.(
      event,
      context.userId,
    )
      ? { kind: 'allowed' }
      : { kind: 'rejected', failure: 'not-allowed' };
  }

  private context(key: RoomMessageGovernanceKey) {
    const client = this.matrix.clientFor(key.accountId);
    const room = client?.getRoom(key.roomId) ?? null;
    const userId = client?.getUserId() ?? null;
    return room && userId ? { room, userId } : null;
  }
}
