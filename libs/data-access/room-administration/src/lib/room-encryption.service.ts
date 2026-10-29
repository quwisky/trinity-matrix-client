import { Injectable, inject } from '@angular/core';
import { Observable, defer, finalize, map } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { engineFailureMessage, unwrapEngineResult } from '@trinity/util/matrix';
import { AdministeredRoomStore } from './administered-room.store';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import { ROOM_ADMINISTRATION_ENGINE } from './room-administration-engine.token';
import {
  RoomAdministrationError,
  recoverRoomAdministrationRequest,
  roomAdministrationInvalidInput,
  roomAdministrationNotSignedIn,
} from './room-administration-error';
import type { RoomSettingsTarget } from './room-settings.service';

const OPERATION = 'turn-on-encryption';

/**
 * Turns on end-to-end encryption in an existing room. Matrix has no way to turn it off. This
 * device applies the new state at once; other devices get it through sync.
 */
@Injectable({ providedIn: 'root' })
export class RoomEncryptionService {
  private readonly engine = inject(ROOM_ADMINISTRATION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly store = inject(AdministeredRoomStore);
  private readonly permissions = inject(RoomActionPermissionsService);
  /** `${accountId}|${roomId}` of requests in flight. */
  private readonly sending = new Set<string>();

  /**
   * Send `m.room.encryption` with the same Megolm content new rooms get, then apply it to
   * this device's crypto backend. When the server already has the event but this device's
   * crypto store does not, apply the server's content instead of sending. Cold: runs on
   * subscribe. Errors with `partial-update` when the server has the event but this device
   * could not apply it. Errors without sending when synced state or the crypto store already
   * has the room as encrypted, a request is in flight, the account is gone or the role does
   * not allow it.
   */
  turnOn(target: RoomSettingsTarget): Observable<void> {
    return defer(() => {
      const { accountId, roomId } = target;
      const key = `${accountId}|${roomId}`;
      if (!this.session.status(accountId)) {
        throw roomAdministrationNotSignedIn(OPERATION);
      }
      this.permissions.assert(this.permissions.settingsFor(target).encryption);
      const room = this.store.room(accountId, roomId);
      if (!room) throw roomAdministrationNotSignedIn(OPERATION);
      if (room.encryption === 'encrypted') throw alreadyEncrypted();
      if (this.sending.has(key)) {
        throw roomAdministrationInvalidInput(
          OPERATION,
          'Encryption is already being turned on.',
        );
      }
      this.sending.add(key);
      return this.engine.enableEncryption(accountId, roomId).pipe(
        map((result) => {
          if (result.ok) return result;
          switch (result.failure.code) {
            case 'account-not-live':
            case 'room-unavailable':
              throw roomAdministrationNotSignedIn(OPERATION);
            case 'already-encrypted':
              throw alreadyEncrypted();
            case 'encryption-not-applied':
              throw new RoomAdministrationError(
                {
                  kind: 'rejected',
                  failure: 'partial-update',
                  recovery: 'review-room-state',
                  operation: OPERATION,
                },
                engineFailureMessage(result.failure),
              );
          }
          return result;
        }),
        unwrapEngineResult(),
        map(() => void 0),
        recoverRoomAdministrationRequest(OPERATION),
        finalize(() => this.sending.delete(key)),
      );
    });
  }
}

function alreadyEncrypted(): RoomAdministrationError {
  return roomAdministrationInvalidInput(
    OPERATION,
    'This room is already encrypted.',
  );
}
