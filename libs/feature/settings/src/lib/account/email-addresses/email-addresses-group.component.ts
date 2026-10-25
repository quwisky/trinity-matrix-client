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
import { filter, map, of, switchMap, take, tap, type Observable } from 'rxjs';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnAlertService,
  TrnSettingsGroupComponent,
  TrnSettingsRowComponent,
  TrnSurfaceService,
  TrnToastService,
} from '@trinity/components/overlay';
import {
  EmailAddressesWorkflow,
  IdentityServerService,
  type ContactAddress,
  type EmailAddressesLoad,
  type IdentityServerChoice,
} from '@trinity/data-access/contact-addresses';
import { serverNameOf } from '../delete-account/delete-account.copy';
import {
  AddEmailDialogComponent,
  type AddEmailClosed,
} from './add-email-dialog.component';
import { IdentityServerRowComponent } from './identity-server-row.component';
import {
  EMAIL_ADDRESSES_COPY,
  hostOf,
  refusalMessage,
} from './email-addresses.copy';

type GroupState = { readonly kind: 'loading' } | EmailAddressesLoad;

/** The identity server in use and which of the account's emails it lets people find it by. */
interface IdentityState {
  readonly choice: IdentityServerChoice;
  readonly published: readonly string[];
}

/** Settings › Account › Email addresses: list, add and remove the account's 3PIDs. */
@Component({
  selector: 'trn-email-addresses-group',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './email-addresses-group.component.html',
  imports: [
    IdentityServerRowComponent,
    TrnButton,
    TrnSettingsGroupComponent,
    TrnSettingsRowComponent,
  ],
})
export class EmailAddressesGroupComponent {
  private readonly workflow = inject(EmailAddressesWorkflow);
  private readonly identityServer = inject(IdentityServerService);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly alert = inject(TrnAlertService);
  private readonly toast = inject(TrnToastService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly reloads = signal(0);
  private shownId = '';

  protected readonly copy = EMAIL_ADDRESSES_COPY;
  /** What a screen reader hears about changes; toasts alone aren't reliably announced. */
  protected readonly announcement = signal('');
  protected readonly actionError = signal('');
  protected readonly state = signal<GroupState>({ kind: 'loading' });
  protected readonly identity = signal<IdentityState | null>(null);

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
          this.identity.set(null);
          this.actionError.set('');
        }),
        switchMap(({ id }) =>
          this.workflow
            .load(id)
            .pipe(
              switchMap((load) =>
                load.kind === 'loaded'
                  ? this.loadIdentity(id, load).pipe(
                      map((identity) => ({ load, identity })),
                    )
                  : of({ load, identity: null }),
              ),
            ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe(({ load, identity }) => {
        this.identity.set(identity);
        this.state.set(load);
      });
  }

  retry(): void {
    this.announcement.set('Trying again…');
    this.reloads.update((n) => n + 1);
  }

  protected refresh(): void {
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
    this.alert
      .confirm$({
        header: this.copy.removeTitle(address.address),
        message: this.copy.removeBody,
        confirmText: 'Remove',
        variant: 'danger',
      })
      .pipe(
        take(1),
        filter(Boolean),
        switchMap(() => this.workflow.remove(accountId, address)),
        tap((result) => {
          const current = this.accountId() === accountId;
          if (result.kind === 'removed') {
            const choice = this.identity()?.choice;
            this.say(
              result.unbind === 'no-support' && choice?.kind === 'set'
                ? this.copy.removedStillFindable(
                    address.address,
                    hostOf(choice.url),
                  )
                : this.copy.removed(address.address),
            );
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

  private loadIdentity(
    accountId: string,
    load: Extract<EmailAddressesLoad, { kind: 'loaded' }>,
  ): Observable<IdentityState | null> {
    return this.identityServer.choice(accountId).pipe(
      switchMap((choice) => {
        if (choice.kind === 'refused') return of(null);
        if (choice.kind !== 'set') return of({ choice, published: [] });
        const emails = load.addresses
          .filter(({ medium }) => medium === 'email')
          .map(({ address }) => address);
        return this.identityServer.findable(accountId, choice.url, emails).pipe(
          map((found) => ({
            choice,
            published: found.kind === 'loaded' ? [...found.published] : [],
          })),
        );
      }),
    );
  }

  private say(message: string): void {
    this.announcement.set(message);
    this.toast.show(message);
  }
}
