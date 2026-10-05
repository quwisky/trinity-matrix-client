import { Injectable, inject } from '@angular/core';
import {
  EventType,
  JoinRule,
  KnownMembership,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { liveRoomState } from '@trinity/util/matrix';
import { roomAdvancedInfo } from './room-advanced-info';

/** The `m.room_versions` facts a plan needs. `HomeserverCapabilities` satisfies it. */
export interface RoomUpgradeCapabilities {
  readonly defaultRoomVersion: string | null;
  readonly roomVersions: Readonly<Record<string, 'stable' | 'unstable'>> | null;
}

/** One version a room can be upgraded to. */
export interface RoomUpgradeTarget {
  readonly version: string;
  /** The version the server creates new rooms at. */
  readonly isDefault: boolean;
}

/** A space that links the room, and whether this Account can move that link. */
export interface RoomUpgradeSpace {
  readonly spaceId: string;
  readonly name: string;
  readonly relinkable: boolean;
  readonly reason?: 'no permission' | 'state not loaded';
}

/** What upgrading one room would do, read from its current state. */
export interface RoomUpgradePlan {
  /** The room's version; null when its create event is missing or malformed. */
  readonly currentVersion: string | null;
  /** Stable, whole-number versions newer than the current one, ascending. */
  readonly targets: readonly RoomUpgradeTarget[];
  /** True for join rule `invite` or `knock`. */
  readonly invitePrivateDefault: boolean;
  /** Joined and invited members, excluding this Account. */
  readonly members: readonly string[];
  readonly spaces: readonly RoomUpgradeSpace[];
  /** The old room's creators other than this Account; sent only for v12+ targets. */
  readonly additionalCreators: readonly string[];
}

export interface RoomUpgradeOptions {
  readonly version: string;
  readonly inviteMembers: boolean;
}

export interface RoomUpgradeInviteFailure {
  readonly userId: string;
  readonly reason: string;
}

export interface RoomUpgradeRelinkFailure {
  readonly spaceId: string;
  readonly reason: string;
  /** The new link landed but removing the old one failed: the space lists both rooms. */
  readonly linkedTwice: boolean;
}

/** What happened after the server created the new room. Never rolled back. */
export interface RoomUpgradeResult {
  readonly newRoomId: string;
  readonly invited: readonly string[];
  readonly inviteFailed: readonly RoomUpgradeInviteFailure[];
  /** Spaces that now link only the new room. */
  readonly relinked: readonly string[];
  readonly relinkFailed: readonly RoomUpgradeRelinkFailure[];
  /** Linked spaces this Account could not edit; left untouched. */
  readonly skippedSpaces: readonly RoomUpgradeSpace[];
}

/** A linked space plus the child link it carries, for the relink write. */
interface LinkedSpace extends RoomUpgradeSpace {
  readonly via: readonly string[];
  readonly order?: string;
  readonly suggested?: boolean;
}

/** The plan's state-derived half, with the full space links the command needs. */
interface UpgradeContext {
  readonly currentVersion: string | null;
  readonly invitePrivateDefault: boolean;
  readonly members: readonly string[];
  readonly spaces: readonly LinkedSpace[];
  readonly additionalCreators: readonly string[];
}

/**
 * Stable, whole-number room versions newer than `currentVersion`, ascending.
 *
 * A default the server does not label `unstable` counts as stable, as in `roomVersionStatus()`.
 * A current version that is not a whole number (an unstable `org.…` version) is older than
 * every stable one. Empty when the room version or the capabilities are unknown.
 */
export function roomUpgradeTargets(
  currentVersion: string | null,
  capabilities: RoomUpgradeCapabilities | null,
): RoomUpgradeTarget[] {
  if (currentVersion === null || !capabilities) return [];
  const { defaultRoomVersion, roomVersions } = capabilities;
  const stable = new Set(
    Object.keys(roomVersions ?? {}).filter(
      (version) => roomVersions?.[version] === 'stable',
    ),
  );
  if (
    defaultRoomVersion !== null &&
    roomVersions?.[defaultRoomVersion] !== 'unstable'
  ) {
    stable.add(defaultRoomVersion);
  }
  const floor = isWholeNumber(currentVersion) ? Number(currentVersion) : 0;
  return [...stable]
    .filter((version) => isWholeNumber(version) && Number(version) > floor)
    .sort((a, b) => Number(a) - Number(b))
    .map((version) => ({ version, isDefault: version === defaultRoomVersion }));
}

/**
 * Upgrades a room to a newer room version the way Element does. The server creates the
 * replacement and tombstones the old room. This service then invites the old members and
 * moves the room's space links. Steps after the upgrade report failures and never roll back.
 */
@Injectable({ providedIn: 'root' })
export class RoomUpgradeService {
  private readonly matrix = inject(MatrixClientService);

  /** What upgrading `roomId` would do; null when the Account or the Room is unavailable. */
  plan(
    accountId: string,
    roomId: string,
    capabilities: RoomUpgradeCapabilities | null,
  ): RoomUpgradePlan | null {
    const client = this.matrix.clientFor(accountId);
    const room = client?.getRoom(roomId) ?? null;
    if (!client || !room) return null;
    const context = readContext(client, room);
    return {
      ...context,
      targets: roomUpgradeTargets(context.currentVersion, capabilities),
      spaces: context.spaces.map(publicSpace),
    };
  }
}

function readContext(client: MatrixClient, room: Room): UpgradeContext {
  const me = client.getUserId() ?? '';
  const state = liveRoomState(room);
  const info = roomAdvancedInfo(room.roomId, state);
  const joinRule = state?.getJoinRule() ?? JoinRule.Invite;
  return {
    currentVersion: info.version,
    invitePrivateDefault:
      joinRule === JoinRule.Invite || joinRule === JoinRule.Knock,
    members: room
      .getMembers()
      .filter(
        ({ userId, membership }) =>
          userId !== me &&
          (membership === KnownMembership.Join ||
            membership === KnownMembership.Invite),
      )
      .map(({ userId }) => userId),
    spaces: linkedSpaces(client, room, me),
    additionalCreators: info.createdBy
      .map(({ userId }) => userId)
      .filter((userId) => userId !== me),
  };
}

/** Joined spaces of this Account whose live state links `room`. */
function linkedSpaces(
  client: MatrixClient,
  room: Room,
  me: string,
): LinkedSpace[] {
  const parents = new Set(
    (liveRoomState(room)?.getStateEvents(EventType.SpaceParent) ?? []).map(
      (event) => event.getStateKey(),
    ),
  );
  return client.getRooms().flatMap((space): LinkedSpace[] => {
    if (
      space.roomId === room.roomId ||
      space.getMyMembership() !== KnownMembership.Join
    ) {
      return [];
    }
    const named = { spaceId: space.roomId, name: space.name };
    const state = liveRoomState(space);
    if (!state?.getStateEvents(EventType.RoomCreate, '')) {
      // Without its state the link is invisible; only the room's own parent event says it exists.
      return parents.has(space.roomId)
        ? [
            {
              ...named,
              relinkable: false,
              reason: 'state not loaded' as const,
              via: [],
            },
          ]
        : [];
    }
    if (!space.isSpaceRoom()) return [];
    const content: Record<string, unknown> =
      state.getStateEvents(EventType.SpaceChild, room.roomId)?.getContent() ??
      {};
    const via = Array.isArray(content['via'])
      ? content['via'].filter(
          (server): server is string => typeof server === 'string',
        )
      : [];
    // An empty `via` is how a space removes a child.
    if (via.length === 0) return [];
    const relinkable = !!state.maySendStateEvent(EventType.SpaceChild, me);
    const order = content['order'];
    const suggested = content['suggested'];
    return [
      {
        ...named,
        relinkable,
        ...(relinkable ? {} : { reason: 'no permission' as const }),
        via,
        ...(typeof order === 'string' ? { order } : {}),
        ...(typeof suggested === 'boolean' ? { suggested } : {}),
      },
    ];
  });
}

function publicSpace({
  spaceId,
  name,
  relinkable,
  reason,
}: RoomUpgradeSpace): RoomUpgradeSpace {
  return reason
    ? { spaceId, name, relinkable, reason }
    : { spaceId, name, relinkable };
}

function isWholeNumber(version: string): boolean {
  return /^\d+$/.test(version);
}
