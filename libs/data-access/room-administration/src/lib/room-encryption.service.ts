import { Injectable, inject } from '@angular/core';
import { EventType } from 'matrix-js-sdk';
import { Observable, defer, finalize, from, map, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { roomEncryptionContent } from '@trinity/util/matrix';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import {
  recoverRoomAdministrationRequest,
  roomAdministrationInvalidInput,
  roomAdministrationNotSignedIn,
} from './room-administration-error';
import type { RoomSettingsTarget } from './room-settings.service';

const OPERATION = 'turn-on-encryption';

/**
 * Turns on end-to-end encryption in an existing room. Matrix has no way to turn it off, and
 * the new state arrives through sync like any other room state.
 */
@Injectable({ providedIn: 'root' })
export class RoomEncryptionService {
  private readonly matrix = inject(MatrixClientService);
  private readonly permissions = inject(RoomActionPermissionsService);
  /** `${accountId}|${roomId}` of requests in flight. */
  private readonly sending = new Set<string>();

  /**
   * Send `m.room.encryption` with the same Megolm content new rooms get. Cold: runs on
   * subscribe. Errors without sending when the room is already encrypted, a request is in
   * flight, the account is gone or the role does not allow it.
   */
  turnOn(target: RoomSettingsTarget): Observable<void> {
    return defer(() => {
      const key = `${target.accountId}|${target.roomId}`;
      const client = this.matrix.clientFor(target.accountId);
      if (!client) {
        return throwError(() => roomAdministrationNotSignedIn(OPERATION));
      }
      this.permissions.assert(this.permissions.settingsFor(target).encryption);
      const room = client.getRoom(target.roomId);
      if (!room) {
        return throwError(() => roomAdministrationNotSignedIn(OPERATION));
      }
      // A second m.room.encryption replaces the algorithm and rotation settings every
      // member's client is using, so an encrypted room is never sent one.
      if (room.hasEncryptionStateEvent()) {
        return throwError(() =>
          roomAdministrationInvalidInput(
            OPERATION,
            'This room is already encrypted.',
          ),
        );
      }
      if (this.sending.has(key)) {
        return throwError(() =>
          roomAdministrationInvalidInput(
            OPERATION,
            'Encryption is already being turned on.',
          ),
        );
      }
      this.sending.add(key);
      return from(
        client.sendStateEvent(
          target.roomId,
          EventType.RoomEncryption,
          roomEncryptionContent(),
          '',
        ),
      ).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest(OPERATION),
        finalize(() => this.sending.delete(key)),
      );
    });
  }
}
