import { Injectable, Injector, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
  EventType,
  ClientEvent,
  HistoryVisibility,
  JoinRule,
  KnownMembership,
  RoomStateEvent,
  type MatrixClient,
  type MatrixEvent,
  type Room,
  type RoomState,
} from 'matrix-js-sdk';

// Re-exported because both appear in this service's public surface ({@link RoomAccess},
// {@link RoomSettingsService.setJoinRule}). Callers need the enum *values* to build a
// choice list, and components must never import matrix-js-sdk themselves — so the lib
// that owns the domain hands them out.
export {
  HistoryVisibility,
  JoinRule,
  RestrictedAllowType,
} from 'matrix-js-sdk';
import {
  Observable,
  defer,
  from,
  map,
  merge,
  of,
  switchMap,
  throwError,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import type { RoomJoinRulesEventContent } from 'matrix-js-sdk/lib/@types/state_events';
import { liveRoomState } from '@trinity/util/matrix';
import {
  RoomActionPermissionsService,
  type RoomSettingsPermissions,
} from './room-action-permissions.service';
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
   * (MSC3083). Empty for every other rule — and an empty list under `restricted` is a room
   * nobody can join, which is why {@link RoomSettingsService.setJoinRule} refuses to write one.
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

/** SDK-authoritative view for one exact Room settings target. */
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
}

type RoomSettingsTargetInput = RoomSettingsTarget | string;

/** A room with no join-rules state defaults to invite-only, per the Matrix spec. */
const DEFAULT_JOIN_RULE = JoinRule.Invite;
/** A room with no history-visibility state defaults to `shared`, per the spec. */
const DEFAULT_HISTORY_VISIBILITY = HistoryVisibility.Shared;

/**
 * Writes a room's editable metadata — display name (`m.room.name`) and topic
 * (`m.room.topic`) — and reports which the current user may change, from the room's
 * power levels. Writes are cold Observables (fire on subscribe); the synced client
 * reflects the change through its state listeners, so no manual refresh is needed.
 */
@Injectable({ providedIn: 'root' })
export class RoomSettingsService {
  private readonly matrix = inject(MatrixClientService);
  private readonly permissions = inject(RoomActionPermissionsService);
  private readonly injector = inject(Injector);

  /** Rename the room (`m.room.name`). Cold — runs on subscribe. */
  setName(target: RoomSettingsTargetInput, name: string): Observable<void> {
    return defer(() => {
      const context = this.commandContext(target);
      if (!context) {
        return throwError(() => roomAdministrationNotSignedIn('set-name'));
      }
      this.permissions.assert(context.permissions.name);
      return from(context.client.setRoomName(context.roomId, name.trim())).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('set-name'),
      );
    });
  }

  /** Set the room topic (`m.room.topic`); an empty string clears it. Cold. */
  setTopic(target: RoomSettingsTargetInput, topic: string): Observable<void> {
    return defer(() => {
      const context = this.commandContext(target);
      if (!context) {
        return throwError(() => roomAdministrationNotSignedIn('set-topic'));
      }
      this.permissions.assert(context.permissions.topic);
      return from(
        context.client.setRoomTopic(context.roomId, topic.trim()),
      ).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('set-topic'),
      );
    });
  }

  /**
   * Upload a picked image and set it as the room avatar (`m.room.avatar`). Cold —
   * uploads on subscribe, then writes the state event pointing at the new mxc.
   */
  setAvatar(target: RoomSettingsTargetInput, file: File): Observable<void> {
    return defer(() => {
      const context = this.commandContext(target);
      if (!context) {
        return throwError(() => roomAdministrationNotSignedIn('set-avatar'));
      }
      this.permissions.assert(context.permissions.avatar);
      const { client, roomId } = context;
      return from(
        client.uploadContent(file, {
          name: file.name,
          type: file.type || 'application/octet-stream',
        }),
      ).pipe(
        switchMap((res) =>
          defer(() => {
            if (this.clientFor(target) !== client) {
              throw new Error(
                'The originating Account became unavailable before the photo uploaded.',
              );
            }
            this.permissions.assert(this.permissionsFor(target).avatar);
            return from(
              client.sendStateEvent(
                roomId,
                EventType.RoomAvatar,
                { url: res.content_uri },
                '',
              ),
            );
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
    return defer(() => {
      const context = this.commandContext(target);
      if (!context) {
        return throwError(() => roomAdministrationNotSignedIn('set-join-rule'));
      }
      this.permissions.assert(context.permissions.joinRule);
      const { client, roomId } = context;
      const restricted = joinRule === JoinRule.Restricted;
      // A `restricted` rule with no `allow` entries is a room that nobody — not even a
      // member of the space it was gated on — can ever join, and only an admin could undo
      // it. Refused here rather than in the caller: this is the one place every join-rule
      // write passes through, and the failure is unrecoverable from the UI.
      if (restricted && allowedSpaceIds.length === 0) {
        return throwError(() =>
          roomAdministrationInvalidInput(
            'set-join-rule',
            'A restricted join rule needs at least one space to allow in.',
          ),
        );
      }
      const invalidAllowedSpace = invalidAllowedSpaceId(allowedSpaceIds);
      if (restricted && invalidAllowedSpace) {
        return throwError(() =>
          roomAdministrationInvalidInput(
            'set-join-rule',
            'Every allowed Space must have a valid Matrix Room ID.',
          ),
        );
      }
      const content: RoomJoinRulesEventContent = { join_rule: joinRule };
      if (restricted) {
        const room = client.getRoom(roomId);
        const currentAllow = room
          ? liveRoomState(room)
              ?.getStateEvents(EventType.RoomJoinRules, '')
              ?.getContent()?.['allow']
          : undefined;
        content.allow = restrictedAllowEntriesForWrite(
          allowedSpaceIds,
          currentAllow,
        );
      }
      return from(
        client.sendStateEvent(roomId, EventType.RoomJoinRules, content, ''),
      ).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('set-join-rule'),
      );
    });
  }

  /**
   * Whether `roomId` can carry a `restricted` join rule at all. MSC3083 landed in room
   * version 8; sending one to an older room is accepted as an unrecognised string and then
   * enforced by nobody, so the room silently stays as open as it was.
   *
   * False when the version is missing or unparseable — the component must not have to reach
   * for the SDK to find out, which is the whole point of this service.
   */
  supportsRestricted(target: RoomSettingsTargetInput): boolean {
    const room = this.roomFor(target);
    if (!room) return false;
    const version = Number.parseInt(room.getVersion() ?? '', 10);
    return Number.isFinite(version) && version >= 8;
  }

  /**
   * Set how far back new members can read history (`m.room.history_visibility`).
   * Cold — runs on subscribe.
   */
  setHistoryVisibility(
    target: RoomSettingsTargetInput,
    historyVisibility: HistoryVisibility,
  ): Observable<void> {
    return defer(() => {
      const context = this.commandContext(target);
      if (!context) {
        return throwError(() =>
          roomAdministrationNotSignedIn('set-history-visibility'),
        );
      }
      this.permissions.assert(context.permissions.history);
      const { client, roomId } = context;
      return from(
        client.sendStateEvent(
          roomId,
          EventType.RoomHistoryVisibility,
          { history_visibility: historyVisibility },
          '',
        ),
      ).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('set-history-visibility'),
      );
    });
  }

  /**
   * The room's current name, topic and avatar, straight from state — for seeding a settings
   * dialog. Third of the set beside {@link currentAccess} and {@link editableFields}, and like
   * them a synchronous read the opener makes just before the dialog is created.
   *
   * Reads the raw `m.room.name` event, NOT `Room.name`: the SDK's is a *computed display name*
   * that invents one from the member list for a nameless room. Seeding a form field with that
   * fabrication would make "did this field change?" compare the user's input against something
   * nobody ever typed — and then write the invention back as a real name.
   */
  currentIdentity(target: RoomSettingsTargetInput): RoomIdentity {
    const blank: RoomIdentity = { name: '', topic: '', avatarMxc: null };
    const room = this.roomFor(target);
    if (!room) return blank;
    const state = liveRoomState(room);
    const read = (type: EventType, key: string): unknown =>
      state?.getStateEvents(type, '')?.getContent()?.[key];
    const name = read(EventType.RoomName, 'name');
    const topic = read(EventType.RoomTopic, 'topic');
    const avatar = read(EventType.RoomAvatar, 'url');
    return {
      name: typeof name === 'string' ? name : '',
      topic: typeof topic === 'string' ? topic : '',
      avatarMxc: typeof avatar === 'string' && avatar ? avatar : null,
    };
  }

  /** The room's current join rule + history visibility, falling back to the spec defaults. */
  currentAccess(target: RoomSettingsTargetInput): RoomAccess {
    const fallback: RoomAccess = {
      joinRule: DEFAULT_JOIN_RULE,
      historyVisibility: DEFAULT_HISTORY_VISIBILITY,
      allowedSpaceIds: [],
    };
    const room = this.roomFor(target);
    if (!room) return fallback;
    const state = liveRoomState(room);
    const joinRule = state
      ?.getStateEvents(EventType.RoomJoinRules, '')
      ?.getContent()?.['join_rule'];
    const historyVisibility = state
      ?.getStateEvents(EventType.RoomHistoryVisibility, '')
      ?.getContent()?.['history_visibility'];
    const rule = (joinRule as JoinRule) ?? DEFAULT_JOIN_RULE;
    // Only a `restricted` rule has an allow list. A leftover `allow` under any other rule
    // is inert state some client left behind, and surfacing it would make a dialog see an
    // access change where there is none — and then write one.
    const allow =
      rule === JoinRule.Restricted
        ? state?.getStateEvents(EventType.RoomJoinRules, '')?.getContent()?.[
            'allow'
          ]
        : undefined;
    return {
      joinRule: rule,
      historyVisibility:
        (historyVisibility as HistoryVisibility) ?? DEFAULT_HISTORY_VISIBILITY,
      allowedSpaceIds: allowedSpaceIdsOf(allow),
    };
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
    const client = this.matrix.clientFor(target.accountId);
    const room = client?.getRoom(target.roomId) ?? null;
    const joined = room?.getMyMembership() === KnownMembership.Join;
    const availability: RoomSettingsAvailability = !client
      ? 'account-unavailable'
      : !room || !joined
        ? 'room-unavailable'
        : 'available';
    return {
      target,
      availability,
      unavailableReason:
        availability === 'account-unavailable'
          ? 'This Account is no longer available. Your unfinished edits are still here.'
          : availability === 'room-unavailable'
            ? 'This Room is no longer joined for the opening Account. Your unfinished edits are still here.'
            : null,
      openingAccountActive: this.matrix.activeUserId() === target.accountId,
      identity: this.currentIdentity(target),
      access: this.currentAccess(target),
      permissions: this.permissions.settingsFor(target),
      encrypted: room ? room.hasEncryptionStateEvent() : null,
      supportsRestricted: this.supportsRestricted(target),
    };
  }

  /**
   * Observe state for one immutable target. Subscription owns one filtered listener on that
   * Account's client and follows Account removal/replacement without ever retargeting.
   */
  observe(target: RoomSettingsTarget): Observable<RoomSettingsSnapshot> {
    const accountIds = toObservable(this.matrix.accountIds, {
      injector: this.injector,
    });
    const activeAccount = toObservable(this.matrix.activeUserId, {
      injector: this.injector,
    });
    return merge(of(null), accountIds, activeAccount).pipe(
      switchMap(() => this.observeCurrentClient(target)),
    );
  }

  private observeCurrentClient(
    target: RoomSettingsTarget,
  ): Observable<RoomSettingsSnapshot> {
    const client = this.matrix.clientFor(target.accountId);
    if (!client) return of(this.snapshot(target));
    return new Observable((subscriber) => {
      const publish = (): void => subscriber.next(this.snapshot(target));
      const onState = (event: MatrixEvent, state?: RoomState): void => {
        if (
          event.getRoomId() === target.roomId ||
          state?.roomId === target.roomId
        ) {
          publish();
        }
      };
      client.on(RoomStateEvent.Events, onState);
      client.on(ClientEvent.Sync, publish);
      publish();
      return () => {
        client.off(RoomStateEvent.Events, onState);
        client.off(ClientEvent.Sync, publish);
      };
    });
  }

  private commandContext(target: RoomSettingsTargetInput): {
    readonly client: MatrixClient;
    readonly roomId: string;
    readonly permissions: RoomSettingsPermissions;
  } | null {
    const client = this.clientFor(target);
    if (!client) return null;
    return {
      client,
      roomId: typeof target === 'string' ? target : target.roomId,
      permissions: this.permissionsFor(target),
    };
  }

  private permissionsFor(
    target: RoomSettingsTargetInput,
  ): RoomSettingsPermissions {
    return typeof target === 'string'
      ? this.permissions.settings(target)
      : this.permissions.settingsFor(target);
  }

  private roomFor(target: RoomSettingsTargetInput): Room | null {
    const client = this.clientFor(target);
    return (
      client?.getRoom(typeof target === 'string' ? target : target.roomId) ??
      null
    );
  }

  private clientFor(target: RoomSettingsTargetInput): MatrixClient | null {
    if (typeof target !== 'string') {
      return this.matrix.clientFor(target.accountId);
    }
    return this.matrix.isInitialized ? this.matrix.instance : null;
  }
}
