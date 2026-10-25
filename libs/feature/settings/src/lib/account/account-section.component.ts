import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { Subject, of, startWith, switchMap, tap } from 'rxjs';
import {
  FormField,
  FormRoot,
  form,
  minLength,
  required,
  schema,
  validateTree,
} from '@angular/forms/signals';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnInput,
  TrnPasswordInputComponent,
} from '@trinity/components/controls';
import { runWithBusy } from '@trinity/util/ui';
import { AuthService } from '@trinity/data-access/auth';
import { MatrixClientService } from '@trinity/data-access/matrix-client';
import { ExternalBrowserService } from '@trinity/platform-native';
import { EmailAddressesGroupComponent } from './email-addresses/email-addresses-group.component';
import { DeleteAccountGroupComponent } from './delete-account/delete-account-group.component';
import { serverNameOf } from './delete-account/delete-account.copy';
import {
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
  TrnToastService,
} from '@trinity/components/overlay';

/** Minimum length we require for a new password (a light client-side guard). */
const MIN_PASSWORD = 8;

/** The change-password form's fields. */
type PasswordField = 'currentPassword' | 'newPassword' | 'confirmPassword';

/** The change-password form's model. */
type PasswordModel = Record<PasswordField, string>;

const EMPTY_PASSWORDS: PasswordModel = {
  currentPassword: '',
  newPassword: '',
  confirmPassword: '',
};

/**
 * One message covers every incomplete-field case: the fields are masked, so naming which
 * hidden box is short tells the user little.
 */
const INCOMPLETE = `Fill in every field (new password at least ${MIN_PASSWORD} characters).`;

/**
 * Every rule the change-password form has, including the two that compare fields, so
 * validity is one answer: `submit()` asks the form and reports what it says.
 */
const passwordSchema = schema<PasswordModel>((path) => {
  required(path.currentPassword, { message: INCOMPLETE });
  required(path.newPassword, { message: INCOMPLETE });
  minLength(path.newPassword, MIN_PASSWORD, { message: INCOMPLETE });
  required(path.confirmPassword, { message: INCOMPLETE });

  // Cross-field, so it belongs to the tree: neither password is wrong alone, the pair disagrees.
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
 * Account settings sub-page. On a server using the legacy account API it changes the
 * account's password; on an OAuth 2.0 server (whose provider owns credentials and device
 * management) it links out to the provider's account-management page instead.
 */
@Component({
  selector: 'trn-account-settings',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './account-section.component.html',
  imports: [
    DeleteAccountGroupComponent,
    EmailAddressesGroupComponent,
    TrnSettingsRowComponent,
    TrnSettingsGroupComponent,
    FormField,
    FormRoot,
    TrnButton,
    TrnInput,
    TrnPasswordInputComponent,
  ],
})
export class AccountSectionComponent {
  private readonly auth = inject(AuthService);
  private readonly externalBrowser = inject(ExternalBrowserService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly retries = new Subject<void>();
  /** What a screen reader hears about Try again; the visible text alone isn't announced. */
  protected readonly announcement = signal('');

  /** The account this section shows. */
  readonly accountId = inject(MatrixClientService).activeUserId;

  /** The server's account API; null until it has answered. */
  readonly serverApi = toSignal(
    toObservable(this.accountId).pipe(
      tap(() => this.announcement.set('')),
      switchMap((id) =>
        id
          ? this.retries.pipe(
              startWith(undefined),
              // A retry keeps the current answer while it asks, so Try again keeps focus.
              switchMap((_, retry) => {
                const api = this.auth.accountManagementFor(id);
                return retry === 0
                  ? api.pipe(startWith(null))
                  : api.pipe(
                      tap(({ kind }) =>
                        this.announcement.set(
                          kind === 'unknown'
                            ? 'Still couldn’t load the account options.'
                            : 'Account options loaded.',
                        ),
                      ),
                    );
              }),
            )
          : of(null),
      ),
    ),
    { initialValue: null },
  );

  protected readonly server = computed(() => {
    const id = this.accountId();
    return id ? serverNameOf(id) : '';
  });

  readonly usesProvider = computed(() => this.serverApi()?.kind === 'oauth');

  /** The provider's account-management surface on an OAuth server, else null. */
  readonly accountManagement = computed(() => {
    const api = this.serverApi();
    return api?.kind === 'oauth' ? api.management : null;
  });

  /** Ask the server again after it could not be reached. */
  retryServerApi(): void {
    this.announcement.set('Trying again…');
    this.retries.next();
  }

  /** Open the provider's account-management page (system browser on every platform). */
  openAccountManagement(): void {
    const management = this.accountManagement();
    if (management) {
      this.externalBrowser
        .open(management.url)
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe();
    }
  }

  /** True while the change is in flight (disables the form + Save). */
  readonly saving = signal(false);
  /** Last failure (bad password, mismatch, server error), or null. */
  readonly error = signal<string | null>(null);

  private readonly passwords = signal<PasswordModel>({ ...EMPTY_PASSWORDS });
  readonly form = form(this.passwords, passwordSchema);

  /**
   * The message for whatever is currently wrong. Field errors come before tree errors, so a
   * short password reads as "fill this in properly", not as a mismatch it also has.
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
      // reset(value), not a bare model set: it clears touched/dirty across the tree too, so
      // three required fields aren't left empty-and-touched, a primed error state.
      this.form().reset({ ...EMPTY_PASSWORDS });
      this.toast.show('Password changed.', {
        duration: 3000,
        variant: 'success',
      });
    });
  }
}
