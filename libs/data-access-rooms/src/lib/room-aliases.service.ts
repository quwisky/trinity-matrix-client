import { Injectable, inject } from '@angular/core';
import { EventType } from 'matrix-js-sdk';
import { Observable, defer, from, map, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access-matrix-client';

/**
 * Manages a room's published addresses: its local aliases in the homeserver's room
 * directory (`getLocalAliases`/`createAlias`/`deleteAlias`) and which one is the main
 * (canonical) address (`m.room.canonical_alias`). Writes are cold Observables; the local
 * alias list is fetched on demand (it isn't part of room state), while the canonical
 * alias is read from synced state. All alias management is gated on the viewer's power to
 * send the canonical-alias state event.
 */
@Injectable({ providedIn: 'root' })
export class RoomAliasesService {
  private readonly matrix = inject(MatrixClientService);

  /** The homeserver domain (from the signed-in user ID), for building `#localpart:server`. */
  serverName(): string | null {
    if (!this.matrix.isInitialized) {
      return null;
    }
    const userId = this.matrix.instance.getUserId();
    const colon = userId?.indexOf(':') ?? -1;
    return colon >= 0 ? (userId as string).slice(colon + 1) : null;
  }

  /** The room's local aliases from the directory. Cold — fetches on subscribe. */
  localAliases(roomId: string): Observable<string[]> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(this.matrix.instance.getLocalAliases(roomId)).pipe(
        map((res) => res.aliases ?? []),
      );
    });
  }

  /** The room's current canonical (main) alias, or null. Read from synced state. */
  currentCanonical(roomId: string): string | null {
    if (!this.matrix.isInitialized) {
      return null;
    }
    const room = this.matrix.instance.getRoom(roomId);
    const alias = room?.currentState
      .getStateEvents(EventType.RoomCanonicalAlias, '')
      ?.getContent()?.['alias'];
    return typeof alias === 'string' && alias ? alias : null;
  }

  /** Publish a new local alias for the room in the directory. Cold — runs on subscribe. */
  addAlias(roomId: string, alias: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(this.matrix.instance.createAlias(alias, roomId)).pipe(
        map(() => void 0),
      );
    });
  }

  /** Remove a local alias from the directory. Cold — runs on subscribe. */
  removeAlias(alias: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(this.matrix.instance.deleteAlias(alias)).pipe(
        map(() => void 0),
      );
    });
  }

  /** Set the room's main (canonical) alias (`m.room.canonical_alias`). Cold. */
  setCanonicalAlias(roomId: string, alias: string): Observable<void> {
    return defer(() => {
      if (!this.matrix.isInitialized) {
        return throwError(() => new Error('Not signed in.'));
      }
      return from(
        this.matrix.instance.sendStateEvent(
          roomId,
          EventType.RoomCanonicalAlias,
          { alias },
          '',
        ),
      ).pipe(map(() => void 0));
    });
  }

  /** Whether the viewer's power level lets them manage the room's addresses. */
  canManageAliases(roomId: string): boolean {
    if (!this.matrix.isInitialized) {
      return false;
    }
    const client = this.matrix.instance;
    const room = client.getRoom(roomId);
    const me = client.getUserId();
    if (!room || !me) {
      return false;
    }
    return room.currentState.maySendStateEvent(
      EventType.RoomCanonicalAlias,
      me,
    );
  }
}
