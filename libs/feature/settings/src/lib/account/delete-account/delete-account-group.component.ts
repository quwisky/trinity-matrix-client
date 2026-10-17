import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  takeUntilDestroyed,
  toObservable,
  toSignal,
} from '@angular/core/rxjs-interop';
import { switchMap, tap } from 'rxjs';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
  TrnSurfaceService,
} from '@trinity/components/overlay';
import {
  ACCOUNT_DELETION_LAUNCHER,
  type AccountDeletionOutcome,
} from '@trinity/platform-native';
import { DeleteAccountDialogComponent } from './delete-account-dialog.component';
import {
  DELETE_ACCOUNT_COPY,
  refusalMessage,
  serverNameOf,
} from './delete-account.copy';

/**
 * Settings › Account › Delete account. In-app on a server with the legacy account API;
 * a link to the provider's page on an OAuth 2.0 server, which is where deletion lives there.
 */
@Component({
  selector: 'trn-delete-account-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './delete-account-group.component.html',
  imports: [TrnButton, TrnSettingsGroupComponent, TrnSettingsRowComponent],
})
export class DeleteAccountGroupComponent {
  private readonly launcher = inject(ACCOUNT_DELETION_LAUNCHER);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copy = DELETE_ACCOUNT_COPY;

  readonly accountId = input.required<string>();

  /** How deletion works on this account's server; null until the server has answered. */
  readonly plan = toSignal(
    toObservable(this.accountId).pipe(
      tap(() => {
        this.providerOpened.set(false);
        this.checkMessage.set(null);
      }),
      switchMap((id) => this.launcher.plan(id)),
    ),
    { initialValue: null },
  );

  readonly providerOpened = signal(false);
  readonly checking = signal(false);
  readonly checkMessage = signal<string | null>(null);

  protected readonly server = computed(() => serverNameOf(this.accountId()));
  protected readonly providerHost = computed(() => {
    const plan = this.plan();
    if (plan?.kind !== 'provider' || !plan.url) return null;
    try {
      return new URL(plan.url).host;
    } catch {
      return null;
    }
  });

  openDialog(): void {
    this.surfaces.open(DeleteAccountDialogComponent, {
      ariaDescribedBy: 'delete-account-body',
      autoFocus: '[data-autofocus]',
      inputs: { accountId: this.accountId() },
      dismissGuard: (dialog) => dialog?.canDismiss() ?? true,
    });
  }

  openProvider(): void {
    const plan = this.plan();
    if (plan?.kind !== 'provider' || !plan.url) return;
    this.providerOpened.set(true);
    this.launcher
      .openProvider(this.accountId(), plan.url)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe();
  }

  checkNow(): void {
    this.checking.set(true);
    this.checkMessage.set(null);
    this.launcher
      .checkDeletion(this.accountId())
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((outcome) => {
        this.checking.set(false);
        this.checkMessage.set(this.checkResult(outcome));
      });
  }

  private checkResult(outcome: AccountDeletionOutcome): string | null {
    switch (outcome.kind) {
      case 'deleted':
        return null;
      case 'kept':
        return outcome.reason === 'still-active'
          ? DELETE_ACCOUNT_COPY.stillExists
          : refusalMessage(outcome.reason, this.server());
      case 'unconfirmed':
        return DELETE_ACCOUNT_COPY.unconfirmed;
    }
  }
}
