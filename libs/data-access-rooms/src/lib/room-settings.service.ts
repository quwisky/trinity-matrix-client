import { Injectable, inject } from '@angular/core';
import { EventType, HistoryVisibility, JoinRule } from 'matrix-js-sdk';
import { Observable, defer, from, map, switchMap, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';
import { liveRoomState } from '@trinity/util-matrix';

/** Which room-settings fields the current user may edit (from the room's power levels). */
export interface EditableRoomFields {
  name: boolean;
  topic: boolean;
  avatar: boolean;
  joinRule: boolean;
  history: boolean;
}

/** A room's access controls: who can join and how far back history is visible. */
export interface RoomAccess {
  joinRule: JoinRule;
  historyVisibility: HistoryVisibility;
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

  /** Rename the room (`m.room.name`). Cold — runs on subscribe. */
  setName(roomId: string, name: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(this.matrix.instance.setRoomName(roomId, name.trim())).pipe(
        map(() => void 0),
      );
    });
  }

  /** Set the room topic (`m.room.topic`); an empty string clears it. Cold. */
  setTopic(roomId: string, topic: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(this.matrix.instance.setRoomTopic(roomId, topic.trim())).pipe(
        map(() => void 0),
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
        return throwError(() => new Error('Not signed in.'));
      }
      const client = this.matrix.instance;
      return from(
        client.uploadContent(file, {
          name: file.name,
          type: file.type || 'application/octet-stream',
        }),
      ).pipe(
        switchMap((res) =>
          from(
            client.sendStateEvent(
              roomId,
              EventType.RoomAvatar,
              { url: res.content_uri },
              '',
            ),
          ),
        ),
        map(() => void 0),
      );
    });
  }

  /**
   * Set who may join the room (`m.room.join_rules`) — e.g. public vs invite-only.
   * Cold — runs on subscribe.
   */
  setJoinRule(roomId: string, joinRule: JoinRule): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.matrix.instance.sendStateEvent(
          roomId,
          EventType.RoomJoinRules,
          { join_rule: joinRule },
          '',
        ),
      ).pipe(map(() => void 0));
    });
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
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.matrix.instance.sendStateEvent(
          roomId,
          EventType.RoomHistoryVisibility,
          { history_visibility: historyVisibility },
          '',
        ),
      ).pipe(map(() => void 0));
    });
  }

  /** The room's current join rule + history visibility, falling back to the spec defaults. */
  currentAccess(roomId: string): RoomAccess {
    const fallback: RoomAccess = {
      joinRule: DEFAULT_JOIN_RULE,
      historyVisibility: DEFAULT_HISTORY_VISIBILITY,
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
    return {
      joinRule: (joinRule as JoinRule) ?? DEFAULT_JOIN_RULE,
      historyVisibility:
        (historyVisibility as HistoryVisibility) ?? DEFAULT_HISTORY_VISIBILITY,
    };
  }

  /** Which fields the current user's power level lets them edit in `roomId`. */
  editableFields(roomId: string): EditableRoomFields {
    const none: EditableRoomFields = {
      name: false,
      topic: false,
      avatar: false,
      joinRule: false,
      history: false,
    };
    if (!this.matrix.isInitialized) {
      return none;
    }
    const client = this.matrix.instance;
    const room = client.getRoom(roomId);
    const userId = client.getUserId();
    if (!room || !userId) {
      return none;
    }
    const state = liveRoomState(room);
    const mayEdit = (type: EventType): boolean =>
      !!state?.maySendStateEvent(type, userId);
    return {
      name: mayEdit(EventType.RoomName),
      topic: mayEdit(EventType.RoomTopic),
      avatar: mayEdit(EventType.RoomAvatar),
      joinRule: mayEdit(EventType.RoomJoinRules),
      history: mayEdit(EventType.RoomHistoryVisibility),
    };
  }
}
