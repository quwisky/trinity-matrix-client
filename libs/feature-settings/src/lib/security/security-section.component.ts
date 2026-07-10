import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnInit,
  inject,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router } from '@angular/router';
import { HlmButton } from '@trinity/helm/button';
import { CryptoService } from '@trinity/data-access-crypto';
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
  private readonly destroyRef = inject(DestroyRef);

  /** Where this device stands on encryption setup (drives the encryption card). */
  readonly status = this.crypto.status;
  /** Whether a server-side key backup is active for this session. */
  readonly keyBackupActive = this.crypto.keyBackupActive;
  /** Whether this session is cross-signing verified. */
  readonly sessionVerified = this.crypto.thisDeviceVerified;

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

  /** Verify this session against another signed-in one (emoji SAS). */
  verifySession(): void {
    void this.dialogs.openVerify({ returnTo: RETURN_TO });
  }
}
