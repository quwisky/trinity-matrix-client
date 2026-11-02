import { Injectable, inject } from '@angular/core';
import { filter, map, switchMap, type Observable } from 'rxjs';
import { AppLockDialogGate } from './app-lock-dialog.gate';
import {
  WorkspaceApplicationSurfaceService,
  WorkspaceNavigationService,
} from '@trinity/application/workspace';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  ACCOUNT_LIFECYCLE_PORT,
  MENTION_HISTORY_LOSS,
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
 * could export or check its keys, so it warns without a backup status. A sign-in that
 * completes behind App lock (an OIDC or SSO callback) asks once the person has unlocked.
 */
@Injectable({ providedIn: 'root' })
export class NewDeviceSignInPresenter implements NewDeviceSignInPort {
  private readonly alert = inject(TrnAlertService);
  private readonly workspace = inject(WorkspaceNavigationService);
  private readonly surfaces = inject(WorkspaceApplicationSurfaceService);
  private readonly dialogGate = inject(AppLockDialogGate);
  private readonly lifecycle = inject(ACCOUNT_LIFECYCLE_PORT);

  confirm(signIn: NewDeviceSignIn): Observable<boolean> {
    return this.dialogGate.whenClear().pipe(
      switchMap(() => this.lifecycle.hasMentionHistory(signIn.userId)),
      switchMap((hasHistory) =>
        this.ask(signIn, hasHistory ? `\n\n${MENTION_HISTORY_LOSS}` : ''),
      ),
    );
  }

  private ask(
    { userId, roomKeysBackedUp }: NewDeviceSignIn,
    historyLoss: string,
  ): Observable<boolean> {
    const replaces = `Signing in again starts a new session for ${userId} and deletes its old session’s keys from this device.`;
    const header = roomKeysAtRiskHeader(roomKeysBackedUp);
    if (roomKeysBackedUp === null) {
      return this.alert.confirm$({
        header,
        message: `${replaces}\n\n${ROOM_KEYS_MAY_BE_LOST}${historyLoss}`,
        confirmText: 'Sign in anyway',
        variant: 'danger',
      });
    }
    return this.alert
      .choose$({
        header,
        message: `${replaces}\n\n${ROOM_KEYS_AT_RISK}${historyLoss}`,
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
