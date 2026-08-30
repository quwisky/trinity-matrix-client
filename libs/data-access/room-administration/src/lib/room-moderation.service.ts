import { Injectable, inject } from '@angular/core';
import { Observable, defer, from, map, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import {
  recoverRoomAdministrationRequest,
  roomAdministrationNotSignedIn,
} from './room-administration-error';

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
  private readonly actionPermissions = inject(RoomActionPermissionsService);

  /** Remove a member from the room (they may rejoin if invited / it's public). Cold. */
  kick(roomId: string, userId: string, reason?: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => roomAdministrationNotSignedIn('kick-member'));
      }
      this.actionPermissions.assert(
        this.actionPermissions.member(roomId, userId).kick,
      );
      return from(this.matrix.instance.kick(roomId, userId, reason)).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('kick-member'),
      );
    });
  }

  /** Ban a member (they cannot rejoin until unbanned). Cold — runs on subscribe. */
  ban(roomId: string, userId: string, reason?: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => roomAdministrationNotSignedIn('ban-member'));
      }
      this.actionPermissions.assert(
        this.actionPermissions.member(roomId, userId).ban,
      );
      return from(this.matrix.instance.ban(roomId, userId, reason)).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('ban-member'),
      );
    });
  }

  /** Lift a member's ban so they may be re-invited / rejoin. Cold — runs on subscribe. */
  unban(roomId: string, userId: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => roomAdministrationNotSignedIn('unban-member'));
      }
      this.actionPermissions.assert(
        this.actionPermissions.unban(roomId, userId),
      );
      return from(this.matrix.instance.unban(roomId, userId)).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('unban-member'),
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
        return throwError(() =>
          roomAdministrationNotSignedIn('report-message'),
        );
      }
      return from(
        this.matrix.instance.reportEvent(roomId, eventId, -100, reason),
      ).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('report-message'),
      );
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
        return throwError(() =>
          roomAdministrationNotSignedIn('set-power-level'),
        );
      }
      this.actionPermissions.assert(
        this.actionPermissions.role(roomId, userId, level),
      );
      return from(
        this.matrix.instance.setPowerLevel(roomId, userId, level),
      ).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('set-power-level'),
      );
    });
  }

  /**
   * Whether the current user may kick / ban `targetUserId` in `roomId`: they must
   * out-rank the target and meet the room's kick / ban power requirement. You can never
   * kick or ban yourself here (leaving is a separate action).
   */
  canModerate(roomId: string, targetUserId: string): ModerationCaps {
    const permissions = this.actionPermissions.member(roomId, targetUserId);
    return {
      kick: permissions.kick.available,
      ban: permissions.ban.available,
      setPower: permissions.setPower.available,
      myPower: permissions.myPower,
    };
  }
}
