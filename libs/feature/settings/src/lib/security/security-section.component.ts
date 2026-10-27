import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { WorkspaceApplicationSurfaceService } from '@trinity/application/workspace';
import { TrnButton } from '@trinity/components/controls';
import { TrustService } from '@trinity/data-access/trust';
import { SessionStateService } from '@trinity/data-access/matrix-client';
import { HostFileExportService } from '@trinity/runtime/host';
import {
  catchError,
  filter,
  finalize,
  from,
  map,
  of,
  switchMap,
  tap,
} from 'rxjs';
import {
  TrnAlertService,
  TrnSettingsGroupComponent,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  SecureStorageService,
  StoragePersistenceService,
  TrackFileChooserDirective,
} from '@trinity/platform-native';
import { AppLockGroupComponent } from './app-lock-group/app-lock-group.component';

/**
 * Security settings sub-page: this account's end-to-end-encryption posture (secure backup
 * set up, session cross-signing verified, key backup on), launching the existing recovery and
 * verify flows to fix each. It owns no crypto logic: it reads {@link TrustService} status
 * signals and delegates presentation to the Workspace application surface.
 */
@Component({
  selector: 'trn-security-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './security-section.component.html',
  imports: [
    AppLockGroupComponent,
    TrackFileChooserDirective,
    TrnSettingsGroupComponent,
    TrnButton,
  ],
})
export class SecuritySectionComponent {
  private readonly crypto = inject(TrustService);
  private readonly matrix = inject(SessionStateService);
  private readonly applicationSurfaces = inject(
    WorkspaceApplicationSurfaceService,
  );
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly files = inject(HostFileExportService);
  private readonly secure = inject(SecureStorageService);
  private readonly storagePersistence = inject(StoragePersistenceService);
  private destroyed = false;

  /** True when this section is mounted inside the web/Electron settings modal. */
  readonly inSettingsDialog = input(false);

  private readonly fileInput =
    viewChild<ElementRef<HTMLInputElement>>('keyFile');

  /** Where this device stands on encryption setup (drives the encryption card). */
  readonly health = this.crypto.health;
  readonly status = this.crypto.status;
  /** Verified here, but only the device holding the identity can set up recovery. */
  readonly setupElsewhere = this.crypto.recoverySetupElsewhere;
  /** Whether a server-side key backup is active for this session. */
  readonly keyBackupActive = this.crypto.keyBackupActive;
  /** Whether this session is cross-signing verified. */
  readonly sessionVerified = this.crypto.thisDeviceVerified;
  /** False when this device's keys sit in a store created before stores were encrypted. */
  readonly cryptoStoreEncrypted = this.matrix.cryptoStoreEncrypted;
  /** The system may clear local data under storage pressure and can't be asked not to (iOS). */
  readonly localDataEvictable = !this.storagePersistence.offered();
  readonly spaceLow = toSignal(from(this.storagePersistence.spaceLow()), {
    initialValue: false,
  });
  /** Secrets sit unprotected on disk because this host's keychain could not be used. */
  readonly withoutKeychain = toSignal(
    from(this.secure.storesUnprotectedSecrets()).pipe(
      catchError(() => of(false)),
    ),
    { initialValue: false },
  );

  /** True while an export/import is in flight (disables the buttons). */
  readonly busy = signal(false);

  constructor() {
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
  }

  /** First-device setup: generate a recovery key + bootstrap cross-signing/backup. */
  setUp(): void {
    this.openTrustSurface('setup');
  }

  /** Trust this device from the account's saved recovery key. */
  unlock(): void {
    this.openTrustSurface('unlock');
  }

  /**
   * The escape hatch for someone with no key. Same screen as {@link unlock} (one
   * implementation of an irreversible flow), but it arrives with the reset offered.
   */
  resetRecovery(): void {
    this.openTrustSurface('unlock', true);
  }

  /** Verify this session against another signed-in one (emoji SAS). */
  verifySession(): void {
    this.openTrustSurface('verify');
  }

  private openTrustSurface(
    flow: 'setup' | 'unlock' | 'verify',
    offerReset = false,
  ): void {
    const nested = this.inSettingsDialog();
    this.applicationSurfaces
      .open({
        surface: { kind: 'trust', flow },
        context: {
          returnTo: { kind: 'settings', section: 'security' },
          ...(nested
            ? {
                placement: 'nested' as const,
                ownerActive: () => !this.destroyed,
              }
            : {}),
          ...(offerReset ? { offerReset: true } : {}),
        },
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  /** Export this device's room keys to a passphrase-encrypted file. */
  exportKeys(): void {
    this.alert
      .prompt$({
        header: 'Export room keys',
        message:
          'Choose a passphrase to protect the file. You’ll need it to import the keys again.',
        placeholder: 'Passphrase',
        inputType: 'password',
        confirmText: 'Export',
      })
      .pipe(
        filter((passphrase): passphrase is string => Boolean(passphrase)),
        tap(() => this.busy.set(true)),
        switchMap((passphrase) => this.crypto.exportRoomKeys(passphrase)),
        switchMap((armored) =>
          this.files.save({
            bytes: new Blob([armored], { type: 'text/plain' }),
            filename: 'trinity-room-keys.txt',
          }),
        ),
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (outcome) => {
          if (outcome.kind === 'cancelled') return;
          this.toast.show(
            outcome.kind === 'completed'
              ? 'Room keys exported.'
              : 'Could not export your room keys.',
            {
              duration: outcome.kind === 'completed' ? 3000 : 4000,
              variant: outcome.kind === 'completed' ? 'success' : 'danger',
            },
          );
        },
        error: () => {
          this.toast.show('Could not export your room keys.', {
            duration: 4000,
            variant: 'danger',
          });
        },
      });
  }

  /** Open the file picker to import keys from a previously-exported file. */
  pickKeyFile(): void {
    this.fileInput()?.nativeElement.click();
  }

  /** Read the picked export file, prompt for its passphrase, and import the keys. */
  onKeyFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file
    if (!file) {
      return;
    }
    this.alert
      .prompt$({
        header: 'Import room keys',
        message: 'Enter the passphrase this file was exported with.',
        placeholder: 'Passphrase',
        inputType: 'password',
        confirmText: 'Import',
      })
      .pipe(
        filter((passphrase): passphrase is string => Boolean(passphrase)),
        switchMap((passphrase) =>
          from(file.text()).pipe(map((armored) => ({ armored, passphrase }))),
        ),
        tap(() => this.busy.set(true)),
        switchMap(({ armored, passphrase }) =>
          this.crypto.importRoomKeys(armored, passphrase),
        ),
        finalize(() => this.busy.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: () => {
          this.toast.show('Room keys imported.', {
            duration: 3000,
            variant: 'success',
          });
        },
        error: (err: unknown) => {
          this.toast.show(
            err instanceof Error
              ? err.message
              : 'Could not import the room keys.',
            { duration: 4000, variant: 'danger' },
          );
        },
      });
  }
}
