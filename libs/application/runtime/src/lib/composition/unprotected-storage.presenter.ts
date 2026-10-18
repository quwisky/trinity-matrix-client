import { Injectable, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';
import { TrnAlertService } from '@trinity/components/overlay';
import {
  AccountRuntimeService,
  type UnprotectedStorageConsentPort,
} from '@trinity/data-access/accounts';
import { SecureStorageService } from '@trinity/platform-native';
import {
  EMPTY,
  catchError,
  defer,
  filter,
  ignoreElements,
  switchMap,
  take,
  type Observable,
} from 'rxjs';
import { AppLockDialogGate } from './app-lock-dialog.gate';

const NO_KEYRING = 'This device has no keyring Trinity can use, so';
const READABLE =
  'Anyone who can read your files could use them to read your messages.';

/** The consent a sign-in asks for before storing secrets without a keychain. */
@Injectable({ providedIn: 'root' })
export class UnprotectedStorageConsentPresenter implements UnprotectedStorageConsentPort {
  private readonly alert = inject(TrnAlertService);
  private readonly dialogGate = inject(AppLockDialogGate);

  confirm(): Observable<boolean> {
    return this.dialogGate.whenClear().pipe(
      switchMap(() =>
        this.alert.confirm$({
          header: 'Store this account without a keyring?',
          message: `${NO_KEYRING} this account’s sign-in and encryption keys would be stored unprotected on disk. ${READABLE}\n\nTrinity won’t ask again on this device.`,
          confirmText: 'Store unprotected',
          variant: 'danger',
        }),
      ),
    );
  }
}

/**
 * A one-time notice for accounts stored without a keychain before sign-in asked. Apart from
 * the consent: Account Runtime's adapter needs that one, and this one reads Account Runtime.
 */
@Injectable({ providedIn: 'root' })
export class UnprotectedStorageNotice {
  private readonly alert = inject(TrnAlertService);
  private readonly dialogGate = inject(AppLockDialogGate);
  private readonly secure = inject(SecureStorageService);
  private readonly surfaces = inject(WorkspaceApplicationSurfaceService);
  private readonly signedIn = toObservable(
    inject(AccountRuntimeService).hasActiveAccount,
  );

  /** Completes without emitting; marks the notice shown before showing it. */
  runPendingNotice(): Observable<never> {
    return this.signedIn.pipe(
      filter(Boolean),
      take(1),
      switchMap(() =>
        defer(async () =>
          (await this.secure.storesUnprotectedSecrets()) &&
          (await this.secure.unprotectedStorageAcknowledged()) === null
            ? this.secure
                .acknowledgeUnprotectedStorage('notified')
                .then(() => true)
            : false,
        ),
      ),
      switchMap((show) => (show ? this.dialogGate.whenClear() : EMPTY)),
      switchMap(() =>
        this.alert.confirm$({
          header: 'Your sign-in isn’t protected on this device',
          message: `${NO_KEYRING} your sign-in and encryption keys are stored unprotected on disk. ${READABLE}`,
          confirmText: 'Security settings',
          cancelText: 'Close',
        }),
      ),
      filter(Boolean),
      switchMap(() =>
        this.surfaces.open({
          surface: { kind: 'settings', section: 'security' },
        }),
      ),
      // A notice that cannot be shown must not end the session it runs in.
      catchError(() => EMPTY),
      ignoreElements(),
    );
  }
}
