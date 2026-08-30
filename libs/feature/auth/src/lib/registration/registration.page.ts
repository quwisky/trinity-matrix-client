import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  OnDestroy,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormField,
  disabled,
  email,
  form,
  required,
  submit,
  validate,
} from '@angular/forms/signals';
import { ActivatedRoute, Router } from '@angular/router';
import { finalize, forkJoin, map, switchMap, throwError } from 'rxjs';
import { TrnButton } from '@trinity/components/button';
import { AuthCardComponent } from '../auth-card/auth-card.component';
import { TrnCardImports } from '@trinity/components/card';
import { TrnCheckboxComponent } from '@trinity/components/checkbox';
import { TrnIconComponent } from '@trinity/components/icon';
import { TrnInput } from '@trinity/components/input';
import { TrnLabel } from '@trinity/components/label';
import { TrnSpinnerComponent } from '@trinity/components/spinner';
import {
  AuthService,
  AUTHENTICATION_HOMESERVER_DISCOVERY,
  RegistrationService,
  type LoginMode,
  type RegistrationPolicy,
} from '@trinity/data-access/auth';
import { ExternalBrowserService } from '@trinity/platform-native';

@Component({
  selector: 'trn-registration',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './registration.page.html',
  styleUrl: './registration.page.scss',
  imports: [
    AuthCardComponent,
    FormField,
    TrnButton,
    TrnCardImports,
    TrnCheckboxComponent,
    TrnIconComponent,
    TrnInput,
    TrnLabel,
    TrnSpinnerComponent,
  ],
})
export class RegistrationPage implements OnDestroy {
  private readonly auth = inject(AuthService);
  private readonly discovery = inject(AUTHENTICATION_HOMESERVER_DISCOVERY);
  private readonly registration = inject(RegistrationService);
  private readonly browser = inject(ExternalBrowserService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  private readonly homeserverInput =
    this.route.snapshot.queryParamMap.get('homeserver')?.trim() ?? '';
  readonly addMode = this.route.snapshot.queryParamMap.has('add');
  private readonly mode: LoginMode = this.addMode ? 'add' : 'replace';

  readonly baseUrl = signal<string | null>(null);
  readonly discovering = signal(false);
  readonly started = signal(false);
  readonly passwordVisible = signal(false);
  private readonly acceptedPolicyKeys = signal<ReadonlySet<string>>(new Set());
  private readonly openedFallbackUrl = signal<string | null>(null);
  private readonly pageError = signal<string | null>(null);

  readonly stage = this.registration.stage;
  readonly busy = computed(
    () => this.discovering() || this.registration.busy(),
  );
  readonly error = computed(
    () => this.pageError() ?? this.registration.error(),
  );
  readonly stageMessage = computed(() => {
    const stage = this.stage();
    return 'message' in stage ? (stage.message ?? null) : null;
  });
  readonly fallbackOpened = computed(() => {
    const stage = this.stage();
    return stage.kind === 'fallback' && this.openedFallbackUrl() === stage.url;
  });
  readonly termsAccepted = computed(() => {
    const stage = this.stage();
    return (
      stage.kind === 'terms' &&
      stage.policies.length > 0 &&
      stage.policies.every((policy) => this.policyAccepted(policy))
    );
  });

  private readonly credentialsModel = signal({
    username: '',
    password: '',
    confirmPassword: '',
  });
  readonly credentialsForm = form(this.credentialsModel, (path) => {
    required(path.username, { message: 'Choose a username.' });
    required(path.password, { message: 'Choose a password.' });
    required(path.confirmPassword, { message: 'Confirm your password.' });
    validate(path.confirmPassword, ({ value, valueOf }) =>
      value() === valueOf(path.password)
        ? undefined
        : { kind: 'passwordMismatch', message: 'Passwords do not match.' },
    );
    disabled(path.username, { when: () => this.busy() });
    disabled(path.password, { when: () => this.busy() });
    disabled(path.confirmPassword, { when: () => this.busy() });
  });

  private readonly emailModel = signal({ email: '' });
  readonly emailForm = form(this.emailModel, (path) => {
    required(path.email, { message: 'Enter your email address.' });
    email(path.email, { message: 'Enter a valid email address.' });
    disabled(path.email, { when: () => this.busy() });
  });

  private readonly tokenModel = signal({ token: '' });
  readonly tokenForm = form(this.tokenModel, (path) => {
    required(path.token, { message: 'Enter the registration token.' });
    disabled(path.token, { when: () => this.busy() });
  });

  constructor() {
    this.discoverHomeserver();
  }

  ngOnDestroy(): void {
    this.registration.cancel();
  }

  /** Submit the fixed account credentials and keep the subscription through every UIA stage. */
  createAccount(): void {
    const baseUrl = this.baseUrl();
    if (!baseUrl) return;
    submit(this.credentialsForm, async () => {
      this.acceptedPolicyKeys.set(new Set());
      this.openedFallbackUrl.set(null);
      this.started.set(true);
      this.pageError.set(null);
      this.registration
        .begin(
          baseUrl,
          this.credentialsModel().username,
          this.credentialsModel().password,
          this.registrationServerName(this.homeserverInput),
          this.mode,
        )
        .pipe(takeUntilDestroyed(this.destroyRef))
        .subscribe(() => this.finish());
    });
  }

  provideEmail(): void {
    submit(this.emailForm, async () => {
      this.registration.provideEmail(this.emailModel().email);
    });
  }

  submitToken(): void {
    submit(this.tokenForm, async () => {
      this.runAction(
        this.registration.submitRegistrationToken(this.tokenModel().token),
      );
    });
  }

  acceptTerms(): void {
    if (!this.termsAccepted() || this.busy()) return;
    this.runAction(this.registration.acceptTerms());
  }

  policyAccepted(policy: RegistrationPolicy): boolean {
    return this.acceptedPolicyKeys().has(this.policyKey(policy));
  }

  togglePolicy(policy: RegistrationPolicy, accepted: boolean): void {
    const keys = new Set(this.acceptedPolicyKeys());
    const key = this.policyKey(policy);
    if (accepted) keys.add(key);
    else keys.delete(key);
    this.acceptedPolicyKeys.set(keys);
  }

  resendEmail(): void {
    this.runAction(this.registration.resendEmail());
  }

  poll(): void {
    this.runAction(this.registration.poll());
  }

  retryEstablishment(): void {
    this.registration
      .retryEstablishment()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.finish());
  }

  openPolicy(policy: RegistrationPolicy): void {
    this.openExternal(policy.url, false);
  }

  openFallback(url: string): void {
    this.openExternal(url, true);
  }

  backToLogin(): void {
    void this.router.navigate(['/login'], {
      queryParams: this.addMode ? { add: '' } : {},
    });
  }

  private discoverHomeserver(): void {
    if (!this.homeserverInput) {
      this.pageError.set('Choose a homeserver before creating an account.');
      return;
    }
    this.discovering.set(true);
    this.discovery
      .discover(this.homeserverInput)
      .pipe(
        switchMap(({ baseUrl }) =>
          forkJoin({
            flows: this.auth.getSupportedFlows(baseUrl),
            oidc: this.auth.getDelegatedAuthConfig(baseUrl),
          }).pipe(
            switchMap(({ flows, oidc }) => {
              if (oidc) {
                return throwError(
                  () =>
                    new Error(
                      'This homeserver creates accounts through its sign-in provider.',
                    ),
                );
              }
              if (!flows.includes('m.login.password')) {
                return throwError(
                  () =>
                    new Error(
                      'This homeserver does not offer password accounts.',
                    ),
                );
              }
              return this.registration
                .getAvailability(baseUrl)
                .pipe(map((availability) => [baseUrl, availability] as const));
            }),
          ),
        ),
        finalize(() => this.discovering.set(false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: ([baseUrl, availability]) => {
          if (availability !== 'open') {
            this.pageError.set(
              availability === 'closed'
                ? 'This homeserver is not accepting new accounts.'
                : 'Trinity could not confirm that this homeserver accepts new accounts.',
            );
            return;
          }
          this.baseUrl.set(baseUrl);
        },
        error: (error: unknown) =>
          this.pageError.set(
            error instanceof Error
              ? error.message
              : 'Homeserver discovery failed.',
          ),
      });
  }

  private runAction(source: ReturnType<RegistrationService['poll']>): void {
    source.pipe(takeUntilDestroyed(this.destroyRef)).subscribe();
  }

  private openExternal(url: string, fallback: boolean): void {
    this.browser
      .open(url)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((opened) => {
        if (opened) {
          if (fallback) this.openedFallbackUrl.set(url);
          return;
        }
        this.pageError.set('Trinity could not open that page in your browser.');
      });
  }

  private finish(): void {
    void this.router.navigateByUrl('/encryption/setup', { replaceUrl: true });
  }

  private policyKey(policy: RegistrationPolicy): string {
    return `${policy.id}\u0000${policy.version}\u0000${policy.url}`;
  }

  /** Mirror homeserver discovery's accepted domain / MXID input into its server name. */
  private registrationServerName(input: string): string {
    try {
      const url = new URL(input);
      if (url.protocol === 'http:' || url.protocol === 'https:') {
        // A direct base URL's transport port need not be part of the Matrix server name.
        return url.hostname;
      }
    } catch {
      // Domain and MXID inputs are handled below.
    }
    const trimmed = input.trim().replace(/^@/, '');
    const colon = trimmed.indexOf(':');
    return colon >= 0 ? trimmed.slice(colon + 1) : trimmed;
  }
}
