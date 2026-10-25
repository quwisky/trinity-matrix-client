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
import { AddEmailDialogComponent } from './add-email-dialog.component';
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
  private announceAdded = false;
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
      .subscribe((load) => this.loaded(load));
  }

  retry(): void {
    this.announcement.set('Trying again…');
    this.reloads.update((n) => n + 1);
  }

  add(): void {
    this.surfaces
      .open(AddEmailDialogComponent, {
        ariaDescribedBy: 'add-email-body',
        autoFocus: '[data-autofocus]',
        inputs: { accountId: this.accountId() },
        dismissGuard: (dialog) => dialog?.canDismiss() ?? true,
      })
      .closed.pipe(
        take(1),
        filter((result) => result === 'added'),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe(() => {
        this.announceAdded = true;
        this.reloads.update((n) => n + 1);
      });
  }

  remove(address: ContactAddress): void {
    this.surfaces
      .open(RemoveEmailDialogComponent, {
        ariaDescribedBy: 'remove-email-body',
        autoFocus: '[data-autofocus]',
        inputs: { address: address.address },
      })
      .closed.pipe(
        take(1),
        filter((result) => result === 'remove'),
        switchMap(() => this.workflow.remove(this.accountId(), address)),
        tap((result) => {
          if (result.kind === 'removed') {
            this.actionError.set('');
            this.say(this.copy.removed(address.address));
            this.reloads.update((n) => n + 1);
          } else {
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

  private loaded(load: EmailAddressesLoad): void {
    const before = this.state();
    if (this.announceAdded && load.kind === 'loaded') {
      this.announceAdded = false;
      const known = new Set(
        before.kind === 'loaded' ? before.addresses.map((a) => a.address) : [],
      );
      const added = load.addresses.find((a) => !known.has(a.address));
      if (added) this.say(this.copy.added(added.address));
    }
    this.state.set(load);
  }

  private say(message: string): void {
    this.announcement.set(message);
    this.toast.show(message);
  }
}
