import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  OnInit,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { HlmButton } from '@trinity/helm/button';
import { TrnAlertService, TrnToastService } from '@trinity/helm/overlay';
import { CryptoService } from '@trinity/data-access/crypto';
import { EncryptionDialogService } from '@trinity/ui';

/** Where the encryption flows return after finishing on the routed (mobile) path. */
const RETURN_TO = '/settings/security';

/**
 * Security settings sub-page: surfaces this account's end-to-end-encryption posture —
 * whether encryption/secure-backup is set up, whether this session is cross-signing
 * verified, and whether key backup is on — and launches the existing recovery/verify
 * flows to fix each. It owns no crypto logic; it reads {@link CryptoService} status
 * signals and delegates to the setup route + {@link EncryptionDialogService}.
 */
@Component({
  selector: 'trn-security-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './security-section.component.html',
  imports: [HlmButton],
})
export class SecuritySectionComponent implements OnInit {
  private readonly crypto = inject(CryptoService);
  private readonly dialogs = inject(EncryptionDialogService);
  private readonly router = inject(Router);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  private readonly fileInput =
    viewChild<ElementRef<HTMLInputElement>>('keyFile');

  /** Where this device stands on encryption setup (drives the encryption card). */
  readonly status = this.crypto.status;
  /** Whether a server-side key backup is active for this session. */
  readonly keyBackupActive = this.crypto.keyBackupActive;
  /** Whether this session is cross-signing verified. */
  readonly sessionVerified = this.crypto.thisDeviceVerified;

  /** True while an export/import is in flight (disables the buttons). */
  readonly busy = signal(false);

  ngOnInit(): void {
    // Recompute against the live crypto state when the page opens (it's connected at
    // shell startup, but a re-read guarantees the panel reflects the current account).
    this.crypto.refresh().pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }

  /** First-device setup: generate a recovery key + bootstrap cross-signing/backup. */
  setUp(): void {
    void this.router.navigate(['/encryption/setup'], {
      queryParams: { returnTo: RETURN_TO },
    });
  }

  /** Trust this device from the account's saved recovery key. */
  unlock(): void {
    void this.dialogs.openUnlock({ returnTo: RETURN_TO });
  }

  /**
   * The escape hatch for someone with no key. Same screen as {@link unlock} — there is
   * one implementation of an irreversible flow — but it arrives with the reset offered,
   * rather than asking the user to find the same words a second time.
   */
  resetRecovery(): void {
    void this.dialogs.openUnlock({ returnTo: RETURN_TO, offerReset: true });
  }

  /** Verify this session against another signed-in one (emoji SAS). */
  verifySession(): void {
    void this.dialogs.openVerify({ returnTo: RETURN_TO });
  }

  /** Export this device's room keys to a passphrase-encrypted file. */
  async exportKeys(): Promise<void> {
    const passphrase = await this.alert.prompt({
      header: 'Export room keys',
      message:
        'Choose a passphrase to protect the file. You’ll need it to import the keys again.',
      placeholder: 'Passphrase',
      inputType: 'password',
      confirmText: 'Export',
    });
    if (!passphrase) {
      return;
    }
    this.busy.set(true);
    this.crypto
      .exportRoomKeys(passphrase)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (armored) => {
          this.busy.set(false);
          this.download(armored);
          this.toast.show('Room keys exported.', {
            duration: 3000,
            variant: 'success',
          });
        },
        error: () => {
          this.busy.set(false);
          this.toast.show('Could not export your room keys.', {
            duration: 4000,
            variant: 'destructive',
          });
        },
      });
  }

  /** Open the file picker to import keys from a previously-exported file. */
  pickKeyFile(): void {
    this.fileInput()?.nativeElement.click();
  }

  /** Read the picked export file, prompt for its passphrase, and import the keys. */
  async onKeyFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow re-picking the same file
    if (!file) {
      return;
    }
    const passphrase = await this.alert.prompt({
      header: 'Import room keys',
      message: 'Enter the passphrase this file was exported with.',
      placeholder: 'Passphrase',
      inputType: 'password',
      confirmText: 'Import',
    });
    if (!passphrase) {
      return;
    }
    const armored = await file.text();
    this.busy.set(true);
    this.crypto
      .importRoomKeys(armored, passphrase)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.busy.set(false);
          this.toast.show('Room keys imported.', {
            duration: 3000,
            variant: 'success',
          });
        },
        error: (err: unknown) => {
          this.busy.set(false);
          this.toast.show(
            err instanceof Error
              ? err.message
              : 'Could not import the room keys.',
            { duration: 4000, variant: 'destructive' },
          );
        },
      });
  }

  /** Trigger a browser download of the armored key file (data URL — no blob URL needed). */
  private download(armored: string): void {
    const anchor = document.createElement('a');
    anchor.href =
      'data:text/plain;charset=utf-8,' + encodeURIComponent(armored);
    anchor.download = 'trinity-room-keys.txt';
    anchor.click();
  }
}
