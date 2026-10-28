import { Injectable, inject } from '@angular/core';
import { Observable, defer, map } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { type EngineResult, unwrapEngineResult } from '@trinity/util/matrix';
import { AdministeredRoomStore } from './administered-room.store';
import {
  RoomActionPermissionsService,
  type ActionAvailability,
  type RoomActionPermissionsKey,
} from './room-action-permissions.service';
import { ROOM_ADMINISTRATION_ENGINE } from './room-administration-engine.token';
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

type ModerationTarget = string | RoomActionPermissionsKey;

/**
 * Room moderation actions against a member — kick and ban — plus the power-level check
 * that gates them. Writes are cold Observables (fire on subscribe); the change arrives
 * through the engine's room and member subscriptions, so no manual refresh is needed.
 * A bare room ID acts as the active account.
 */
@Injectable({ providedIn: 'root' })
export class RoomModerationService {
  private readonly engine = inject(ROOM_ADMINISTRATION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly store = inject(AdministeredRoomStore);
  private readonly actionPermissions = inject(RoomActionPermissionsService);

  /** Remove a member from the room (they may rejoin if invited / it's public). Cold. */
  kick(
    target: ModerationTarget,
    userId: string,
    reason?: string,
  ): Observable<void> {
    return this.run(
      target,
      'kick-member',
      () => this.actionPermissions.member(target, userId).kick,
      (accountId, roomId) =>
        this.engine.kick(accountId, roomId, userId, reason ?? null),
    );
  }

  /** Ban a member (they cannot rejoin until unbanned). Cold — runs on subscribe. */
  ban(
    target: ModerationTarget,
    userId: string,
    reason?: string,
  ): Observable<void> {
    return this.run(
      target,
      'ban-member',
      () => this.actionPermissions.member(target, userId).ban,
      (accountId, roomId) =>
        this.engine.ban(accountId, roomId, userId, reason ?? null),
    );
  }

  /** Lift a member's ban so they may be re-invited / rejoin. Cold — runs on subscribe. */
  unban(target: ModerationTarget, userId: string): Observable<void> {
    return this.run(
      target,
      'unban-member',
      () => this.actionPermissions.unban(target, userId),
      (accountId, roomId) => this.engine.unban(accountId, roomId, userId),
    );
  }

  /**
   * Report a message to the reporter's server admins with a reason, as the account that
   * saw it. The engine flags it as the most offensive. Cold.
   */
  reportMessage(
    target: ModerationTarget,
    eventId: string,
    reason: string,
  ): Observable<void> {
    return this.run(target, 'report-message', null, (accountId, roomId) =>
      this.engine.reportEvent(accountId, roomId, eventId, reason),
    );
  }

  /** Set a member's power level in the room (promote / demote). Cold. */
  setPowerLevel(
    target: ModerationTarget,
    userId: string,
    level: number,
  ): Observable<void> {
    return this.run(
      target,
      'set-power-level',
      () => this.actionPermissions.role(target, userId, level),
      (accountId, roomId) => {
        // js-sdk `setPowerLevel`: the current content with this user's level replaced.
        const content = this.store.room(accountId, roomId)?.powerLevels ?? {};
        const users = content['users'];
        return this.engine.setState(
          accountId,
          roomId,
          'm.room.power_levels',
          '',
          {
            ...content,
            users: {
              ...(users && typeof users === 'object' && !Array.isArray(users)
                ? users
                : {}),
              [userId]: level,
            },
          },
        );
      },
    );
  }

  /**
   * Whether the current user may kick / ban `targetUserId` in `roomId`: they must
   * out-rank the target and meet the room's kick / ban power requirement. You can never
   * kick or ban yourself here (leaving is a separate action).
   */
  canModerate(target: ModerationTarget, targetUserId: string): ModerationCaps {
    const permissions = this.actionPermissions.member(target, targetUserId);
    return {
      kick: permissions.kick.available,
      ban: permissions.ban.available,
      setPower: permissions.setPower.available,
      myPower: permissions.myPower,
    };
  }

  /** One cold command after the signed-in and (when given) permission checks. */
  private run(
    target: ModerationTarget,
    operation: string,
    permission: (() => ActionAvailability) | null,
    send: (accountId: string, roomId: string) => Observable<EngineResult<null>>,
  ): Observable<void> {
    return defer(() => {
      const accountId =
        typeof target === 'string'
          ? this.session.activeAccountId()
          : target.accountId;
      if (!accountId || !this.session.status(accountId)) {
        throw roomAdministrationNotSignedIn(operation);
      }
      if (permission) this.actionPermissions.assert(permission());
      return send(
        accountId,
        typeof target === 'string' ? target : target.roomId,
      );
    }).pipe(
      unwrapEngineResult(),
      map(() => void 0),
      recoverRoomAdministrationRequest(operation),
    );
  }
}
