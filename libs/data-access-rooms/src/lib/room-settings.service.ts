import { Injectable, inject } from '@angular/core';
import { EventType } from 'matrix-js-sdk';
import { Observable, defer, from, map, switchMap, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

/** Which room-settings fields the current user may edit (from the room's power levels). */
export interface EditableRoomFields {
  name: boolean;
  topic: boolean;
  avatar: boolean;
}

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

  /** Which fields the current user's power level lets them edit in `roomId`. */
  editableFields(roomId: string): EditableRoomFields {
    if (!this.matrix.isInitialized) {
      return { name: false, topic: false, avatar: false };
    }
    const client = this.matrix.instance;
    const room = client.getRoom(roomId);
    const userId = client.getUserId();
    if (!room || !userId) {
      return { name: false, topic: false, avatar: false };
    }
    return {
      name: room.currentState.maySendStateEvent(EventType.RoomName, userId),
      topic: room.currentState.maySendStateEvent(EventType.RoomTopic, userId),
      avatar: room.currentState.maySendStateEvent(EventType.RoomAvatar, userId),
    };
  }
}
