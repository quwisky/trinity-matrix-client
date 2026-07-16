import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { Browser } from '@capacitor/browser';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { HlmLabel } from '@trinity/helm/label';
import { TrnToastService } from '@trinity/helm/overlay';
import { runWithBusy } from '@trinity/ui';
import { AuthService, type AccountManagement } from '@trinity/data-access-auth';

/** Minimum length we require for a new password (a light client-side guard). */
const MIN_PASSWORD = 8;

/**
 * Account settings sub-page. For a password account it changes the account's password;
 * for an OIDC-native account (whose provider owns credentials + device management) it
 * instead links out to the provider's account-management page.
 */
@Component({
  selector: 'trn-account-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './account-section.component.html',
  imports: [ReactiveFormsModule, HlmButton, HlmInput, HlmLabel],
})
export class AccountSectionComponent {
  private readonly auth = inject(AuthService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);

  /** The provider's account-management surface for an OIDC account, else null. */
  readonly accountManagement = signal<AccountManagement | null>(null);

  constructor() {
    this.auth
      .getAccountManagement()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((management) => this.accountManagement.set(management));
  }

  /** Open the provider's account-management page (system browser on every platform). */
  openAccountManagement(): void {
    const management = this.accountManagement();
    if (management) {
      void Browser.open({ url: management.url });
    }
  }

  /** True while the change is in flight (disables the form + Save). */
  readonly saving = signal(false);
  /** Last failure (bad password, mismatch, server error), or null. */
  readonly error = signal<string | null>(null);

  readonly form = new FormGroup({
    currentPassword: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
    newPassword: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required, Validators.minLength(MIN_PASSWORD)],
    }),
    confirmPassword: new FormControl('', {
      nonNullable: true,
      validators: [Validators.required],
    }),
  });

  /** Validate, then change the password; on success clear the form and toast. */
  submit(): void {
    this.error.set(null);
    const { currentPassword, newPassword, confirmPassword } =
      this.form.getRawValue();
    if (this.form.invalid) {
      this.error.set(
        `Fill in every field (new password at least ${MIN_PASSWORD} characters).`,
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      this.error.set('The new passwords don’t match.');
      return;
    }
    if (newPassword === currentPassword) {
      this.error.set('Choose a new password different from the current one.');
      return;
    }
    runWithBusy(this.auth.changePassword(currentPassword, newPassword), {
      busy: this.saving,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe(() => {
      this.form.reset();
      this.toast.show('Password changed.', {
        duration: 3000,
        variant: 'success',
      });
    });
  }
}
