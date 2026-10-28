import { Injectable, inject } from '@angular/core';
import { Observable, defer, map, of, switchMap, throwError } from 'rxjs';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { unwrapEngineResult } from '@trinity/util/matrix';
import { AdministeredRoomStore } from './administered-room.store';
import { RoomActionPermissionsService } from './room-action-permissions.service';
import type { JsonObject } from './room-administration-engine';
import { ROOM_ADMINISTRATION_ENGINE } from './room-administration-engine.token';
import {
  recoverRoomAdministrationRequest,
  roomAdministrationNotSignedIn,
} from './room-administration-error';
import type { RoomSettingsTarget } from './room-settings.service';

/**
 * Manages a room's published addresses: its local aliases in the homeserver's room
 * directory and which one is the main (canonical) address (`m.room.canonical_alias`).
 * Writes are cold Observables; the local alias list is fetched on demand (it isn't part
 * of room state), while the canonical alias is read from synced state. Every read and
 * write uses the immutable opening Account rather than the active one. All alias
 * management is gated on that Account's live power to send the canonical-alias event.
 */
@Injectable({ providedIn: 'root' })
export class RoomAliasesService {
  private readonly engine = inject(ROOM_ADMINISTRATION_ENGINE);
  private readonly session = inject(SessionStateService);
  private readonly store = inject(AdministeredRoomStore);
  private readonly permissions = inject(RoomActionPermissionsService);

  /** The homeserver domain (from the Account ID), for building `#localpart:server`. */
  serverName(target: RoomSettingsTarget): string | null {
    return this.session.status(target.accountId)
      ? domainOf(target.accountId)
      : null;
  }

  /** The target's local aliases from its Account's directory. Cold — fetches on subscribe. */
  localAliases(target: RoomSettingsTarget): Observable<string[]> {
    return defer(() => {
      this.assertSignedIn(target, 'load-aliases');
      return this.engine.localAliases(target.accountId, target.roomId);
    }).pipe(
      unwrapEngineResult(),
      map((aliases) => [...aliases]),
      recoverRoomAdministrationRequest('load-aliases'),
    );
  }

  /** The target's current canonical (primary) alias, or null, from synced state. */
  currentCanonical(target: RoomSettingsTarget): string | null {
    const alias = this.canonicalContent(target)['alias'];
    return typeof alias === 'string' && alias ? alias : null;
  }

  /** Publish a new local alias for the exact Account-and-Room target. Cold. */
  addAlias(target: RoomSettingsTarget, alias: string): Observable<void> {
    return defer(() => {
      this.assertMayManage(target, 'add-alias');
      return this.engine.publishAlias(target.accountId, target.roomId, alias);
    }).pipe(
      unwrapEngineResult(),
      map(() => void 0),
      recoverRoomAdministrationRequest('add-alias'),
    );
  }

  /**
   * Remove a local alias from the exact target. A canonical alias is cleared first so
   * synced state never advertises an address that no longer resolves. Cold.
   */
  removeAlias(target: RoomSettingsTarget, alias: string): Observable<void> {
    return defer(() => {
      this.assertMayManage(target, 'remove-alias');
      const generation = this.session.status(target.accountId)?.generation;
      const clearPrimary =
        this.currentCanonical(target) === alias
          ? this.writeCanonical(target, withoutAlias).pipe(
              map(() => true),
              recoverRoomAdministrationRequest('remove-alias'),
            )
          : of(false);

      return clearPrimary.pipe(
        switchMap((primaryCleared) =>
          defer(() => {
            // A sign-out/re-login can replace the session while the first step is in
            // flight. Never continue on another session or with revoked authority.
            if (
              this.session.status(target.accountId)?.generation !== generation
            ) {
              return throwError(() =>
                roomAdministrationNotSignedIn('remove-alias'),
              );
            }
            this.permissions.assert(
              this.permissions.settingsFor(target).aliases,
            );
            return this.engine.removeAlias(target.accountId, alias).pipe(
              unwrapEngineResult(),
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
      this.assertMayManage(target, 'set-canonical-alias');
      return this.writeCanonical(target, (content) => ({ ...content, alias }));
    }).pipe(
      map(() => void 0),
      recoverRoomAdministrationRequest('set-canonical-alias'),
    );
  }

  /** Whether the opening Account may currently manage this target's addresses. */
  canManageAliases(target: RoomSettingsTarget): boolean {
    return this.permissions.settingsFor(target).aliases.available;
  }

  private assertSignedIn(target: RoomSettingsTarget, operation: string): void {
    if (!this.session.status(target.accountId)) {
      throw roomAdministrationNotSignedIn(operation);
    }
  }

  private assertMayManage(target: RoomSettingsTarget, operation: string): void {
    this.assertSignedIn(target, operation);
    this.permissions.assert(this.permissions.settingsFor(target).aliases);
  }

  /** Writes the canonical-alias content, keeping keys such as `alt_aliases`. */
  private writeCanonical(
    target: RoomSettingsTarget,
    change: (content: JsonObject) => JsonObject,
  ): Observable<null> {
    return this.engine
      .setState(
        target.accountId,
        target.roomId,
        'm.room.canonical_alias',
        '',
        change(this.canonicalContent(target)),
      )
      .pipe(unwrapEngineResult());
  }

  private canonicalContent(target: RoomSettingsTarget): JsonObject {
    return (
      this.store.room(target.accountId, target.roomId)?.state.canonicalAlias ??
      {}
    );
  }
}

function domainOf(userId: string): string | null {
  const colon = userId.indexOf(':');
  return colon >= 0 ? userId.slice(colon + 1) : null;
}

function withoutAlias(content: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(content).filter(([key]) => key !== 'alias'),
  );
}
