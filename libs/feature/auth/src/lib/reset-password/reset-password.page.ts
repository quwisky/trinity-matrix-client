import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormField,
  disabled,
  email,
  form,
  required,
  validate,
} from '@angular/forms/signals';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  TrnButton,
  TrnCheckboxComponent,
  TrnFieldImports,
  TrnInput,
  TrnPasswordInputComponent,
} from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { TrnCardImports } from '@trinity/components/navigation-layout';
import {
  AUTHENTICATION_HOMESERVER_DISCOVERY,
  PasswordResetWorkflow,
  type PendingReset,
  type ResetRefused,
} from '@trinity/data-access/auth';
import { shownError } from '@trinity/util/ui';
import { finalize, type Observable } from 'rxjs';
import { AuthCardComponent } from '../auth-card/auth-card.component';
import { RESET_PASSWORD_COPY, refusalMessage } from './reset-password.copy';

type ResetStep = 'email' | 'sent' | 'password';

/** Reset a forgotten password with a link sent to the account's email address. */
@Component({
  selector: 'trn-reset-password-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './reset-password.page.html',
  styleUrl: './reset-password.page.scss',
  imports: [
    AuthCardComponent,
    FormField,
    RouterLink,
    TrnButton,
    TrnCardImports,
    TrnCheckboxComponent,
    TrnFieldImports,
    TrnInput,
    TrnPasswordInputComponent,
    TrnSpinnerComponent,
  ],
})
export class ResetPasswordPage {
  private readonly workflow = inject(PasswordResetWorkflow);
  private readonly discovery = inject(AUTHENTICATION_HOMESERVER_DISCOVERY);
  private readonly router = inject(Router);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly heading = viewChild<ElementRef<HTMLElement>>('heading');
  private readonly queryParams = inject(ActivatedRoute).snapshot.queryParamMap;
  private readonly homeserverInput =
    this.queryParams.get('homeserver')?.trim() ?? '';
  private readonly addMode = this.queryParams.has('add');
  protected readonly loginParams = {
    ...(this.homeserverInput ? { homeserver: this.homeserverInput } : {}),
    ...(this.addMode ? { add: '' } : {}),
  };
  // Reset spends its single-use credentials, so the page stays busy once it succeeds.
  private resetDone = false;
  private waitTimer: ReturnType<typeof setInterval> | undefined;

  protected readonly copy = RESET_PASSWORD_COPY;
  protected readonly shownError = shownError;

  protected readonly step = signal<ResetStep>('email');
  protected readonly pending = signal<PendingReset | null>(null);
  protected readonly baseUrl = signal<string | null>(null);
  protected readonly discovering = signal(false);
  protected readonly busy = signal(false);
  protected readonly refusal = signal<ResetRefused | null>(null);
  protected readonly waitSeconds = signal(0);
  protected readonly errorMessage = computed(() => {
    const refusal = this.refusal();
    return refusal ? refusalMessage(refusal) : '';
  });

  private readonly emailModel = signal({ email: '' });
  protected readonly emailForm = form(this.emailModel, (path) => {
    required(path.email, { message: RESET_PASSWORD_COPY.emailRequired });
    email(path.email, { message: RESET_PASSWORD_COPY.emailInvalid });
    disabled(path.email, { when: () => this.busy() });
  });

  private readonly passwordModel = signal({
    password: '',
    confirmation: '',
    logoutDevices: true,
  });
  protected readonly passwordForm = form(this.passwordModel, (path) => {
    required(path.password, { message: RESET_PASSWORD_COPY.passwordRequired });
    required(path.confirmation, {
      message: RESET_PASSWORD_COPY.confirmRequired,
    });
    validate(path.confirmation, ({ value, valueOf }) =>
      value() === valueOf(path.password)
        ? undefined
        : { kind: 'passwordMismatch', message: RESET_PASSWORD_COPY.mismatch },
    );
    disabled(path.password, { when: () => this.busy() });
    disabled(path.confirmation, { when: () => this.busy() });
  });

  constructor() {
    this.destroyRef.onDestroy(() => clearInterval(this.waitTimer));
    this.discover();
  }

  protected send(): void {
    if (this.busy()) return;
    // The address validator rejects stray spaces, so settle them before it runs.
    this.emailForm.email().value.update((value) => value.trim());
    this.emailForm.email().markAsTouched();
    const baseUrl = this.baseUrl();
    if (!baseUrl || this.emailForm().invalid()) return;
    this.run(
      this.workflow.sendLink(baseUrl, this.emailModel().email),
      (result) => {
        if (result.kind === 'refused') return this.refuse(result);
        this.pending.set(result.pending);
        this.goTo('sent');
      },
    );
  }

  protected resend(): void {
    const pending = this.pending();
    if (this.busy() || !pending) return;
    this.run(this.workflow.resend(pending), (result) => {
      if (result.kind === 'refused') return this.refuse(result);
      this.pending.set(result.pending);
    });
  }

  protected submitReset(): void {
    if (this.busy()) return;
    this.passwordForm.password().markAsTouched();
    this.passwordForm.confirmation().markAsTouched();
    const pending = this.pending();
    if (!pending || this.passwordForm().invalid()) return;
    const { password, logoutDevices } = this.passwordModel();
    this.run(
      this.workflow.reset(pending, password, logoutDevices),
      (result) => {
        if (result.kind === 'refused') {
          if (result.refusal === 'not-confirmed') this.goTo('sent');
          this.refuse(result);
          return;
        }
        this.resetDone = true;
        void this.router.navigate(['/login'], {
          queryParams: {
            homeserver: this.homeserverInput,
            ...(this.addMode ? { add: '' } : {}),
          },
          state: { passwordReset: true },
        });
      },
    );
  }

  protected goTo(step: ResetStep): void {
    this.refusal.set(null);
    this.step.set(step);
    afterNextRender(() => this.heading()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  private run<T>(source: Observable<T>, onResult: (result: T) => void): void {
    this.busy.set(true);
    this.refusal.set(null);
    source
      .pipe(
        finalize(() => this.busy.set(this.resetDone)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(onResult);
  }

  private refuse(refused: ResetRefused): void {
    this.refusal.set(refused);
    if (refused.retryAfterMs !== undefined)
      this.startWait(refused.retryAfterMs);
  }

  private startWait(ms: number): void {
    clearInterval(this.waitTimer);
    this.waitSeconds.set(Math.ceil(ms / 1000));
    this.waitTimer = setInterval(() => {
      this.waitSeconds.update((s) => Math.max(0, s - 1));
      if (this.waitSeconds() === 0) clearInterval(this.waitTimer);
    }, 1000);
  }

  private discover(): void {
    if (!this.homeserverInput) return;
    this.discovering.set(true);
    this.discovery
      .discover(this.homeserverInput)
      .pipe(
        finalize(() => this.discovering.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ({ baseUrl }) => this.baseUrl.set(baseUrl),
        // No base URL leaves the page on its choose-a-server message.
        error: () => undefined,
      });
  }
}
