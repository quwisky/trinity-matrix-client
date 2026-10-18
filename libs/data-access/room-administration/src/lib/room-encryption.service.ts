import { Injectable, inject } from '@angular/core';
import {
  EventType,
  MatrixError,
  type MatrixClient,
  type Room,
} from 'matrix-js-sdk';
import type { RoomEncryptionEventContent } from 'matrix-js-sdk/lib/@types/state_events';
import { Observable, defer, finalize, from, switchMap, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import {
  applyRoomEncryption,
  isRoomEncrypted,
  roomEncryptionContent,
} from '@trinity/util/matrix';
import { RoomActionPermissionsService } from './room-action-permissions.service';
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
  private readonly matrix = inject(MatrixClientService);
  private readonly permissions = inject(RoomActionPermissionsService);
  /** `${accountId}|${roomId}` of requests in flight. */
  private readonly sending = new Set<string>();

  /**
   * Send `m.room.encryption` with the same Megolm content new rooms get, then apply it to
   * this device's crypto backend. Cold: runs on subscribe. Errors with `partial-update` when
   * the server took the event but this device could not apply it. Errors without sending when
   * the room is already encrypted (by synced state, the crypto store or the server's), a
   * request is in flight, the account is gone or the role does not allow it.
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
        return throwError(() => alreadyEncrypted());
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
      // Sync can miss the event (Tuwunel's state_after race), so the crypto store and the
      // server decide too; a store that cannot answer counts as encrypted.
      return from(isRoomEncrypted(room, client.getCrypto?.())).pipe(
        switchMap((storeEncrypted) =>
          storeEncrypted
            ? Promise.resolve(true)
            : serverHasEncryption(client, target.roomId),
        ),
        switchMap((encrypted) => {
          if (encrypted) return throwError(() => alreadyEncrypted());
          const content = roomEncryptionContent();
          return from(
            client.sendStateEvent(
              target.roomId,
              EventType.RoomEncryption,
              content,
              '',
            ),
          ).pipe(switchMap(() => applyOnThisDevice(client, room, content)));
        }),
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

/**
 * Sync may never deliver the event this device just sent, and until something configures the
 * crypto backend the SDK sends here in the clear, so it is applied now and read back.
 */
async function applyOnThisDevice(
  client: MatrixClient,
  room: Room,
  content: RoomEncryptionEventContent,
): Promise<void> {
  let cause: unknown;
  try {
    if (await applyRoomEncryption(client.getCrypto?.(), room, content)) return;
  } catch (error) {
    cause = error;
  }
  throw new RoomAdministrationError(
    {
      kind: 'rejected',
      failure: 'partial-update',
      recovery: 'review-room-state',
      operation: OPERATION,
    },
    "Encryption is on, but this device couldn't apply it.",
    cause,
  );
}

/** The server's current m.room.encryption, read directly; `M_NOT_FOUND` means none. */
async function serverHasEncryption(
  client: MatrixClient,
  roomId: string,
): Promise<boolean> {
  try {
    await client.getStateEvent(roomId, EventType.RoomEncryption, '');
    return true;
  } catch (error) {
    if (error instanceof MatrixError && error.errcode === 'M_NOT_FOUND') {
      return false;
    }
    throw error;
  }
}
