import { Injectable, inject } from '@angular/core';
import {
  SessionStateService,
  projectActiveAccount,
} from '@trinity/data-access/matrix-client';
import { IMAGE_PACK_EVENT_TYPE } from '@trinity/data-access/media';
import { NEVER, type Observable, concat, of } from 'rxjs';
import { AdministeredRoomStore } from './administered-room.store';
import type {
  AdministeredRoom,
  Membership,
} from './room-administration-engine';
import { RoomAdministrationError } from './room-administration-error';
import { RoomAdministrationProjectionState } from './room-administration-projection-state.service';
import { mayAct, maySendState, powerValue } from './room-power';

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
  /** Upgrading the room, which sends `m.room.tombstone` into it. */
  readonly upgrade: ActionAvailability;
  /** Turning on encryption, which sends `m.room.encryption`. */
  readonly encryption: ActionAvailability;
  /** Listing the room in its homeserver's directory, which servers gate like the addresses. */
  readonly directory: ActionAvailability;
  /** Editing the room's emoji, which sends `m.room.image_pack`. */
  readonly imagePack: ActionAvailability;
  /** Changing the room's power levels, which sends `m.room.power_levels`. */
  readonly permissions: ActionAvailability;
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
  readonly key: RoomActionPermissionsKey;
  readonly room: AdministeredRoom;
  readonly myPower: number;
}

const ALLOWED: ActionAvailability = { available: true, reason: null };

const denied = (reason: string): ActionAvailability => ({
  available: false,
  reason,
});

/** Matrix lets a higher-ranked moderator remove invited and knocking users, not only joined ones. */
const MANAGEABLE_MEMBERSHIPS: ReadonlySet<Membership | undefined> = new Set<
  Membership | undefined
>(['join', 'invite', 'knock']);

/**
 * Live Matrix authorization for permission-sensitive room actions.
 *
 * Callers read synchronous view models over {@link AdministeredRoomStore}, so those reads
 * update after remote power-level or membership changes for any account. Mutation services
 * also read this class inside their cold action so a permission revoked while a picker or
 * confirmation is open is checked again immediately before the homeserver write.
 */
@Injectable({ providedIn: 'root' })
export class RoomActionPermissionsService {
  private readonly store = inject(AdministeredRoomStore);
  private readonly session = inject(SessionStateService);
  private readonly projectionState = inject(RoomAdministrationProjectionState);

  // Reads are reactive through the store; the lease keeps the session lifetime's health facts.
  private readonly projection = projectActiveAccount<void>({
    id: 'room-administration.action-permissions',
    subscribe: () => concat(of(undefined), NEVER),
    rebuild: () => undefined,
  });

  /** Cold authority projection retained by the Room Administration session lifetime. */
  runProjection(): Observable<void> {
    return this.projection.run();
  }

  /** Reattach this retained projection without adding another lifetime owner. */
  retryProjection(): void {
    if (!this.projection.isConnected()) return;
    this.projection.disconnect();
    this.projection.connect();
  }

  room(roomId: string): RoomActionPermissions {
    const freshness = this.freshness(roomId);
    if (freshness) return { invite: freshness, curateSpace: freshness };
    return this.roomPermissions(this.context(roomId));
  }

  roomFor(key: RoomActionPermissionsKey): RoomActionPermissions {
    return this.roomPermissions(this.contextFor(key));
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
        upgrade: freshness,
        encryption: freshness,
        directory: freshness,
        imagePack: freshness,
        permissions: freshness,
      };
    }
    return this.settingsPermissions(this.context(roomId));
  }

  /** Current settings authority for one immutable Account-and-Room target. */
  settingsFor(key: RoomActionPermissionsKey): RoomSettingsPermissions {
    return this.settingsPermissions(this.contextFor(key));
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
        upgrade: unavailable,
        encryption: unavailable,
        directory: unavailable,
        imagePack: unavailable,
        permissions: unavailable,
      };
    }
    const { powerLevels, ownPower } = context.room;
    const may = (type: string): boolean =>
      maySendState(powerLevels, ownPower, type);
    const maySend = (type: string, label: string): ActionAvailability =>
      may(type)
        ? ALLOWED
        : denied(`Your role cannot change this room's ${label}.`);
    return {
      name: maySend('m.room.name', 'name'),
      topic: maySend('m.room.topic', 'topic'),
      avatar: maySend('m.room.avatar', 'photo'),
      joinRule: maySend('m.room.join_rules', 'join rule'),
      history: maySend('m.room.history_visibility', 'history visibility'),
      aliases: maySend('m.room.canonical_alias', 'addresses'),
      upgrade: maySend('m.room.tombstone', 'version'),
      encryption: may('m.room.encryption')
        ? ALLOWED
        : denied(
            'Only people who can change room settings can turn on encryption.',
          ),
      directory: maySend('m.room.canonical_alias', 'directory listing'),
      imagePack: maySend(IMAGE_PACK_EVENT_TYPE, 'emoji'),
      permissions: maySend('m.room.power_levels', 'permissions'),
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
    const context = this.targetContext(target);
    if (!context) {
      return this.deniedMember('Join this room to manage its members.');
    }
    const targetMember = this.memberOf(context, targetUserId);
    const targetPower = targetMember ? powerValue(targetMember.power) : 0;
    if (targetUserId === context.room.ownUserId) {
      return this.deniedMember(
        'Use your own room actions instead of moderating yourself.',
        context.myPower,
        targetPower,
      );
    }
    if (!MANAGEABLE_MEMBERSHIPS.has(targetMember?.membership)) {
      return this.deniedMember(
        'This person is no longer in the room.',
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

    const { powerLevels, ownPower } = context.room;
    return {
      kick: mayAct(powerLevels, ownPower, 'kick')
        ? ALLOWED
        : denied('Your role cannot remove members from this room.'),
      ban: mayAct(powerLevels, ownPower, 'ban')
        ? ALLOWED
        : denied('Your role cannot ban members from this room.'),
      setPower: maySendState(powerLevels, ownPower, 'm.room.power_levels')
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
    const context = this.targetContext(target);
    if (!context) {
      return denied('Join this room to manage its banned members.');
    }
    const targetMember = this.memberOf(context, targetUserId);
    const targetPower = targetMember ? powerValue(targetMember.power) : 0;
    if (targetMember?.membership !== 'ban') {
      return denied('This user is no longer banned from the room.');
    }
    if (context.myPower <= targetPower) {
      return denied('You can only unban users with a lower role.');
    }
    const { powerLevels, ownPower } = context.room;
    return mayAct(powerLevels, ownPower, 'kick') &&
      mayAct(powerLevels, ownPower, 'ban')
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
    const { powerLevels, ownPower } = context.room;
    return {
      invite: mayAct(powerLevels, ownPower, 'invite')
        ? ALLOWED
        : denied('Your role cannot invite people to this room.'),
      curateSpace: maySendState(powerLevels, ownPower, 'm.space.child')
        ? ALLOWED
        : denied('Your role cannot manage rooms in this space.'),
    };
  }

  private freshness(roomId: string): ActionAvailability | null {
    return this.projectionState.availability('permissions', roomId) ===
      'coherent'
      ? null
      : denied(
          'Current room permissions are unavailable. Retry room administration before making changes.',
        );
  }

  /** The active account's context; it follows an account switch at once. */
  private context(roomId: string): PermissionContext | null {
    const accountId = this.session.activeAccountId();
    return accountId ? this.contextFor({ accountId, roomId }) : null;
  }

  private targetContext(
    target: string | RoomActionPermissionsKey,
  ): PermissionContext | null {
    return typeof target === 'string'
      ? this.context(target)
      : this.contextFor(target);
  }

  private contextFor(key: RoomActionPermissionsKey): PermissionContext | null {
    const room = this.store.room(key.accountId, key.roomId);
    if (room?.ownMembership !== 'join') return null;
    return { key, room, myPower: powerValue(room.ownPower) };
  }

  private memberOf(context: PermissionContext, userId: string) {
    return this.store
      .members(context.key.accountId, context.key.roomId)
      ?.members.find((member) => member.userId === userId);
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
