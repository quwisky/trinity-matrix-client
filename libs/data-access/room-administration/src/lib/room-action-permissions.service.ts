import { Injectable, inject, signal } from '@angular/core';
import {
  EventType,
  KnownMembership,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  RoomStateEvent,
} from 'matrix-js-sdk';
import {
  MatrixClientService,
  projectFromClient,
} from '@trinity/data-access/matrix-client';
import { liveRoomState } from '@trinity/util/matrix';
import type { Observable } from 'rxjs';
import { RoomAdministrationError } from './room-administration-error';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';

export interface ActionAvailability {
  readonly available: boolean;
  readonly reason: string | null;
}

export interface RoomActionPermissions {
  readonly invite: ActionAvailability;
  readonly curateSpace: ActionAvailability;
}

export interface RoomActionPermissionsKey {
  readonly accountId: string;
  readonly roomId: string;
}

/** Live authorization for every state-backed field in room and space settings. */
export interface RoomSettingsPermissions {
  readonly name: ActionAvailability;
  readonly topic: ActionAvailability;
  readonly avatar: ActionAvailability;
  readonly joinRule: ActionAvailability;
  readonly history: ActionAvailability;
  readonly aliases: ActionAvailability;
}

export interface MemberActionPermissions {
  readonly kick: ActionAvailability;
  readonly ban: ActionAvailability;
  readonly setPower: ActionAvailability;
  readonly myPower: number;
  readonly targetPower: number;
}

export class RoomActionPermissionError extends RoomAdministrationError {
  constructor(readonly availability: ActionAvailability) {
    super(
      {
        kind: 'rejected',
        failure: 'permission-denied',
        recovery: 'refresh-authority',
        operation: 'authorize-room-action',
      },
      availability.reason ?? 'This room action is unavailable.',
    );
    this.name = 'RoomActionPermissionError';
  }
}

interface PermissionContext {
  readonly room: Room;
  readonly userId: string;
  readonly myPower: number;
}

const ALLOWED: ActionAvailability = { available: true, reason: null };

const denied = (reason: string): ActionAvailability => ({
  available: false,
  reason,
});

/**
 * Live Matrix authorization for permission-sensitive room actions.
 *
 * Callers read synchronous view models, while a filtered room-state projection supplies
 * the signal dependency that makes those reads update after remote power-level or
 * membership changes. Mutation services also read this class inside their cold action so
 * a permission revoked while a picker or confirmation is open is checked again immediately
 * before the homeserver write.
 */
@Injectable({ providedIn: 'root' })
export class RoomActionPermissionsService {
  private readonly matrix = inject(MatrixClientService);
  private readonly projectionState = inject(RoomAdministrationProjectionState);
  private readonly revision = signal(0);

  private readonly onStateEvent = (event: MatrixEvent): void => {
    if (
      event.getType() === EventType.RoomPowerLevels ||
      event.getType() === EventType.RoomMember
    ) {
      this.projection.schedule();
    }
  };

  private readonly projection = projectFromClient({
    id: 'room-administration.action-permissions',
    matrix: this.matrix,
    bind: (client) => client.on(RoomStateEvent.Events, this.onStateEvent),
    unbind: (client) => client.off(RoomStateEvent.Events, this.onStateEvent),
    rebuild: () => this.revision.update((value) => value + 1),
    reset: () => this.revision.update((value) => value + 1),
  });

  /** Cold authority projection retained by the Room Administration session lifetime. */
  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /** Repair this retained projection without adding another listener owner. */
  retryProjection(): void {
    this.projection.schedule();
  }

  room(roomId: string): RoomActionPermissions {
    const freshness = this.freshness(roomId);
    if (freshness) return { invite: freshness, curateSpace: freshness };
    return this.roomPermissions(this.context(roomId));
  }

  roomFor(key: RoomActionPermissionsKey): RoomActionPermissions {
    this.revision();
    return this.roomPermissions(
      this.contextForClient(this.matrix.clientFor(key.accountId), key.roomId),
    );
  }

  settings(roomId: string): RoomSettingsPermissions {
    const freshness = this.freshness(roomId);
    if (freshness) {
      return {
        name: freshness,
        topic: freshness,
        avatar: freshness,
        joinRule: freshness,
        history: freshness,
        aliases: freshness,
      };
    }
    return this.settingsPermissions(this.context(roomId));
  }

  /** Current settings authority for one immutable Account-and-Room target. */
  settingsFor(key: RoomActionPermissionsKey): RoomSettingsPermissions {
    this.revision();
    return this.settingsPermissions(
      this.contextForClient(this.matrix.clientFor(key.accountId), key.roomId),
    );
  }

  private settingsPermissions(
    context: PermissionContext | null,
  ): RoomSettingsPermissions {
    if (!context) {
      const unavailable = denied('Join this room to change its settings.');
      return {
        name: unavailable,
        topic: unavailable,
        avatar: unavailable,
        joinRule: unavailable,
        history: unavailable,
        aliases: unavailable,
      };
    }
    const maySend = (type: EventType, label: string): ActionAvailability =>
      liveRoomState(context.room)?.maySendStateEvent(type, context.userId)
        ? ALLOWED
        : denied(`Your role cannot change this room's ${label}.`);
    return {
      name: maySend(EventType.RoomName, 'name'),
      topic: maySend(EventType.RoomTopic, 'topic'),
      avatar: maySend(EventType.RoomAvatar, 'photo'),
      joinRule: maySend(EventType.RoomJoinRules, 'join rule'),
      history: maySend(EventType.RoomHistoryVisibility, 'history visibility'),
      aliases: maySend(EventType.RoomCanonicalAlias, 'addresses'),
    };
  }

  member(
    target: string | RoomActionPermissionsKey,
    targetUserId: string,
  ): MemberActionPermissions {
    const roomId = typeof target === 'string' ? target : target.roomId;
    const freshness =
      typeof target === 'string' ? this.freshness(roomId) : null;
    if (freshness)
      return this.deniedMember(
        freshness.reason ?? 'Current room permissions are unavailable.',
      );
    const context =
      typeof target === 'string'
        ? this.context(roomId)
        : this.contextForClient(
            this.matrix.clientFor(target.accountId),
            target.roomId,
          );
    if (!context) {
      return this.deniedMember('Join this room to manage its members.');
    }
    const targetMember = context.room.getMember(targetUserId);
    const targetPower = targetMember?.powerLevel ?? 0;
    if (targetUserId === context.userId) {
      return this.deniedMember(
        'Use your own room actions instead of moderating yourself.',
        context.myPower,
        targetPower,
      );
    }
    if (targetMember?.membership !== KnownMembership.Join) {
      return this.deniedMember(
        'This member is no longer joined to the room.',
        context.myPower,
        targetPower,
      );
    }
    if (context.myPower <= targetPower) {
      return this.deniedMember(
        'You can only manage members with a lower role.',
        context.myPower,
        targetPower,
      );
    }

    const state = liveRoomState(context.room);
    return {
      kick: state?.hasSufficientPowerLevelFor('kick', context.myPower)
        ? ALLOWED
        : denied('Your role cannot remove members from this room.'),
      ban: state?.hasSufficientPowerLevelFor('ban', context.myPower)
        ? ALLOWED
        : denied('Your role cannot ban members from this room.'),
      setPower: state?.maySendStateEvent(
        EventType.RoomPowerLevels,
        context.userId,
      )
        ? ALLOWED
        : denied("Your role cannot change another member's role."),
      myPower: context.myPower,
      targetPower,
    };
  }

  role(
    target: string | RoomActionPermissionsKey,
    targetUserId: string,
    newPower: number,
  ): ActionAvailability {
    const permissions = this.member(target, targetUserId);
    if (!permissions.setPower.available) {
      return permissions.setPower;
    }
    return newPower <= permissions.myPower
      ? ALLOWED
      : denied('You cannot assign a role above your own.');
  }

  unban(
    target: string | RoomActionPermissionsKey,
    targetUserId: string,
  ): ActionAvailability {
    const roomId = typeof target === 'string' ? target : target.roomId;
    const freshness =
      typeof target === 'string' ? this.freshness(roomId) : null;
    if (freshness) return freshness;
    const context =
      typeof target === 'string'
        ? this.context(roomId)
        : this.contextForClient(
            this.matrix.clientFor(target.accountId),
            target.roomId,
          );
    if (!context) {
      return denied('Join this room to manage its banned members.');
    }
    const targetMember = context.room.getMember(targetUserId);
    const targetPower = targetMember?.powerLevel ?? 0;
    if (targetMember?.membership !== KnownMembership.Ban) {
      return denied('This user is no longer banned from the room.');
    }
    if (context.myPower <= targetPower) {
      return denied('You can only unban users with a lower role.');
    }
    const state = liveRoomState(context.room);
    return state?.hasSufficientPowerLevelFor('kick', context.myPower) &&
      state.hasSufficientPowerLevelFor('ban', context.myPower)
      ? ALLOWED
      : denied('Your role cannot unban members from this room.');
  }

  assert(availability: ActionAvailability): void {
    if (!availability.available) {
      throw new RoomActionPermissionError(availability);
    }
  }

  private roomPermissions(
    context: PermissionContext | null,
  ): RoomActionPermissions {
    if (!context) {
      const unavailable = denied('Join this room to use this action.');
      return { invite: unavailable, curateSpace: unavailable };
    }
    const state = liveRoomState(context.room);
    return {
      invite: state?.hasSufficientPowerLevelFor('invite', context.myPower)
        ? ALLOWED
        : denied('Your role cannot invite people to this room.'),
      curateSpace: state?.maySendStateEvent(
        EventType.SpaceChild,
        context.userId,
      )
        ? ALLOWED
        : denied('Your role cannot manage rooms in this space.'),
    };
  }

  private freshness(roomId: string): ActionAvailability | null {
    return this.projectionState.availability('permissions', roomId) ===
      'coherent'
      ? null
      : denied(
          'Current room permissions are unavailable. Retry Room administration before making changes.',
        );
  }

  private context(roomId: string): PermissionContext | null {
    this.revision();
    this.matrix.activeUserId();
    return this.contextForClient(this.readClient(), roomId);
  }

  private contextForClient(
    client: MatrixClient | null,
    roomId: string,
  ): PermissionContext | null {
    const room = client?.getRoom(roomId) ?? null;
    const userId = client?.getUserId() ?? null;
    if (!room || !userId || room.getMyMembership() !== KnownMembership.Join) {
      return null;
    }
    return {
      room,
      userId,
      myPower: room.getMember(userId)?.powerLevel ?? 0,
    };
  }

  private readClient(): MatrixClient | null {
    // The projection may still be detaching from the previous client during an account
    // switch or logout. Authorization reads must follow the Matrix service immediately;
    // using the bound listener client here would briefly expose stale account permissions.
    return this.matrix.isInitialized ? this.matrix.instance : null;
  }

  private deniedMember(
    reason: string,
    myPower = 0,
    targetPower = 0,
  ): MemberActionPermissions {
    const unavailable = denied(reason);
    return {
      kick: unavailable,
      ban: unavailable,
      setPower: unavailable,
      myPower,
      targetPower,
    };
  }
}
