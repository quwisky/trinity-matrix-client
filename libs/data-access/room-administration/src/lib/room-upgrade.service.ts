import { Injectable, inject } from '@angular/core';
import {
  Observable,
  catchError,
  combineLatest,
  concat,
  defer,
  finalize,
  first,
  map,
  of,
  switchMap,
  take,
  throwError,
  toArray,
} from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import {
  type EngineResult,
  engineFailureMessage,
  unwrapEngineResult,
} from '@trinity/util/matrix';
import { AdministeredRoomStore } from './administered-room.store';
import { roomAdvancedInfo } from './room-advanced-info';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import type {
  AdministeredRoom,
  LinkingSpace,
  RoomMembers,
} from './room-administration-engine';
import { ROOM_ADMINISTRATION_ENGINE } from './room-administration-engine.token';
import {
  recoverRoomAdministrationRequest,
  roomAdministrationInvalidInput,
  roomAdministrationNotSignedIn,
} from './room-administration-error';
import { domainOf, maySendState, powerValue } from './room-power';

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
  /**
   * Creators the new room gets besides this Account, sent only for v12+ targets (and always
   * the same list for those). From a pre-v12 room only creators still joined at a power level
   * no lower than this Account's carry over; from a v12+ room they all do.
   */
  readonly additionalCreators: readonly string[];
  /** Display names for {@link additionalCreators}, in the same order. */
  readonly additionalCreatorNames: readonly string[];
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
  readonly additionalCreatorNames: readonly string[];
}

interface RelinkOutcome {
  readonly spaceId: string;
  readonly failure: RoomUpgradeRelinkFailure | null;
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
  private readonly engine = inject(ROOM_ADMINISTRATION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly store = inject(AdministeredRoomStore);
  private readonly permissions = inject(RoomActionPermissionsService);
  /** `${accountId}|${roomId}` of upgrades in flight. */
  private readonly upgrading = new Set<string>();

  /**
   * What upgrading `roomId` would do, once the members and linking spaces are read. Cold;
   * emits once: null when the Account or the Room is unavailable.
   */
  plan(
    accountId: string,
    roomId: string,
    capabilities: RoomUpgradeCapabilities | null,
  ): Observable<RoomUpgradePlan | null> {
    return this.context(accountId, roomId).pipe(
      map((context) =>
        context
          ? {
              ...context,
              targets: roomUpgradeTargets(context.currentVersion, capabilities),
              spaces: context.spaces.map(publicSpace),
            }
          : null,
      ),
    );
  }

  /**
   * Upgrade one room and carry its members and space links over. Cold: runs on subscribe.
   *
   * Errors only when nothing changed: the opening Account is signed out, no permission to
   * send the tombstone, or the server rejected the upgrade itself. After the upgrade every
   * step reports its own failures in the result, and nothing is rolled back.
   */
  upgrade(
    accountId: string,
    roomId: string,
    options: RoomUpgradeOptions,
  ): Observable<RoomUpgradeResult> {
    return defer(() => {
      const key = `${accountId}|${roomId}`;
      if (this.upgrading.has(key)) {
        return throwError(() =>
          roomAdministrationInvalidInput(
            'upgrade-room',
            'This room is already being upgraded.',
          ),
        );
      }
      return this.run(key, accountId, roomId, options);
    });
  }

  private run(
    key: string,
    accountId: string,
    roomId: string,
    options: RoomUpgradeOptions,
  ): Observable<RoomUpgradeResult> {
    return defer(() => {
      if (!this.session.status(accountId)) {
        return throwError(() => roomAdministrationNotSignedIn('upgrade-room'));
      }
      this.permissions.assert(
        this.permissions.settingsFor({ accountId, roomId }).upgrade,
      );
      const room = this.store.room(accountId, roomId);
      if (!room) {
        return throwError(() => roomAdministrationNotSignedIn('upgrade-room'));
      }
      if (roomAdvancedInfo(roomId, room).successor) {
        return throwError(() =>
          roomAdministrationInvalidInput(
            'upgrade-room',
            'This room has already been upgraded.',
          ),
        );
      }
      this.upgrading.add(key);
      return this.context(accountId, roomId).pipe(
        switchMap((before) => {
          if (!before) throw roomAdministrationNotSignedIn('upgrade-room');
          const creators =
            isWholeNumber(options.version) &&
            Number(options.version) >= 12 &&
            before.additionalCreators.length > 0
              ? before.additionalCreators
              : null;
          return this.engine
            .upgradeRoom(accountId, roomId, options.version, creators)
            .pipe(
              unwrapEngineResult(),
              recoverRoomAdministrationRequest('upgrade-room'),
              switchMap(({ replacementRoomId }) =>
                this.followUp(
                  accountId,
                  roomId,
                  replacementRoomId,
                  before,
                  options,
                ),
              ),
            );
        }),
        finalize(() => this.upgrading.delete(key)),
      );
    });
  }

  /**
   * The room, its full member list (lazily synced members are loaded first, so the
   * invitations reach everyone; a failed load keeps the known ones) and its linking spaces.
   */
  private context(
    accountId: string,
    roomId: string,
  ): Observable<UpgradeContext | null> {
    return defer(() =>
      combineLatest([
        this.engine
          .members(accountId, roomId)
          .pipe(first((members) => members === null || members.complete)),
        this.engine.linkingSpaces(accountId, roomId),
      ]),
    ).pipe(
      map(([members, spaces]) => {
        const room = this.store.room(accountId, roomId);
        return room && members && spaces.ok
          ? readContext(room, members, spaces.value)
          : null;
      }),
    );
  }

  /** Invite, then relink, one at a time; every failure is collected, none is thrown. */
  private followUp(
    accountId: string,
    oldRoomId: string,
    newRoomId: string,
    before: UpgradeContext,
    options: RoomUpgradeOptions,
  ): Observable<RoomUpgradeResult> {
    const server = serverOf(newRoomId) ?? domainOf(accountId);
    const invites = (
      options.inviteMembers
        ? this.engine.members(accountId, newRoomId).pipe(take(1))
        : of(null)
    ).pipe(
      switchMap((present) =>
        concat(
          ...(options.inviteMembers ? before.members : [])
            .filter((userId) => !isPresent(present, userId))
            .map((userId) =>
              outcome(() =>
                this.engine.invite(accountId, newRoomId, userId),
              ).pipe(map((reason) => ({ userId, reason }))),
            ),
        ),
      ),
      toArray(),
    );
    const relinks = concat(
      ...before.spaces
        .filter((space) => space.relinkable)
        .map((space) =>
          this.relink(accountId, space, oldRoomId, newRoomId, server),
        ),
    ).pipe(toArray());
    return invites.pipe(
      switchMap((inviteOutcomes) =>
        relinks.pipe(
          map((relinkOutcomes) => ({
            newRoomId,
            invited: inviteOutcomes
              .filter(({ reason }) => reason === null)
              .map(({ userId }) => userId),
            inviteFailed: inviteOutcomes.flatMap(({ userId, reason }) =>
              reason === null ? [] : [{ userId, reason }],
            ),
            relinked: relinkOutcomes
              .filter(({ failure }) => failure === null)
              .map(({ spaceId }) => spaceId),
            relinkFailed: relinkOutcomes.flatMap(({ failure }) =>
              failure ? [failure] : [],
            ),
            skippedSpaces: before.spaces
              .filter((space) => !space.relinkable)
              .map(publicSpace),
          })),
        ),
      ),
    );
  }

  /** Link the new room, then unlink the old one; the old link stays if the first write fails. */
  private relink(
    accountId: string,
    space: LinkedSpace,
    oldRoomId: string,
    newRoomId: string,
    server: string | null,
  ): Observable<RelinkOutcome> {
    const { spaceId } = space;
    const link = {
      via: [...new Set([...space.via, ...(server ? [server] : [])])],
      ...(space.order === undefined ? {} : { order: space.order }),
      ...(space.suggested === undefined ? {} : { suggested: space.suggested }),
    };
    const failed = (reason: string, linkedTwice: boolean): RelinkOutcome => ({
      spaceId,
      failure: { spaceId, reason, linkedTwice },
    });
    return outcome(() =>
      this.engine.setState(
        accountId,
        spaceId,
        'm.space.child',
        newRoomId,
        link,
      ),
    ).pipe(
      switchMap((reason) =>
        reason !== null
          ? of(failed(reason, false))
          : outcome(() =>
              this.engine.setState(
                accountId,
                spaceId,
                'm.space.child',
                oldRoomId,
                {},
              ),
            ).pipe(
              map((second) =>
                second === null
                  ? { spaceId, failure: null }
                  : failed(second, true),
              ),
            ),
      ),
    );
  }
}

/** A command's failure text, or null on success; never errors. Created on subscribe. */
function outcome(
  command: () => Observable<EngineResult<unknown>>,
): Observable<string | null> {
  return defer(command).pipe(
    map((result) => (result.ok ? null : engineFailureMessage(result.failure))),
    catchError(() => of('The homeserver rejected the request.')),
  );
}

function readContext(
  room: AdministeredRoom,
  members: RoomMembers,
  spaces: readonly LinkingSpace[],
): UpgradeContext {
  const me = room.ownUserId;
  const info = roomAdvancedInfo(room.roomId, room);
  const joinRule = room.state.joinRules?.['join_rule'] ?? 'invite';
  const fromV12 =
    info.version !== null &&
    isWholeNumber(info.version) &&
    Number(info.version) >= 12;
  const member = (userId: string) =>
    members.members.find((candidate) => candidate.userId === userId);
  const myPower = powerValue(room.ownPower);
  // Creators for a v12+ target; the source era decides who is still trusted to stay one.
  const kept = info.createdBy.filter(({ userId }) => {
    if (userId === me) return false;
    if (fromV12) return true;
    const creator = member(userId);
    return (
      creator?.membership === 'join' && powerValue(creator.power) >= myPower
    );
  });
  return {
    currentVersion: info.version,
    invitePrivateDefault: joinRule === 'invite' || joinRule === 'knock',
    members: members.members
      .filter(
        ({ userId, membership }) =>
          userId !== me && (membership === 'join' || membership === 'invite'),
      )
      .map(({ userId }) => userId),
    spaces: spaces.flatMap(linkedSpace),
    additionalCreators: kept.map(({ userId }) => userId),
    additionalCreatorNames: kept.map(({ displayName }) => displayName),
  };
}

function linkedSpace(space: LinkingSpace): LinkedSpace[] {
  const named = { spaceId: space.spaceId, name: space.name };
  const content = space.childContent;
  if (!content) {
    return [
      { ...named, relinkable: false, reason: 'state not loaded', via: [] },
    ];
  }
  const via = Array.isArray(content['via'])
    ? content['via'].filter(
        (server): server is string => typeof server === 'string',
      )
    : [];
  // An empty `via` is how a space removes a child.
  if (via.length === 0) return [];
  const relinkable = maySendState(
    space.powerLevels,
    space.ownPower,
    'm.space.child',
  );
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
}

/** The new room's server from its ID; null for a v12 ID that has none. */
function serverOf(roomId: string): string | null {
  const colon = roomId.indexOf(':');
  return colon >= 0 ? roomId.slice(colon + 1) : null;
}

function isPresent(members: RoomMembers | null, userId: string): boolean {
  const membership = members?.members.find(
    (member) => member.userId === userId,
  )?.membership;
  return membership === 'join' || membership === 'invite';
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
