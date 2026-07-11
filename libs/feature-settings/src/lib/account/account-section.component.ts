import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import {
  FormControl,
  FormGroup,
  ReactiveFormsModule,
  Validators,
} from '@angular/forms';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { HlmLabel } from '@trinity/helm/label';
import { TrnToastService } from '@trinity/helm/overlay';
import { runWithBusy } from '@trinity/ui';
import { AuthService } from '@trinity/data-access-auth';

/** Minimum length we require for a new password (a light client-side guard). */
const MIN_PASSWORD = 8;

/** Account settings sub-page: change the signed-in account's password. */
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
