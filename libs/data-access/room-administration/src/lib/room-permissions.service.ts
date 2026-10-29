import { Injectable, inject } from '@angular/core';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { unwrapEngineResult } from '@trinity/util/matrix';
import { defer, map, throwError, type Observable } from 'rxjs';
import { AdministeredRoomStore } from './administered-room.store';
import type { JsonObject } from './room-administration-engine';
import { ROOM_ADMINISTRATION_ENGINE } from './room-administration-engine.token';
import {
  RoomActionPermissionError,
  RoomActionPermissionsService,
  type ActionAvailability,
} from './room-action-permissions.service';
import {
  recoverRoomAdministrationRequest,
  roomAdministrationNotSignedIn,
} from './room-administration-error';
import {
  MAX_POWER_LEVEL,
  applyChanges,
  permissionRows,
  readRows,
  type PermissionLevel,
  type PermissionRow,
  type PermissionTargetKind,
  type PowerLevelsContent,
} from './room-permission-rows';
import { powerValue } from './room-power';

export interface RoomPermissionsKey {
  readonly accountId: string;
  readonly roomId: string;
}

export interface PermissionRowView {
  readonly row: PermissionRow;
  readonly level: PermissionLevel;
  readonly editable: boolean;
  readonly reason: string | null;
}

export interface RoomPermissionsView {
  readonly rows: readonly PermissionRowView[];
  /** `Infinity` for a v12 creator. */
  readonly myPower: number;
  readonly editable: boolean;
  readonly reason: string | null;
  /** No `users` entry and not a creator: the role comes from `users_default`. */
  readonly powerFromDefault: boolean;
  readonly permissionsLevel: number;
}

const OPERATION = 'set-room-permissions';
const HIGHER_ROLE = 'Only someone with a higher role can change this';

interface Live {
  readonly content: PowerLevelsContent | null;
  readonly myPower: number;
  readonly powerFromDefault: boolean;
}

/** Live view and cold save of a room's `m.room.power_levels`, for the permissions editor. */
@Injectable({ providedIn: 'root' })
export class RoomPermissionsService {
  private readonly engine = inject(ROOM_ADMINISTRATION_ENGINE);
  private readonly store = inject(AdministeredRoomStore);
  private readonly session = inject(SessionStateService);
  private readonly permissions = inject(RoomActionPermissionsService);

  view(
    key: RoomPermissionsKey,
    kind: PermissionTargetKind,
  ): RoomPermissionsView {
    const section = this.section(key, kind);
    const live = this.live(key);
    const content = live.content ?? {};
    const rows = permissionRows(kind);
    const levels = readRows(content, rows);
    return {
      rows: rows.map((row) => {
        const editable =
          section.available && this.rowMax(content, row) <= live.myPower;
        return {
          row,
          level: levels.get(row.id) ?? 0,
          editable,
          reason: editable ? null : (section.reason ?? HIGHER_ROLE),
        };
      }),
      myPower: live.myPower,
      editable: section.available,
      reason: section.reason,
      powerFromDefault: live.powerFromDefault,
      permissionsLevel: this.rowMax(
        content,
        rows.find((r) => r.id === 'permissions') as PermissionRow,
      ),
    };
  }

  save(
    key: RoomPermissionsKey,
    kind: PermissionTargetKind,
    changes: ReadonlyMap<string, number>,
  ): Observable<void> {
    return defer(() => {
      if (!this.session.status(key.accountId)) {
        return throwError(() => roomAdministrationNotSignedIn(OPERATION));
      }
      this.permissions.assert(this.section(key, kind));
      const live = this.live(key);
      const content = live.content ?? {};
      const rows = permissionRows(kind);
      for (const [id, level] of changes) {
        const row = rows.find((r) => r.id === id);
        if (!row) continue;
        if (
          !Number.isInteger(level) ||
          Math.abs(level) > MAX_POWER_LEVEL ||
          level > live.myPower ||
          this.rowMax(content, row) > live.myPower
        ) {
          return throwError(
            () =>
              new RoomActionPermissionError({
                available: false,
                reason: HIGHER_ROLE,
              }),
          );
        }
      }
      return this.engine
        .setState(
          key.accountId,
          key.roomId,
          'm.room.power_levels',
          '',
          applyChanges(content, rows, changes) as JsonObject,
        )
        .pipe(unwrapEngineResult());
    }).pipe(
      map(() => undefined),
      recoverRoomAdministrationRequest<void>(OPERATION),
    );
  }

  /** Reads `settingsFor`, which subscribes the caller to the projection revision. */
  private section(
    key: RoomPermissionsKey,
    kind: PermissionTargetKind,
  ): ActionAvailability {
    const { permissions } = this.permissions.settingsFor(key);
    if (!permissions.available) {
      return {
        available: false,
        reason:
          kind === 'space'
            ? (permissions.reason?.replace("room's", "space's") ?? null)
            : permissions.reason,
      };
    }
    return this.live(key).content
      ? permissions
      : {
          available: false,
          reason: 'This room has no permission settings to edit.',
        };
  }

  private live(key: RoomPermissionsKey): Live {
    const room = this.store.room(key.accountId, key.roomId);
    if (room?.ownMembership !== 'join') {
      return { content: null, myPower: 0, powerFromDefault: false };
    }
    const content = room.powerLevels;
    const myPower = powerValue(room.ownPower);
    const users = content?.['users'];
    const listed =
      typeof users === 'object' && users !== null && room.ownUserId in users;
    return {
      content,
      myPower,
      powerFromDefault: !listed && myPower !== Infinity,
    };
  }

  /** A mixed row counts as its highest type. */
  private rowMax(content: PowerLevelsContent, row: PermissionRow): number {
    const parts = row.writes.map((w, i) => ({
      ...row,
      id: `${i}`,
      writes: [w],
    }));
    return Math.max(
      ...[...readRows(content, parts).values()].map((l) =>
        l === 'mixed' ? 0 : l,
      ),
    );
  }
}
