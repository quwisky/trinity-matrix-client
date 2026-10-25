import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed, toObservable } from '@angular/core/rxjs-interop';
import { filter, switchMap, take, tap } from 'rxjs';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  EmailAddressesWorkflow,
  type ContactAddress,
  type EmailAddressesLoad,
} from '@trinity/data-access/contact-addresses';
import { serverNameOf } from '../delete-account/delete-account.copy';
import {
  AddEmailDialogComponent,
  type AddEmailClosed,
} from './add-email-dialog.component';
import { EMAIL_ADDRESSES_COPY, refusalMessage } from './email-addresses.copy';
import { RemoveEmailDialogComponent } from './remove-email-dialog.component';

type GroupState = { readonly kind: 'loading' } | EmailAddressesLoad;

/** Settings › Account › Email addresses: list, add and remove the account's 3PIDs. */
@Component({
  selector: 'trn-email-addresses-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './email-addresses-group.component.html',
  imports: [TrnButton, TrnSettingsGroupComponent, TrnSettingsRowComponent],
})
export class EmailAddressesGroupComponent {
  private readonly workflow = inject(EmailAddressesWorkflow);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly reloads = signal(0);
  private shownId = '';

  protected readonly copy = EMAIL_ADDRESSES_COPY;
  /** What a screen reader hears about changes; toasts alone aren't reliably announced. */
  protected readonly announcement = signal('');
  protected readonly actionError = signal('');
  protected readonly state = signal<GroupState>({ kind: 'loading' });

  readonly accountId = input.required<string>();
  readonly accountKind = input.required<'legacy' | 'oauth'>();

  protected readonly server = computed(() => serverNameOf(this.accountId()));

  constructor() {
    toObservable(
      computed(() => ({
        id: this.accountId(),
        kind: this.accountKind(),
        n: this.reloads(),
      })),
    )
      .pipe(
        filter(({ kind }) => kind === 'legacy'),
        tap(({ id }) => {
          if (id === this.shownId) return;
          this.shownId = id;
          this.state.set({ kind: 'loading' });
          this.actionError.set('');
        }),
        switchMap(({ id }) => this.workflow.load(id)),
        takeUntilDestroyed(),
      )
      .subscribe((load) => this.state.set(load));
  }

  retry(): void {
    this.announcement.set('Trying again…');
    this.reloads.update((n) => n + 1);
  }

  add(): void {
    const accountId = this.accountId();
    this.surfaces
      .open<AddEmailClosed, AddEmailDialogComponent>(AddEmailDialogComponent, {
        ariaDescribedBy: 'add-email-body',
        autoFocus: '[data-autofocus]',
        inputs: { accountId },
        dismissGuard: (dialog) => dialog?.canDismiss() ?? true,
      })
      .closed.pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        if (result?.kind !== 'added') return;
        this.say(this.copy.added(result.email));
        if (this.accountId() === accountId) this.reloads.update((n) => n + 1);
      });
  }

  remove(address: ContactAddress): void {
    const accountId = this.accountId();
    this.surfaces
      .open(RemoveEmailDialogComponent, {
        ariaDescribedBy: 'remove-email-body',
        autoFocus: '[data-autofocus]',
        inputs: { address: address.address },
      })
      .closed.pipe(
        take(1),
        filter((result) => result === 'remove'),
        switchMap(() => this.workflow.remove(accountId, address)),
        tap((result) => {
          const current = this.accountId() === accountId;
          if (result.kind === 'removed') {
            this.say(this.copy.removed(address.address));
            if (current) {
              this.actionError.set('');
              this.reloads.update((n) => n + 1);
            }
          } else if (current) {
            const message = refusalMessage(
              result.reason,
              this.server(),
              result.retryAfterMs,
            );
            this.actionError.set(message);
            this.announcement.set(message);
          }
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private say(message: string): void {
    this.announcement.set(message);
    this.toast.show(message);
  }
}
