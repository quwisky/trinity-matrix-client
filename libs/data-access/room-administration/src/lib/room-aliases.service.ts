import { Injectable, inject } from '@angular/core';
import { EventType, type MatrixClient } from 'matrix-js-sdk';
import { Observable, defer, from, map, of, switchMap, throwError } from 'rxjs';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { liveRoomState } from '@trinity/util/matrix';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import {
  recoverRoomAdministrationRequest,
  roomAdministrationNotSignedIn,
} from './room-administration-error';
import type { RoomSettingsTarget } from './room-settings.service';

/**
 * Manages a room's published addresses: its local aliases in the homeserver's room
 * directory (`getLocalAliases`/`createAlias`/`deleteAlias`) and which one is the main
 * (canonical) address (`m.room.canonical_alias`). Writes are cold Observables; the local
 * alias list is fetched on demand (it isn't part of room state), while the canonical
 * alias is read from synced state. Every read and write resolves the immutable opening
 * Account rather than the currently active client. All alias management is gated on that
 * Account's live power to send the canonical-alias state event.
 */
@Injectable({ providedIn: 'root' })
export class RoomAliasesService {
  private readonly matrix = inject(MatrixClientService);
  private readonly permissions = inject(RoomActionPermissionsService);

  /** The homeserver domain (from the Account ID), for building `#localpart:server`. */
  serverName(target: RoomSettingsTarget): string | null {
    const userId = this.clientFor(target)?.getUserId();
    const colon = userId?.indexOf(':') ?? -1;
    return colon >= 0 ? (userId as string).slice(colon + 1) : null;
  }

  /** The target's local aliases from its Account's directory. Cold — fetches on subscribe. */
  localAliases(target: RoomSettingsTarget): Observable<string[]> {
    return defer(() => {
      const client = this.clientFor(target);
      if (!client) {
        return throwError(() => roomAdministrationNotSignedIn('load-aliases'));
      }
      return from(client.getLocalAliases(target.roomId)).pipe(
        map((res) => res.aliases ?? []),
        recoverRoomAdministrationRequest('load-aliases'),
      );
    });
  }

  /** The target's current canonical (primary) alias, or null, from synced state. */
  currentCanonical(target: RoomSettingsTarget): string | null {
    const client = this.clientFor(target);
    return client ? this.canonicalFrom(client, target.roomId) : null;
  }

  /** Publish a new local alias for the exact Account-and-Room target. Cold. */
  addAlias(target: RoomSettingsTarget, alias: string): Observable<void> {
    return defer(() => {
      const client = this.clientFor(target);
      if (!client) {
        return throwError(() => roomAdministrationNotSignedIn('add-alias'));
      }
      this.permissions.assert(this.permissions.settingsFor(target).aliases);
      return from(client.createAlias(alias, target.roomId)).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('add-alias'),
      );
    });
  }

  /**
   * Remove a local alias from the exact target. A canonical alias is cleared first so
   * synced state never advertises an address that no longer resolves. Cold.
   */
  removeAlias(target: RoomSettingsTarget, alias: string): Observable<void> {
    return defer(() => {
      const client = this.clientFor(target);
      if (!client) {
        return throwError(() => roomAdministrationNotSignedIn('remove-alias'));
      }
      this.permissions.assert(this.permissions.settingsFor(target).aliases);
      const clearPrimary =
        this.canonicalFrom(client, target.roomId) === alias
          ? from(
              client.sendStateEvent(
                target.roomId,
                EventType.RoomCanonicalAlias,
                this.canonicalContentWithoutAlias(client, target.roomId),
                '',
              ),
            ).pipe(
              map(() => true),
              recoverRoomAdministrationRequest('remove-alias'),
            )
          : of(false);

      return clearPrimary.pipe(
        switchMap((primaryCleared) =>
          defer(() => {
            // A sign-out/re-login can replace a client while the first step is in flight.
            // Never continue on a detached client or with revoked authority.
            if (this.clientFor(target) !== client) {
              return throwError(() =>
                roomAdministrationNotSignedIn('remove-alias'),
              );
            }
            this.permissions.assert(
              this.permissions.settingsFor(target).aliases,
            );
            return from(client.deleteAlias(alias)).pipe(
              map(() => void 0),
              recoverRoomAdministrationRequest(
                'remove-alias',
                primaryCleared
                  ? { completedStep: 'canonical-address-cleared' }
                  : undefined,
              ),
            );
          }),
        ),
      );
    });
  }

  /** Set the target's canonical (`m.room.canonical_alias`) alias. Cold. */
  setCanonicalAlias(
    target: RoomSettingsTarget,
    alias: string,
  ): Observable<void> {
    return defer(() => {
      const client = this.clientFor(target);
      if (!client) {
        return throwError(() =>
          roomAdministrationNotSignedIn('set-canonical-alias'),
        );
      }
      this.permissions.assert(this.permissions.settingsFor(target).aliases);
      return from(
        client.sendStateEvent(
          target.roomId,
          EventType.RoomCanonicalAlias,
          { ...this.canonicalContentFrom(client, target.roomId), alias },
          '',
        ),
      ).pipe(
        map(() => void 0),
        recoverRoomAdministrationRequest('set-canonical-alias'),
      );
    });
  }

  /** Whether the opening Account may currently manage this target's addresses. */
  canManageAliases(target: RoomSettingsTarget): boolean {
    return this.permissions.settingsFor(target).aliases.available;
  }

  private clientFor(target: RoomSettingsTarget): MatrixClient | null {
    return this.matrix.clientFor(target.accountId);
  }

  private canonicalFrom(client: MatrixClient, roomId: string): string | null {
    const alias = this.canonicalContentFrom(client, roomId)['alias'];
    return typeof alias === 'string' && alias ? alias : null;
  }

  private canonicalContentFrom(
    client: MatrixClient,
    roomId: string,
  ): Record<string, unknown> {
    const room = client.getRoom(roomId);
    const content = (room ? liveRoomState(room) : undefined)
      ?.getStateEvents(EventType.RoomCanonicalAlias, '')
      ?.getContent();
    return content && typeof content === 'object' ? { ...content } : {};
  }

  private canonicalContentWithoutAlias(
    client: MatrixClient,
    roomId: string,
  ): Record<string, unknown> {
    const content = this.canonicalContentFrom(client, roomId);
    delete content['alias'];
    return content;
  }
}
