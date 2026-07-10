import { Injectable, inject } from '@angular/core';
import { EventType } from 'matrix-js-sdk';
import { Observable, defer, from, map, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

/** Which moderation actions the current user may take against a specific member. */
export interface ModerationCaps {
  kick: boolean;
  ban: boolean;
  /** Whether the viewer may change this member's power level. */
  setPower: boolean;
  /** The viewer's own power level — caps the roles they can assign. */
  myPower: number;
}

/**
 * Room moderation actions against a member — kick and ban — plus the power-level check
 * that gates them. Writes are cold Observables (fire on subscribe); the synced client
 * reflects the membership change through its listeners, so no manual refresh is needed.
 */
@Injectable({ providedIn: 'root' })
export class RoomModerationService {
  private readonly matrix = inject(MatrixClientService);

  /** Remove a member from the room (they may rejoin if invited / it's public). Cold. */
  kick(roomId: string, userId: string, reason?: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(this.matrix.instance.kick(roomId, userId, reason)).pipe(
        map(() => void 0),
      );
    });
  }

  /** Ban a member (they cannot rejoin until unbanned). Cold — runs on subscribe. */
  ban(roomId: string, userId: string, reason?: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(this.matrix.instance.ban(roomId, userId, reason)).pipe(
        map(() => void 0),
      );
    });
  }

  /**
   * Report a message to the room's server admins (`reportEvent`, MSC/CS report API),
   * with a reason. Score -100 flags it as the most offensive. Cold — runs on subscribe.
   */
  reportMessage(
    roomId: string,
    eventId: string,
    reason: string,
  ): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.matrix.instance.reportEvent(roomId, eventId, -100, reason),
      ).pipe(map(() => void 0));
    });
  }

  /** Set a member's power level in the room (promote / demote). Cold. */
  setPowerLevel(
    roomId: string,
    userId: string,
    level: number,
  ): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.matrix.instance.setPowerLevel(roomId, userId, level),
      ).pipe(map(() => void 0));
    });
  }

  /**
   * Whether the current user may kick / ban `targetUserId` in `roomId`: they must
   * out-rank the target and meet the room's kick / ban power requirement. You can never
   * kick or ban yourself here (leaving is a separate action).
   */
  canModerate(roomId: string, targetUserId: string): ModerationCaps {
    const deny: ModerationCaps = {
      kick: false,
      ban: false,
      setPower: false,
      myPower: 0,
    };
    if (!this.matrix.isInitialized) {
      return deny;
    }
    const client = this.matrix.instance;
    const room = client.getRoom(roomId);
    const me = client.getUserId();
    if (!room || !me || targetUserId === me) {
      return deny;
    }
    const myLevel = room.getMember(me)?.powerLevel ?? 0;
    const targetLevel = room.getMember(targetUserId)?.powerLevel ?? 0;
    // Must strictly out-rank the target to act on them.
    if (myLevel <= targetLevel) {
      return { ...deny, myPower: myLevel };
    }
    const state = room.currentState;
    return {
      kick: state.hasSufficientPowerLevelFor('kick', myLevel),
      ban: state.hasSufficientPowerLevelFor('ban', myLevel),
      setPower: state.maySendStateEvent(EventType.RoomPowerLevels, me),
      myPower: myLevel,
    };
  }
}
