import { Injectable, inject } from '@angular/core';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { EngineRequestError, unwrapEngineResult } from '@trinity/util/matrix';
import {
  Observable,
  catchError,
  defer,
  map,
  throwError,
  type MonoTypeOperatorFunction,
} from 'rxjs';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import { ROOM_ADMINISTRATION_ENGINE } from './room-administration-engine.token';
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
  private readonly engine = inject(ROOM_ADMINISTRATION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly permissions = inject(RoomActionPermissionsService);

  /** The server whose directory the listing is in: the Account ID's domain. */
  serverName(target: RoomSettingsTarget): string | null {
    const colon = target.accountId.indexOf(':');
    return this.session.status(target.accountId) && colon >= 0
      ? target.accountId.slice(colon + 1)
      : null;
  }

  /** Whether the room is listed. Cold: fetches on subscribe. */
  listed(target: RoomSettingsTarget): Observable<boolean> {
    return defer(() => {
      this.assertSignedIn(target, LOAD);
      return this.engine.directoryVisibility(target.accountId, target.roomId);
    }).pipe(
      unwrapEngineResult(),
      map((visibility) => visibility === 'public'),
      recoverRoomAdministrationRequest(LOAD),
    );
  }

  /**
   * List or unlist the room. Cold. A 403 means the server's publication rules refuse this
   * account (Synapse denies non-admins by default), since the role was checked first.
   */
  setListed(target: RoomSettingsTarget, listed: boolean): Observable<void> {
    return defer(() => {
      this.assertSignedIn(target, SET);
      this.permissions.assert(this.permissions.settingsFor(target).directory);
      return this.engine
        .setDirectoryVisibility(
          target.accountId,
          target.roomId,
          listed ? 'public' : 'private',
        )
        .pipe(unwrapEngineResult(), serverDenied());
    }).pipe(
      map(() => void 0),
      recoverRoomAdministrationRequest(SET),
    );
  }

  private assertSignedIn(target: RoomSettingsTarget, operation: string): void {
    if (!this.session.status(target.accountId)) {
      throw roomAdministrationNotSignedIn(operation);
    }
  }
}

function serverDenied<T>(): MonoTypeOperatorFunction<T> {
  return catchError((cause: unknown) =>
    throwError(() =>
      cause instanceof EngineRequestError &&
      cause.failure.diagnostic.httpStatus === 403
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
