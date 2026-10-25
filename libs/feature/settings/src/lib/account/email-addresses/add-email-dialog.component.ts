import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormField,
  FormRoot,
  email,
  form,
  required,
} from '@angular/forms/signals';
import { TrnButton, TrnInput, TrnLabel } from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import {
  EmailAddressesWorkflow,
  type EmailAddressRefusal,
  type EmailAddResult,
  type EmailLinkResult,
  type PendingEmail,
} from '@trinity/data-access/contact-addresses';
import { serverNameOf } from '../delete-account/delete-account.copy';
import { ReauthBrowserStepComponent } from '../reauth/reauth-browser-step.component';
import { ReauthPasswordStepComponent } from '../reauth/reauth-password-step.component';
import { ReauthPrompts, type ReauthStep } from '../reauth/reauth-prompts';
import { EMAIL_ADDRESSES_COPY, refusalMessage } from './email-addresses.copy';
import { VerifyLinkStepComponent } from './verify-link-step.component';

/** What the add dialog closes with once the address is bound. */
export interface AddEmailClosed {
  readonly kind: 'added';
  readonly email: string;
}

/** Where the add dialog is; each step is one screen of the same dialog. */
export type AddEmailStep =
  | { readonly kind: 'address' }
  | {
      readonly kind: 'sent';
      readonly pending: PendingEmail;
      readonly notVerified: boolean;
    }
  | ReauthStep
  | { readonly kind: 'working' }
  | {
      readonly kind: 'stopped';
      readonly reason: EmailAddressRefusal;
      readonly retryAfterMs?: number;
    };

/** Settings › Account › Add email address: send a link, then confirm once it is opened. */
@Component({
  selector: 'trn-add-email-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './add-email-dialog.component.html',
  imports: [
    FormField,
    FormRoot,
    ReauthBrowserStepComponent,
    ReauthPasswordStepComponent,
    TrnButton,
    TrnDialogActions,
    TrnDialogShellComponent,
    TrnInput,
    TrnLabel,
    VerifyLinkStepComponent,
  ],
})
export class AddEmailDialogComponent {
  private readonly workflow = inject(EmailAddressesWorkflow);
  private readonly ref = inject(TrnDialogRef, { optional: true });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  /** The sent step to return to when re-authentication is backed out of. */
  private sent: Extract<AddEmailStep, { kind: 'sent' }> | null = null;
  private resendTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly prompts = new ReauthPrompts((step) => this.step.set(step));

  protected readonly copy = EMAIL_ADDRESSES_COPY;

  /** The account the address is added to, fixed when the dialog opened. */
  readonly accountId = input.required<string>();

  readonly step = signal<AddEmailStep>({ kind: 'address' });
  protected readonly busy = signal(false);
  protected readonly addressError = signal('');
  protected readonly resent = signal(false);
  protected readonly resendError = signal('');
  protected readonly resendWaitMs = signal(0);

  private readonly model = signal({ email: '' });
  protected readonly addressForm = form(this.model, (path) => {
    required(path.email);
    email(path.email);
  });

  protected readonly server = computed(() => serverNameOf(this.accountId()));
  protected readonly title = computed(() => {
    switch (this.step().kind) {
      case 'sent':
        return EMAIL_ADDRESSES_COPY.sentTitle;
      case 'password':
        return EMAIL_ADDRESSES_COPY.passwordTitle;
      case 'browser':
        return EMAIL_ADDRESSES_COPY.browserTitle;
      case 'stopped':
        return EMAIL_ADDRESSES_COPY.stoppedTitle;
      case 'working':
        return EMAIL_ADDRESSES_COPY.workingTitle;
      default:
        return EMAIL_ADDRESSES_COPY.addressTitle;
    }
  });
  protected readonly sentEmail = computed(() => {
    const step = this.step();
    return step.kind === 'sent' ? step.pending.email : '';
  });
  protected readonly notVerified = computed(() => {
    const step = this.step();
    return step.kind === 'sent' && step.notVerified;
  });
  protected readonly stoppedMessage = computed(() => {
    const step = this.step();
    return step.kind === 'stopped'
      ? refusalMessage(step.reason, this.server(), step.retryAfterMs)
      : '';
  });
  protected readonly passwordRejected = computed(() => {
    const step = this.step();
    return step.kind === 'password' && step.rejected;
  });
  protected readonly browserUrl = computed(() => {
    const step = this.step();
    return step.kind === 'browser' ? step.url : '';
  });
  protected readonly browserPending = computed(() => {
    const step = this.step();
    return step.kind === 'browser' && step.pending;
  });

  constructor() {
    let first = true;
    effect(() => {
      const step = this.step();
      if (first) {
        first = false;
        return;
      }
      untracked(() => this.focusStep(step));
    });
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.resendTimer);
      this.prompts.abandon();
    });
  }

  /** Escape and the close control are ignored once the request cannot be called back. */
  canDismiss(): boolean {
    return this.step().kind !== 'working';
  }

  close(): void {
    if (this.canDismiss()) this.ref?.close();
  }

  submitAddress(): void {
    if (this.busy()) return;
    this.addressForm.email().value.update((value) => value.trim());
    if (this.addressForm().invalid()) {
      this.addressError.set(EMAIL_ADDRESSES_COPY.invalid);
      this.focus('#add-email-input');
      return;
    }
    this.addressError.set('');
    this.busy.set(true);
    this.workflow
      .sendLink(this.accountId(), this.model().email)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => this.linkSent(result));
  }

  continueAdding(): void {
    const sent = this.sent;
    if (this.busy() || !sent) return;
    this.busy.set(true);
    this.workflow
      .add(sent.pending, this.prompts)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => this.confirmed(result, sent));
  }

  resend(): void {
    const sent = this.sent;
    if (this.busy() || !sent) return;
    this.busy.set(true);
    this.workflow
      .resend(sent.pending)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => this.resentLink(result));
  }

  submitPassword(password: string): void {
    if (this.prompts.answerPassword(password))
      this.step.set({ kind: 'working' });
  }

  confirmInBrowserDone(): void {
    if (this.prompts.answerBrowser(true)) this.step.set({ kind: 'working' });
  }

  /** Back to the sent step; the workflow sees the re-authentication cancelled. */
  back(): void {
    this.prompts.abandon();
  }

  private linkSent(result: EmailLinkResult): void {
    this.busy.set(false);
    if (result.kind === 'refused') {
      this.addressError.set(
        refusalMessage(result.reason, this.server(), result.retryAfterMs),
      );
      return;
    }
    this.sent = { kind: 'sent', pending: result.pending, notVerified: false };
    this.step.set(this.sent);
  }

  private resentLink(result: EmailLinkResult): void {
    this.busy.set(false);
    if (result.kind === 'refused') {
      this.resent.set(false);
      this.resendError.set(
        refusalMessage(result.reason, this.server(), result.retryAfterMs),
      );
      if (result.reason === 'rate-limited' && result.retryAfterMs) {
        this.resendWaitMs.set(result.retryAfterMs);
        this.resendTimer = setTimeout(
          () => this.resendWaitMs.set(0),
          result.retryAfterMs,
        );
      }
      return;
    }
    this.resendError.set('');
    this.resent.set(true);
    this.sent = { kind: 'sent', pending: result.pending, notVerified: false };
    this.step.set(this.sent);
  }

  private confirmed(
    result: EmailAddResult,
    sent: Extract<AddEmailStep, { kind: 'sent' }>,
  ): void {
    this.busy.set(false);
    if (result.kind === 'added') {
      // With a result, so the dismiss guard that holds it open while working lets go.
      this.ref?.close({ kind: 'added', email: sent.pending.email });
      return;
    }
    this.resent.set(false);
    if (result.reason === 'cancelled') {
      this.step.set(sent);
    } else if (result.reason === 'not-verified') {
      this.step.set({ ...sent, notVerified: true });
    } else {
      this.step.set({
        kind: 'stopped',
        reason: result.reason,
        retryAfterMs: result.retryAfterMs,
      });
    }
  }

  /** A field step focuses its field; any other step its heading, so the change is announced. */
  private focusStep(step: AddEmailStep): void {
    if (step.kind === 'password') {
      this.focus('#add-email-password');
    } else if (step.kind === 'address') {
      this.focus('#add-email-input');
    } else {
      this.focus('h2', true);
    }
  }

  private focus(selector: string, heading = false): void {
    afterNextRender(
      () => {
        const target =
          this.host.nativeElement.querySelector<HTMLElement>(selector);
        if (heading) target?.setAttribute('tabindex', '-1');
        target?.focus();
      },
      { injector: this.injector },
    );
  }
}
