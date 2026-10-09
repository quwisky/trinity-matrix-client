import { Injectable, inject } from '@angular/core';
import { filter, map, switchMap, type Observable } from 'rxjs';
import {
  WorkspaceApplicationSurfaceService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  ROOM_KEYS_AT_RISK,
  ROOM_KEYS_MAY_BE_LOST,
  roomKeysAtRiskHeader,
} from '@trinity/data-access/accounts';
import type {
  NewDeviceSignIn,
  NewDeviceSignInPort,
} from '@trinity/data-access/auth';

/**
 * Asks before a sign-in's new device replaces a stored one and deletes its room keys.
 * While the stored session is live it offers the key export first; otherwise nothing
 * could export or check its keys, so it warns without a backup status.
 */
@Injectable({ providedIn: 'root' })
export class NewDeviceSignInPresenter implements NewDeviceSignInPort {
  private readonly alert = inject(TrnAlertService);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly surfaces = inject(WorkspaceApplicationSurfaceService);

  confirm({ userId, roomKeysBackedUp }: NewDeviceSignIn): Observable<boolean> {
    const replaces = `Signing in again starts a new session for ${userId} and deletes its old session’s keys from this device.`;
    const header = roomKeysAtRiskHeader(roomKeysBackedUp);
    if (roomKeysBackedUp === null) {
      return this.alert.confirm$({
        header,
        message: `${replaces}\n\n${ROOM_KEYS_MAY_BE_LOST}`,
        confirmText: 'Sign in anyway',
        variant: 'danger',
      });
    }
    return this.alert
      .choose$({
        header,
        message: `${replaces}\n\n${ROOM_KEYS_AT_RISK}`,
        alternativeText: 'Export keys',
        confirmText: 'Sign in anyway',
        variant: 'danger',
      })
      .pipe(
        map((choice) => {
          if (choice === 'alternative') {
            this.openKeyExport(userId);
          }
          return choice === 'confirm';
        }),
      );
  }

  /** Switch to the stored account and open Security settings, where the export lives. */
  private openKeyExport(userId: string): void {
    this.workspace
      .navigate({ kind: 'account', accountId: userId })
      .pipe(
        filter((outcome) => outcome.kind === 'ready'),
        switchMap(() =>
          this.surfaces.open({
            surface: { kind: 'settings', section: 'security' },
          }),
        ),
      )
      .subscribe({ error: () => undefined });
  }
}
