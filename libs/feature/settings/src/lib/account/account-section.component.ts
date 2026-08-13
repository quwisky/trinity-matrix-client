import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormField,
  FormRoot,
  form,
  minLength,
  required,
  schema,
  validateTree,
} from '@angular/forms/signals';
import { Browser } from '@capacitor/browser';
import { HlmButton } from '@trinity/helm/button';
import { HlmInput } from '@trinity/helm/input';
import { HlmLabel } from '@trinity/helm/label';
import { TrnToastService } from '@trinity/components/overlay';
import { runWithBusy } from '@trinity/ui';
import { AuthService, type AccountManagement } from '@trinity/data-access/auth';
import { TrnIconComponent } from '@trinity/components/icon';

/** Minimum length we require for a new password (a light client-side guard). */
const MIN_PASSWORD = 8;

/** The password fields, each with its own show/hide reveal toggle. */
type PasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword';

/** The change-password form's model. */
type PasswordModel = Record<PasswordField, string>;

const EMPTY_PASSWORDS: PasswordModel = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

/**
 * One message covers every "you haven't filled this in properly yet" case, because the
 * fields are masked — naming which of three hidden boxes is short tells the user little
 * that re-reading the box would not.
 */
const INCOMPLETE = `Fill in every field (new password at least ${MIN_PASSWORD} characters).`;

/**
 * Every rule the change-password form has, including the two that compare fields.
 *
 * Those two used to live in `submit()`, which meant the form could report itself valid
 * while the handler still refused to send it. Here validity is one answer: `submit()`
 * asks the form and reports what it says.
 */
const passwordSchema = schema<PasswordModel>((path) => {
  required(path.currentPassword, { message: INCOMPLETE });
  required(path.newPassword, { message: INCOMPLETE });
  minLength(path.newPassword, MIN_PASSWORD, { message: INCOMPLETE });
  required(path.confirmPassword, { message: INCOMPLETE });

  // Cross-field, so it belongs to the tree rather than to either field: neither password
  // is wrong on its own, it is the pair that disagrees.
  validateTree(path, ({ value }) => {
    const { currentPassword, newPassword, confirmPassword } = value();
    if (newPassword !== confirmPassword) {
      return {
        kind: 'passwordMismatch',
        message: 'The new passwords don’t match.',
      };
    }
    if (newPassword === currentPassword) {
      return {
        kind: 'passwordReused',
        message: 'Choose a new password different from the current one.',
      };
    }
    return undefined;
  });
});

/**
 * Account settings sub-page. For a password account it changes the account's password;
 * for an OIDC-native account (whose provider owns credentials + device management) it
 * instead links out to the provider's account-management page.
 */
@Component({
  selector: 'trn-account-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './account-section.component.html',
  imports: [
    FormField,
    FormRoot,
    TrnIconComponent,
    HlmButton,
    HlmInput,
    HlmLabel,
  ],
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

  /** Which password fields are currently shown as plain text. */
  readonly revealed = signal<Record<PasswordField, boolean>>({
    currentPassword: false,
    newPassword: false,
    confirmPassword: false,
  });

  /** Flip a single password field between masked and revealed. */
  toggleReveal(field: PasswordField): void {
    this.revealed.update((state) => ({ ...state, [field]: !state[field] }));
  }

  private readonly passwords = signal<PasswordModel>({ ...EMPTY_PASSWORDS });
  readonly form = form(this.passwords, passwordSchema);

  /**
   * The message to show for whatever is currently wrong.
   *
   * Field errors before tree errors, which preserves the order the checks used to run
   * in: a short password reads as "fill this in properly", not as a mismatch it also
   * happens to have.
   */
  private firstError(): string | null {
    const fields = [
      this.form.currentPassword,
      this.form.newPassword,
      this.form.confirmPassword,
    ];
    for (const field of fields) {
      const message = field().errors()[0]?.message;
      if (message) {
        return message;
      }
    }
    return this.form().errors()[0]?.message ?? null;
  }

  /** Validate, then change the password; on success clear the form and toast. */
  submit(): void {
    this.error.set(null);
    const { currentPassword, newPassword } = this.passwords();
    if (this.form().invalid()) {
      this.error.set(this.firstError() ?? INCOMPLETE);
      return;
    }
    runWithBusy(this.auth.changePassword(currentPassword, newPassword), {
      busy: this.saving,
      error: this.error,
      destroyRef: this.destroyRef,
    }).subscribe(() => {
      // reset(value), not a bare model set: it clears touched/dirty across the tree as
      // well as the values, which is what FormControl.reset() used to do. Nothing reads
      // those flags today, but leaving three required fields empty-and-touched is a
      // primed error state waiting for the first thing that does.
      this.form().reset({ ...EMPTY_PASSWORDS });
      this.toast.show('Password changed.', {
        duration: 3000,
        variant: 'success',
      });
    });
  }
}
