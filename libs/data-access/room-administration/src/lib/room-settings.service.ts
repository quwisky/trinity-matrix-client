import { Injectable, inject } from '@angular/core';
import { EventType, HistoryVisibility, JoinRule } from 'matrix-js-sdk';

// Re-exported because both appear in this service's public surface ({@link RoomAccess},
// {@link RoomSettingsService.setJoinRule}). Callers need the enum *values* to build a
// choice list, and components must never import matrix-js-sdk themselves — so the lib
// that owns the domain hands them out.
export {
  HistoryVisibility,
  JoinRule,
  RestrictedAllowType,
} from 'matrix-js-sdk';
import { Observable, defer, from, map, switchMap, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RestrictedAllowType } from 'matrix-js-sdk';
import type { RoomJoinRulesEventContent } from 'matrix-js-sdk/lib/@types/state_events';
import { liveRoomState } from '@trinity/util/matrix';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import {
  recoverRoomAdministrationRequest,
  roomAdministrationInvalidInput,
  roomAdministrationNotSignedIn,
} from './room-administration-error';

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

  /** Rename the room (`m.room.name`). Cold — runs on subscribe. */
  setName(roomId: string, name: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => roomAdministrationNotSignedIn('set-name'));
      }
      this.permissions.assert(this.permissions.settings(roomId).name);
      return from(this.matrix.instance.setRoomName(roomId, name.trim())).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('set-name'),
      );
    });
  }

  /** Set the room topic (`m.room.topic`); an empty string clears it. Cold. */
  setTopic(roomId: string, topic: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => roomAdministrationNotSignedIn('set-topic'));
      }
      this.permissions.assert(this.permissions.settings(roomId).topic);
      return from(this.matrix.instance.setRoomTopic(roomId, topic.trim())).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('set-topic'),
      );
    });
  }

  /**
   * Upload a picked image and set it as the room avatar (`m.room.avatar`). Cold —
   * uploads on subscribe, then writes the state event pointing at the new mxc.
   */
  setAvatar(roomId: string, file: File): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => roomAdministrationNotSignedIn('set-avatar'));
      }
      this.permissions.assert(this.permissions.settings(roomId).avatar);
      const client = this.matrix.instance;
      return from(
        client.uploadContent(file, {
          name: file.name,
          type: file.type || 'application/octet-stream',
        }),
      ).pipe(
        switchMap((res) =>
          defer(() => {
            if (!this.matrix.isInitialized || this.matrix.instance !== client) {
              throw new Error(
                'The active account changed before the photo uploaded.',
              );
            }
            this.permissions.assert(this.permissions.settings(roomId).avatar);
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
    roomId: string,
    joinRule: JoinRule,
    allowedSpaceIds: readonly string[] = [],
  ): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => roomAdministrationNotSignedIn('set-join-rule'));
      }
      this.permissions.assert(this.permissions.settings(roomId).joinRule);
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
      const content: RoomJoinRulesEventContent = { join_rule: joinRule };
      if (restricted) {
        content.allow = allowedSpaceIds.map((roomId) => ({
          type: RestrictedAllowType.RoomMembership,
          room_id: roomId,
        }));
      }
      return from(
        this.matrix.instance.sendStateEvent(
          roomId,
          EventType.RoomJoinRules,
          content,
          '',
        ),
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
  supportsRestricted(roomId: string): boolean {
    if (!this.matrix.isInitialized) {
      return false;
    }
    const version = Number.parseInt(
      this.matrix.instance.getRoom(roomId)?.getVersion() ?? '',
      10,
    );
    return Number.isFinite(version) && version >= 8;
  }

  /**
   * Set how far back new members can read history (`m.room.history_visibility`).
   * Cold — runs on subscribe.
   */
  setHistoryVisibility(
    roomId: string,
    historyVisibility: HistoryVisibility,
  ): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() =>
          roomAdministrationNotSignedIn('set-history-visibility'),
        );
      }
      this.permissions.assert(this.permissions.settings(roomId).history);
      return from(
        this.matrix.instance.sendStateEvent(
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
  currentIdentity(roomId: string): RoomIdentity {
    const blank: RoomIdentity = { name: '', topic: '', avatarMxc: null };
    if (!this.matrix.isInitialized) {
      return blank;
    }
    const room = this.matrix.instance.getRoom(roomId);
    if (!room) {
      return blank;
    }
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
  currentAccess(roomId: string): RoomAccess {
    const fallback: RoomAccess = {
      joinRule: DEFAULT_JOIN_RULE,
      historyVisibility: DEFAULT_HISTORY_VISIBILITY,
      allowedSpaceIds: [],
    };
    if (!this.matrix.isInitialized) {
      return fallback;
    }
    const room = this.matrix.instance.getRoom(roomId);
    if (!room) {
      return fallback;
    }
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
  editableFields(roomId: string): EditableRoomFields {
    const permissions = this.permissions.settings(roomId);
    return {
      name: permissions.name.available,
      topic: permissions.topic.available,
      avatar: permissions.avatar.available,
      joinRule: permissions.joinRule.available,
      history: permissions.history.available,
    };
  }
}

/**
 * The space ids out of a join-rules `allow` list, ignoring anything that isn't a
 * well-formed room-membership entry, and de-duplicated. The list is arbitrary state written
 * by any client, so a malformed entry has to be dropped rather than surfaced as an
 * empty-string space id that would then be written back — and a repeated entry has to
 * collapse, or a caller comparing this list against one it built cannot tell them apart.
 */
function allowedSpaceIdsOf(allow: unknown): string[] {
  if (!Array.isArray(allow)) {
    return [];
  }
  return allow
    .filter(
      (entry): entry is { type: string; room_id: string } =>
        !!entry &&
        typeof entry === 'object' &&
        (entry as { type?: unknown }).type ===
          RestrictedAllowType.RoomMembership &&
        typeof (entry as { room_id?: unknown }).room_id === 'string' &&
        (entry as { room_id: string }).room_id.length > 0,
    )
    .map((entry) => entry.room_id)
    .filter((roomId, index, ids) => ids.indexOf(roomId) === index);
}
