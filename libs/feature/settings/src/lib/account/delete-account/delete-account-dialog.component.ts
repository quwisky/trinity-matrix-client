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
import { FormField, FormRoot, form, required } from '@angular/forms/signals';
import {
  TrnButton,
  TrnCheckboxComponent,
  TrnInput,
  TrnLabel,
  TrnPasswordInputComponent,
} from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import {
  ACCOUNT_DELETION_MISTYPED_MESSAGE,
  accountDeletionConsequences,
  accountEraseDescription,
  classifyAccountDeletionIntent,
} from '@trinity/data-access/accounts';
import {
  ACCOUNT_DELETION_LAUNCHER,
  ACCOUNT_REMOVAL_LAUNCHER,
  ExternalBrowserService,
  type AccountDeletionOutcome,
  type AccountDeletionPrompts,
  type AccountDeletionRefusal,
} from '@trinity/platform-native';
import {
  DELETE_ACCOUNT_COPY,
  canRetry,
  refusalMessage,
  serverNameOf,
} from './delete-account.copy';

/** Where the deletion dialog is; each step is one screen of the same dialog. */
export type DeleteAccountStep =
  | { readonly kind: 'confirm' }
  | { readonly kind: 'password'; readonly rejected: boolean }
  | {
      readonly kind: 'browser';
      readonly url: string;
      readonly pending: boolean;
    }
  | { readonly kind: 'deleting' }
  | {
      readonly kind: 'stopped';
      readonly reason: AccountDeletionRefusal;
      readonly retryAfterMs?: number;
    }
  | { readonly kind: 'unconfirmed'; readonly checking: boolean };

/**
 * Settings › Account › Delete account. It only collects the person's choices and answers
 * the server's re-authentication; the deletion launcher owns every request and, once the
 * server has deleted the account, closes this dialog and Settings itself.
 */
@Component({
  selector: 'trn-delete-account-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './delete-account-dialog.component.html',
  imports: [
    FormField,
    FormRoot,
    TrnButton,
    TrnCheckboxComponent,
    TrnDialogActions,
    TrnDialogShellComponent,
    TrnInput,
    TrnLabel,
    TrnPasswordInputComponent,
  ],
})
export class DeleteAccountDialogComponent {
  private readonly launcher = inject(ACCOUNT_DELETION_LAUNCHER);
  private readonly removal = inject(ACCOUNT_REMOVAL_LAUNCHER);
  private readonly browser = inject(ExternalBrowserService);
  private readonly ref = inject(TrnDialogRef, { optional: true });
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly destroyRef = inject(DestroyRef);
  private answerPassword: ((password: string | null) => void) | null = null;
  private answerBrowser: ((finished: boolean) => void) | null = null;

  protected readonly copy = DELETE_ACCOUNT_COPY;
  protected readonly mistypedMessage = ACCOUNT_DELETION_MISTYPED_MESSAGE;

  /** The account being deleted, fixed when the dialog opened. */
  readonly accountId = input.required<string>();

  readonly step = signal<DeleteAccountStep>({ kind: 'confirm' });
  readonly erase = signal(true);
  readonly mistyped = signal(false);
  readonly browserOpened = signal(false);

  private readonly confirmation = signal({ typed: '' });
  readonly confirmForm = form(this.confirmation);
  private readonly credentials = signal({ password: '' });
  readonly passwordForm = form(this.credentials, (path) => {
    required(path.password);
  });

  protected readonly server = computed(() => serverNameOf(this.accountId()));
  protected readonly consequences = computed(() =>
    accountDeletionConsequences(this.accountId()),
  );
  protected readonly eraseDescription = computed(() =>
    accountEraseDescription(this.server()),
  );
  protected readonly title = computed(() => {
    switch (this.step().kind) {
      case 'password':
        return DELETE_ACCOUNT_COPY.passwordTitle;
      case 'browser':
        return DELETE_ACCOUNT_COPY.browserTitle;
      case 'unconfirmed':
        return DELETE_ACCOUNT_COPY.unconfirmedTitle;
      case 'stopped':
        return DELETE_ACCOUNT_COPY.stoppedTitle;
      default:
        return DELETE_ACCOUNT_COPY.confirmTitle(this.accountId());
    }
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
  protected readonly browserPending = computed(() => {
    const step = this.step();
    return step.kind === 'browser' && step.pending;
  });
  protected readonly checking = computed(() => {
    const step = this.step();
    return step.kind === 'unconfirmed' && step.checking;
  });
  protected readonly retryable = computed(() => {
    const step = this.step();
    return step.kind === 'stopped' && canRetry(step.reason);
  });

  private readonly prompts: AccountDeletionPrompts = {
    password: ({ rejected }) =>
      new Promise((resolve) => {
        this.answerPassword = resolve;
        this.credentials.set({ password: '' });
        this.step.set({ kind: 'password', rejected });
      }),
    confirmInBrowser: ({ url, pending }) =>
      new Promise((resolve) => {
        this.answerBrowser = resolve;
        if (!pending) this.browserOpened.set(false);
        this.step.set({ kind: 'browser', url, pending });
      }),
  };

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
    this.destroyRef.onDestroy(() => this.abandonPrompts());
  }

  /** Escape and the close control are ignored once the request cannot be called back. */
  canDismiss(): boolean {
    return this.step().kind !== 'deleting';
  }

  submitConfirmation(): void {
    const intent = classifyAccountDeletionIntent(this.confirmation().typed);
    this.mistyped.set(intent === 'mistyped');
    if (intent === 'mistyped') {
      this.focus('#delete-account-confirm-input');
      return;
    }
    this.start();
  }

  submitPassword(): void {
    const answer = this.answerPassword;
    if (!answer) return;
    if (this.passwordForm().invalid()) {
      this.focus('#delete-account-password');
      return;
    }
    const { password } = this.credentials();
    this.credentials.set({ password: '' });
    this.answerPassword = null;
    this.step.set({ kind: 'deleting' });
    answer(password);
  }

  openConfirmationPage(): void {
    const step = this.step();
    if (step.kind !== 'browser') return;
    this.browserOpened.set(true);
    this.browser
      .open(step.url)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  confirmInBrowserDone(): void {
    const answer = this.answerBrowser;
    if (!answer) return;
    this.answerBrowser = null;
    this.step.set({ kind: 'deleting' });
    answer(true);
  }

  /** Back to the first step; the workflow sees the re-authentication cancelled. */
  back(): void {
    this.abandonPrompts();
  }

  close(): void {
    if (this.canDismiss()) this.ref?.close();
  }

  tryAgain(): void {
    this.start();
  }

  checkAgain(): void {
    this.step.set({ kind: 'unconfirmed', checking: true });
    this.launcher
      .checkDeletion(this.accountId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => this.settle(outcome));
  }

  /** The ordinary removal flow, with its own questions, for an account left in doubt. */
  removeFromDevice(): void {
    const accountId = this.accountId();
    this.ref?.close();
    this.removal.remove(accountId).subscribe();
  }

  private start(): void {
    this.step.set({ kind: 'deleting' });
    this.launcher
      .delete({
        accountId: this.accountId(),
        erase: this.erase(),
        prompts: this.prompts,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => this.settle(outcome));
  }

  private settle(outcome: AccountDeletionOutcome): void {
    this.answerPassword = null;
    this.answerBrowser = null;
    switch (outcome.kind) {
      case 'deleted':
        // With a result, so the dismiss guard that holds it open while deleting lets go.
        this.ref?.close(outcome.kind);
        return;
      case 'unconfirmed':
        this.step.set({ kind: 'unconfirmed', checking: false });
        return;
      case 'kept':
        this.step.set(
          outcome.reason === 'cancelled'
            ? { kind: 'confirm' }
            : {
                kind: 'stopped',
                reason: outcome.reason,
                retryAfterMs: outcome.retryAfterMs,
              },
        );
    }
  }

  private abandonPrompts(): void {
    const password = this.answerPassword;
    const browser = this.answerBrowser;
    this.answerPassword = null;
    this.answerBrowser = null;
    password?.(null);
    browser?.(false);
  }

  /** A field step focuses its field; any other step its heading, so the change is announced. */
  private focusStep(step: DeleteAccountStep): void {
    if (step.kind === 'password') {
      this.focus('#delete-account-password');
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
