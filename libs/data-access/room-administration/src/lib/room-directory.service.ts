import { Injectable, inject } from '@angular/core';
import { HTTPError, Visibility, type MatrixClient } from 'matrix-js-sdk';
import {
  Observable,
  catchError,
  defer,
  from,
  map,
  throwError,
  type MonoTypeOperatorFunction,
} from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import {
  RoomAdministrationError,
  recoverRoomAdministrationRequest,
  roomAdministrationNotSignedIn,
} from './room-administration-error';
import type { RoomSettingsTarget } from './room-settings.service';

const LOAD = 'load-directory-visibility';
const SET = 'set-directory-visibility';

/**
 * Whether a room is listed in the room directory of the opening Account's homeserver, and
 * changing that. The listing is server-side, not room state, so it is read on demand.
 */
@Injectable({ providedIn: 'root' })
export class RoomDirectoryService {
  private readonly matrix = inject(MatrixClientService);
  private readonly permissions = inject(RoomActionPermissionsService);

  /** The server whose directory the listing is in. */
  serverName(target: RoomSettingsTarget): string | null {
    return this.matrix.clientFor(target.accountId)?.getDomain() ?? null;
  }

  /** Whether the room is listed. Cold: fetches on subscribe. */
  listed(target: RoomSettingsTarget): Observable<boolean> {
    return defer(() => {
      const client = this.clientOrThrow(target, LOAD);
      return from(client.getRoomDirectoryVisibility(target.roomId)).pipe(
        map(({ visibility }) => visibility === Visibility.Public),
        recoverRoomAdministrationRequest(LOAD),
      );
    });
  }

  /**
   * List or unlist the room. Cold. A 403 means the server's publication rules refuse this
   * account (Synapse denies non-admins by default), since the role was checked first.
   */
  setListed(target: RoomSettingsTarget, listed: boolean): Observable<void> {
    return defer(() => {
      const client = this.clientOrThrow(target, SET);
      this.permissions.assert(this.permissions.settingsFor(target).directory);
      return from(
        client.setRoomDirectoryVisibility(
          target.roomId,
          listed ? Visibility.Public : Visibility.Private,
        ),
      ).pipe(
        map(() => void 0),
        serverDenied(),
        recoverRoomAdministrationRequest(SET),
      );
    });
  }

  private clientOrThrow(
    target: RoomSettingsTarget,
    operation: string,
  ): MatrixClient {
    const client = this.matrix.clientFor(target.accountId);
    if (!client) throw roomAdministrationNotSignedIn(operation);
    return client;
  }
}

function serverDenied<T>(): MonoTypeOperatorFunction<T> {
  return catchError((cause: unknown) =>
    throwError(() =>
      cause instanceof HTTPError && cause.httpStatus === 403
        ? new RoomAdministrationError(
            {
              kind: 'rejected',
              failure: 'permission-denied',
              recovery: 'refresh-authority',
              operation: SET,
            },
            "Your server doesn't let you list rooms in its directory.",
            cause,
          )
        : cause,
    ),
  );
}
