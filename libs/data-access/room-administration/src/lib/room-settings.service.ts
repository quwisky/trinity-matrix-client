import {
  Injectable,
  Injector,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { MediaService } from '@trinity/data-access/media';
import { EngineRequestError, unwrapEngineResult } from '@trinity/util/matrix';
import { Observable, defer, distinctUntilChanged, map, switchMap } from 'rxjs';
import { AdministeredRoomStore } from './administered-room.store';
import { HistoryVisibility, JoinRule } from './room-access.models';
import {
  RoomActionPermissionsService,
  type RoomSettingsPermissions,
} from './room-action-permissions.service';
import type {
  AdministeredRoom,
  JsonObject,
  RawStateEvent,
} from './room-administration-engine';
import { ROOM_ADMINISTRATION_ENGINE } from './room-administration-engine.token';
import {
  recoverRoomAdministrationRequest,
  roomAdministrationInvalidInput,
  roomAdministrationNotSignedIn,
} from './room-administration-error';
import {
  allowedSpaceIdsOf,
  invalidAllowedSpaceId,
  restrictedAllowEntriesForWrite,
} from './room-access-policy';
import { roomAdvancedInfo, type RoomAdvancedInfo } from './room-advanced-info';

/** Which room-settings fields the current user may edit (from the room's power levels). */
export interface EditableRoomFields {
  name: boolean;
  topic: boolean;
  avatar: boolean;
  joinRule: boolean;
  history: boolean;
}

/** A room's identity fields, for seeding a settings dialog. */
export interface RoomIdentity {
  name: string;
  topic: string;
  avatarMxc: string | null;
}

/** A room's access controls: who can join and how far back history is visible. */
export interface RoomAccess {
  joinRule: JoinRule;
  historyVisibility: HistoryVisibility;
  /**
   * The spaces whose members may join, from the `allow` list of a `restricted` join rule
   * (MSC3083). Empty for every other rule. An empty list under `restricted` is a room nobody
   * can join, so {@link RoomSettingsService.setJoinRule} refuses to write one.
   */
  allowedSpaceIds: string[];
}

/** Immutable ownership carried by the Room settings lifetime and every command it creates. */
export interface RoomSettingsTarget {
  readonly accountId: string;
  readonly roomId: string;
}

export type RoomSettingsAvailability =
  'available' | 'account-unavailable' | 'room-unavailable';

/** Authoritative view for one exact Room settings target. */
export interface RoomSettingsSnapshot {
  readonly target: RoomSettingsTarget;
  readonly availability: RoomSettingsAvailability;
  readonly unavailableReason: string | null;
  readonly openingAccountActive: boolean;
  readonly identity: RoomIdentity;
  readonly access: RoomAccess;
  readonly permissions: RoomSettingsPermissions;
  readonly encrypted: boolean | null;
  readonly supportsRestricted: boolean;
  readonly supportsKnock: boolean;
  readonly supportsKnockRestricted: boolean;
  /** Technical details for Room settings › Advanced; never throws on partial state. */
  readonly advanced: RoomAdvancedInfo;
}

/** One current state event, for the read-only room state viewer. */
export type RoomStateEntry = RawStateEvent;

type RoomSettingsTargetInput = RoomSettingsTarget | string;

/** A room with no join-rules state defaults to invite-only, per the Matrix spec. */
const DEFAULT_JOIN_RULE = JoinRule.Invite;
/** A room with no history-visibility state defaults to `shared`, per the spec. */
const DEFAULT_HISTORY_VISIBILITY = HistoryVisibility.Shared;

/** MSC3787 join rule; the local `JoinRule` constants have no member for it. */
export const KNOCK_RESTRICTED = 'knock_restricted' as JoinRule;

/** Whether the rule carries an `allow` list of spaces. */
export function takesAllowList(rule: JoinRule): boolean {
  return rule === JoinRule.Restricted || rule === KNOCK_RESTRICTED;
}

/** Failures that mean "nothing to show" to the state viewer rather than an error. */
const NO_STATE: ReadonlySet<string> = new Set([
  'account-not-live',
  'room-unavailable',
]);

/**
 * Writes a room's editable metadata — display name (`m.room.name`) and topic
 * (`m.room.topic`) — and reports which the current user may change, from the room's
 * power levels. Writes are cold Observables (fire on subscribe); the change arrives
 * through {@link AdministeredRoomStore}, so no manual refresh is needed.
 */
@Injectable({ providedIn: 'root' })
export class RoomSettingsService {
  private readonly engine = inject(ROOM_ADMINISTRATION_ENGINE);
  private readonly store = inject(AdministeredRoomStore);
  private readonly session = inject(SessionStateService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly media = inject(MediaService);
  private readonly injector = inject(Injector);

  /** Rename the room (`m.room.name`). Cold — runs on subscribe. */
  setName(target: RoomSettingsTargetInput, name: string): Observable<void> {
    return this.write(target, 'set-name', 'name', 'm.room.name', () => ({
      name: name.trim(),
    }));
  }

  /**
   * Set the room topic (`m.room.topic`); an empty string clears it. Cold. The content is
   * js-sdk `setRoomTopic`'s: the plain topic plus its MSC3765 `m.topic` rendering.
   */
  setTopic(target: RoomSettingsTargetInput, topic: string): Observable<void> {
    return this.write(target, 'set-topic', 'topic', 'm.room.topic', () => {
      const text = topic.trim();
      return {
        topic: text,
        'm.topic': { 'm.text': [{ body: text, mimetype: 'text/plain' }] },
      };
    });
  }

  /**
   * Upload a picked image and set it as the room avatar (`m.room.avatar`). Cold —
   * uploads on subscribe, then writes the state event pointing at the new mxc.
   */
  setAvatar(target: RoomSettingsTargetInput, file: File): Observable<void> {
    return defer(() => {
      const key = this.keyOf(target);
      if (!key) throw roomAdministrationNotSignedIn('set-avatar');
      this.permissions.assert(this.permissionsFor(target).avatar);
      const generation = this.session.status(key.accountId)?.generation;
      // Media strips a photo's location, camera and capture time before it goes up.
      return this.media
        .uploadMedia(file, false, undefined, undefined, key.accountId)
        .pipe(
          switchMap(({ mxc }) =>
            defer(() => {
              if (
                !mxc ||
                this.session.status(key.accountId)?.generation !== generation
              ) {
                throw new Error(
                  'The originating account became unavailable before the photo uploaded.',
                );
              }
              this.permissions.assert(this.permissionsFor(target).avatar);
              return this.engine
                .setState(key.accountId, key.roomId, 'm.room.avatar', '', {
                  url: mxc,
                })
                .pipe(unwrapEngineResult());
            }).pipe(
              recoverRoomAdministrationRequest('set-avatar', {
                completedStep: 'media-upload',
              }),
            ),
          ),
          map(() => void 0),
          recoverRoomAdministrationRequest('upload-avatar'),
        );
    });
  }

  /**
   * Set who may join the room (`m.room.join_rules`) — e.g. public vs invite-only.
   * Cold — runs on subscribe.
   */
  setJoinRule(
    target: RoomSettingsTargetInput,
    joinRule: JoinRule,
    allowedSpaceIds: readonly string[] = [],
  ): Observable<void> {
    return this.write(
      target,
      'set-join-rule',
      'joinRule',
      'm.room.join_rules',
      (room): JsonObject => {
        const restricted = takesAllowList(joinRule);
        // A `restricted` rule with no `allow` entries can never be joined, even by members
        // of the gating space, and only an admin could undo it. Refused here, the one place
        // every join-rule write passes through.
        if (restricted && allowedSpaceIds.length === 0) {
          throw roomAdministrationInvalidInput(
            'set-join-rule',
            'A restricted join rule needs at least one space to allow in.',
          );
        }
        if (!restricted) return { join_rule: joinRule };
        if (invalidAllowedSpaceId(allowedSpaceIds)) {
          throw roomAdministrationInvalidInput(
            'set-join-rule',
            'Every allowed Space must have a valid Matrix Room ID.',
          );
        }
        return {
          join_rule: joinRule,
          allow: restrictedAllowEntriesForWrite(
            allowedSpaceIds,
            room?.state.joinRules?.['allow'],
          ),
        };
      },
    );
  }

  /**
   * Whether `roomId` can carry a `restricted` join rule at all. MSC3083 landed in room
   * version 8; an older room accepts the rule as an unrecognised string and enforces nothing,
   * so it silently stays as open as it was. False when the version is missing or unparseable.
   */
  supportsRestricted(target: RoomSettingsTargetInput): boolean {
    return versionAtLeast(this.roomOf(target), 8);
  }

  /** Whether the room can carry a `knock` join rule (room version 7+). */
  supportsKnock(target: RoomSettingsTargetInput): boolean {
    return versionAtLeast(this.roomOf(target), 7);
  }

  /** Whether the room can carry a `knock_restricted` join rule (room version 10+). */
  supportsKnockRestricted(target: RoomSettingsTargetInput): boolean {
    return versionAtLeast(this.roomOf(target), 10);
  }

  /**
   * Set how far back new members can read history (`m.room.history_visibility`).
   * Cold — runs on subscribe.
   */
  setHistoryVisibility(
    target: RoomSettingsTargetInput,
    historyVisibility: HistoryVisibility,
  ): Observable<void> {
    return this.write(
      target,
      'set-history-visibility',
      'history',
      'm.room.history_visibility',
      () => ({ history_visibility: historyVisibility }),
    );
  }

  /**
   * The room's current name, topic and avatar, straight from state, for seeding a settings
   * dialog. The raw `m.room.name`, not a computed display name: that invents one from the
   * member list for a nameless room, which would make the dialog's "did this field
   * change?" compare against something nobody typed and write it back.
   */
  currentIdentity(target: RoomSettingsTargetInput): RoomIdentity {
    return identityOf(this.roomOf(target));
  }

  /** The room's current join rule + history visibility, falling back to the spec defaults. */
  currentAccess(target: RoomSettingsTargetInput): RoomAccess {
    return accessOf(this.roomOf(target));
  }

  /** Which fields the current user's power level lets them edit in `roomId`. */
  editableFields(target: RoomSettingsTargetInput): EditableRoomFields {
    const permissions = this.permissionsFor(target);
    return {
      name: permissions.name.available,
      topic: permissions.topic.available,
      avatar: permissions.avatar.available,
      joinRule: permissions.joinRule.available,
      history: permissions.history.available,
    };
  }

  /** Read the complete current view for one Account-and-Room target. */
  snapshot(target: RoomSettingsTarget): RoomSettingsSnapshot {
    const live = this.session.status(target.accountId) !== null;
    const room = live ? this.store.room(target.accountId, target.roomId) : null;
    const availability: RoomSettingsAvailability = !live
      ? 'account-unavailable'
      : room?.ownMembership !== 'join'
        ? 'room-unavailable'
        : 'available';
    return {
      target,
      availability,
      unavailableReason:
        availability === 'account-unavailable'
          ? 'This account is no longer available. Your unfinished edits are still here.'
          : availability === 'room-unavailable'
            ? 'This room is no longer joined for this account. Your unfinished edits are still here.'
            : null,
      openingAccountActive: this.session.activeAccountId() === target.accountId,
      identity: identityOf(room),
      access: accessOf(room),
      permissions: this.permissions.settingsFor(target),
      // Unknown (null) until the crypto store has answered, so Turn on is never offered for
      // a room it may know is encrypted.
      encrypted:
        room?.encryption === 'encrypted'
          ? true
          : room?.encryption === 'unencrypted'
            ? false
            : null,
      supportsRestricted: versionAtLeast(room, 8),
      supportsKnock: versionAtLeast(room, 7),
      supportsKnockRestricted: versionAtLeast(room, 10),
      advanced: roomAdvancedInfo(target.roomId, room),
    };
  }

  /**
   * Every current state event of one exact target, read once on subscribe for the state
   * viewer. Unsorted: presentation order belongs to the viewer. Empty when the Account or
   * Room is unavailable; a refused request errors.
   */
  stateEvents(
    target: RoomSettingsTarget,
  ): Observable<readonly RoomStateEntry[]> {
    return defer(() =>
      this.engine.stateEvents(target.accountId, target.roomId),
    ).pipe(
      map((result) => {
        if (result.ok) return result.value;
        if (NO_STATE.has(result.failure.code)) return [];
        throw new EngineRequestError(result.failure);
      }),
    );
  }

  /**
   * Observe one exact target: its snapshot at once, then after each change of that
   * Account's room or session. It never retargets to another Account.
   */
  observe(target: RoomSettingsTarget): Observable<RoomSettingsSnapshot> {
    return new Observable<RoomSettingsSnapshot>((subscriber) => {
      const current = computed(() => this.snapshot(target));
      subscriber.next(untracked(current));
      // Owned by this subscription: a root-injector effect would outlive it.
      const watcher = effect(() => subscriber.next(current()), {
        injector: this.injector,
        manualCleanup: true,
      });
      return () => watcher.destroy();
    }).pipe(distinctUntilChanged());
  }

  /** One cold state write after the signed-in and permission checks. */
  private write(
    target: RoomSettingsTargetInput,
    operation: string,
    field: keyof RoomSettingsPermissions,
    type: string,
    content: (room: AdministeredRoom | null) => JsonObject,
  ): Observable<void> {
    return defer(() => {
      const key = this.keyOf(target);
      if (!key) throw roomAdministrationNotSignedIn(operation);
      this.permissions.assert(this.permissionsFor(target)[field]);
      return this.engine.setState(
        key.accountId,
        key.roomId,
        type,
        '',
        content(this.store.room(key.accountId, key.roomId)),
      );
    }).pipe(
      unwrapEngineResult(),
      map(() => void 0),
      recoverRoomAdministrationRequest(operation),
    );
  }

  private permissionsFor(
    target: RoomSettingsTargetInput,
  ): RoomSettingsPermissions {
    return typeof target === 'string'
      ? this.permissions.settings(target)
      : this.permissions.settingsFor(target);
  }

  private roomOf(target: RoomSettingsTargetInput): AdministeredRoom | null {
    const key = this.keyOf(target);
    return key ? this.store.room(key.accountId, key.roomId) : null;
  }

  /** The exact target, or the active account's for a bare room ID; null when not live. */
  private keyOf(target: RoomSettingsTargetInput): RoomSettingsTarget | null {
    const key =
      typeof target === 'string'
        ? { accountId: this.session.activeAccountId(), roomId: target }
        : target;
    return key.accountId && this.session.status(key.accountId)
      ? { accountId: key.accountId, roomId: key.roomId }
      : null;
  }
}

function identityOf(room: AdministeredRoom | null): RoomIdentity {
  const name = room?.state.name?.['name'];
  const topic = room?.state.topic?.['topic'];
  const avatar = room?.state.avatar?.['url'];
  return {
    name: typeof name === 'string' ? name : '',
    topic: typeof topic === 'string' ? topic : '',
    avatarMxc: typeof avatar === 'string' && avatar ? avatar : null,
  };
}

function accessOf(room: AdministeredRoom | null): RoomAccess {
  const joinRules = room?.state.joinRules;
  const rule =
    (joinRules?.['join_rule'] as JoinRule | undefined) ?? DEFAULT_JOIN_RULE;
  const historyVisibility = room?.state.historyVisibility?.[
    'history_visibility'
  ] as HistoryVisibility | undefined;
  return {
    joinRule: rule,
    historyVisibility: historyVisibility ?? DEFAULT_HISTORY_VISIBILITY,
    // Only `restricted` and `knock_restricted` have an allow list; a leftover `allow` under
    // another rule is inert and would make a dialog see (and write) an access change that
    // isn't there.
    allowedSpaceIds: allowedSpaceIdsOf(
      takesAllowList(rule) ? joinRules?.['allow'] : undefined,
    ),
  };
}

/** Room version gates; a missing create version means version 1, as js-sdk reads it. */
function versionAtLeast(
  room: AdministeredRoom | null,
  minimum: number,
): boolean {
  if (!room) return false;
  const version = Number.parseInt(
    String(room.state.create?.content['room_version'] ?? '1'),
    10,
  );
  return Number.isFinite(version) && version >= minimum;
}
