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
import {
  EMPTY,
  filter,
  finalize,
  map,
  of,
  switchMap,
  take,
  tap,
  type Observable,
  type ObservedValueOf,
} from 'rxjs';
import { TrnButton, TrnSwitchComponent } from '@trinity/components/controls';
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
  type IdentityPolicy,
  type IdentityServerChoice,
  type IdentityServerRefused,
} from '@trinity/data-access/contact-addresses';
import { serverNameOf } from '../delete-account/delete-account.copy';
import {
  AddEmailDialogComponent,
  type AddEmailClosed,
} from './add-email-dialog.component';
import { IdentityServerRowComponent } from './identity-server-row.component';
import { IdentityTermsDialogComponent } from './identity-terms-dialog.component';
import {
  EMAIL_ADDRESSES_COPY,
  hostOf,
  identityRefusalMessage,
  refusalMessage,
} from './email-addresses.copy';
import {
  PublishEmailDialogComponent,
  type PublishEmailClosed,
} from './publish-email-dialog.component';

type GroupState = { readonly kind: 'loading' } | EmailAddressesLoad;

/** The identity server in use and which of the account's emails it lets people find it by. */
interface IdentityState {
  readonly choice: IdentityServerChoice;
  /** 'unknown' while the server wants its terms signed or can't answer; it may still list addresses. */
  readonly published: readonly string[] | 'unknown';
  /** The server could not say what it lists, so the switches are off and disabled. */
  readonly failed: boolean;
}

function foundState(
  found: ObservedValueOf<ReturnType<IdentityServerService['findable']>>,
): Pick<IdentityState, 'published' | 'failed'> {
  if (found.kind === 'loaded') {
    return { published: [...found.published], failed: false };
  }
  return { published: 'unknown', failed: found.kind !== 'terms-needed' };
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
    TrnSwitchComponent,
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
  protected readonly hostOf = hostOf;
  /** What a screen reader hears about changes; toasts alone aren't reliably announced. */
  protected readonly announcement = signal('');
  protected readonly actionError = signal('');
  protected readonly state = signal<GroupState>({ kind: 'loading' });
  protected readonly identity = signal<IdentityState | null>(null);
  /** Why the identity server choice couldn't be read, or empty. */
  protected readonly identityError = signal('');
  protected readonly identityRowBusy = signal(false);
  /** Addresses with a request or dialog open; a second change to one is ignored. */
  protected readonly busyAddresses = signal<ReadonlySet<string>>(new Set());

  readonly accountId = input.required<string>();
  readonly accountKind = input.required<'legacy' | 'oauth'>();

  protected readonly identityBusy = computed(
    () => this.busyAddresses().size > 0,
  );
  protected readonly server = computed(() => serverNameOf(this.accountId()));
  /** What Turn off and Change unpublish first: when unsure, every email on the account. */
  protected readonly toUnpublish = computed(() => {
    const published = this.identity()?.published ?? [];
    const current = this.state();
    return published === 'unknown' && current.kind === 'loaded'
      ? this.emailsOf(current)
      : published === 'unknown'
        ? []
        : published;
  });

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
          this.busyAddresses.set(new Set());
          this.actionError.set('');
        }),
        switchMap(({ id }) =>
          this.workflow.load(id).pipe(
            // The list must not wait on the identity server.
            tap((load) => this.state.set(load)),
            switchMap((load) =>
              load.kind === 'loaded' ? this.loadIdentity(id, load) : of(null),
            ),
          ),
        ),
        takeUntilDestroyed(),
      )
      .subscribe((identity) => this.identity.set(identity));
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
              result.unbind !== 'no-support'
                ? this.copy.removed(address.address)
                : choice?.kind === 'set'
                  ? this.copy.removedStillFindable(
                      address.address,
                      hostOf(choice.url),
                    )
                  : this.copy.removedMayStillFindable(address.address),
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

  /** Turns Findable on or off for one address, one request at a time. */
  protected toggle(address: string, on: boolean): void {
    const identity = this.identity();
    const choice = identity?.choice;
    if (
      choice?.kind !== 'set' ||
      identity?.failed ||
      this.identityRowBusy() ||
      this.busyAddresses().has(address)
    ) {
      return;
    }
    const accountId = this.accountId();
    this.actionError.set('');
    this.setBusy(address, true);
    (on
      ? this.turnOn(accountId, address, choice)
      : this.turnOff(accountId, address, choice.url)
    )
      .pipe(
        finalize(() => this.setBusy(address, false)),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe();
  }

  private turnOn(
    accountId: string,
    address: string,
    choice: Extract<IdentityServerChoice, { kind: 'set' }>,
  ): Observable<unknown> {
    const host = hostOf(choice.url);
    const refused = (result: IdentityServerRefused) => {
      this.failWith(accountId, result, host);
      return EMPTY;
    };
    const url = choice.url;
    // A well-known server becomes the person's choice only once its terms are accepted.
    const chosen$ = (): Observable<string> =>
      choice.source === 'account'
        ? of(url)
        : this.identityServer.use(accountId, url).pipe(
            switchMap((saved) => {
              if (saved.kind === 'refused') return refused(saved);
              this.chosen(accountId, saved.url);
              return of(saved.url);
            }),
          );
    return this.identityServer.terms(accountId, url).pipe(
      switchMap((terms) => {
        if (terms.kind === 'refused') return refused(terms);
        if (terms.kind === 'accepted') return of(true);
        return this.askTerms(host, terms.policies).pipe(
          filter(Boolean),
          switchMap(() =>
            this.identityServer.acceptTerms(accountId, url, terms.policies),
          ),
          switchMap((accepted) =>
            accepted.kind === 'refused' ? refused(accepted) : of(true),
          ),
        );
      }),
      switchMap(chosen$),
      switchMap((saved) => this.publish(accountId, address, saved)),
    );
  }

  protected isPublished(address: string): boolean {
    const published = this.identity()?.published;
    return Array.isArray(published) && published.includes(address);
  }

  private turnOff(
    accountId: string,
    address: string,
    url: string,
  ): Observable<unknown> {
    return this.identityServer.unpublish(accountId, url, address).pipe(
      switchMap((result) => {
        if (result.kind === 'refused') {
          this.failWith(accountId, result, hostOf(url));
        }
        return this.reread(accountId).pipe(
          tap(() => {
            if (result.kind === 'refused') return;
            // A server without unbind support reports success and keeps listing the address.
            if (this.isPublished(address)) {
              const message = this.copy.stillFindable(hostOf(url), address);
              this.actionError.set(message);
              this.announcement.set(message);
            } else {
              this.say(this.copy.unpublished(address));
            }
          }),
        );
      }),
    );
  }

  private askTerms(
    host: string,
    policies: readonly IdentityPolicy[],
  ): Observable<boolean> {
    return this.surfaces
      .open<true, IdentityTermsDialogComponent>(IdentityTermsDialogComponent, {
        ariaDescribedBy: 'identity-terms-body',
        autoFocus: '[data-autofocus]',
        inputs: { host, policies },
      })
      .closed.pipe(
        take(1),
        map((accepted) => accepted === true),
      );
  }

  private publish(
    accountId: string,
    address: string,
    url: string,
  ): Observable<unknown> {
    return this.surfaces
      .open<PublishEmailClosed, PublishEmailDialogComponent>(
        PublishEmailDialogComponent,
        {
          ariaDescribedBy: 'publish-email-body',
          inputs: { accountId, url, email: address },
          dismissGuard: (dialog) => dialog?.canDismiss() ?? true,
        },
      )
      .closed.pipe(
        take(1),
        tap((result) => {
          if (result?.kind === 'published')
            this.say(this.copy.published(address));
        }),
        switchMap(() => this.reread(accountId)),
      );
  }

  /** Asks the account's server again what it lists, so the switches show the real state. */
  private reread(accountId: string): Observable<unknown> {
    const identity = this.identity();
    const current = this.state();
    if (
      this.accountId() !== accountId ||
      identity?.choice.kind !== 'set' ||
      current.kind !== 'loaded'
    ) {
      return of(null);
    }
    const { choice } = identity;
    return this.identityServer
      .findable(accountId, choice.url, this.emailsOf(current))
      .pipe(
        tap((found) => {
          if (this.accountId() !== accountId) return;
          this.identity.set({
            choice,
            ...foundState(found),
          });
        }),
      );
  }

  private chosen(accountId: string, url: string): void {
    if (this.accountId() !== accountId) return;
    this.identity.update((identity) =>
      identity
        ? { ...identity, choice: { kind: 'set', url, source: 'account' } }
        : identity,
    );
  }

  private failWith(
    accountId: string,
    { reason, retryAfterMs }: IdentityServerRefused,
    host: string,
  ): void {
    if (this.accountId() !== accountId) return;
    const message = identityRefusalMessage(reason, host, retryAfterMs);
    this.actionError.set(message);
    this.announcement.set(message);
  }

  private setBusy(address: string, busy: boolean): void {
    this.busyAddresses.update((current) => {
      const next = new Set(current);
      if (busy) next.add(address);
      else next.delete(address);
      return next;
    });
  }

  private emailsOf(
    load: Extract<EmailAddressesLoad, { kind: 'loaded' }>,
  ): string[] {
    return load.addresses
      .filter(({ medium }) => medium === 'email')
      .map(({ address }) => address);
  }

  private loadIdentity(
    accountId: string,
    load: Extract<EmailAddressesLoad, { kind: 'loaded' }>,
  ): Observable<IdentityState | null> {
    this.identityError.set('');
    return this.identityServer.choice(accountId).pipe(
      switchMap((choice) => {
        if (choice.kind === 'refused') {
          this.identityError.set(
            identityRefusalMessage(
              choice.reason,
              this.server(),
              choice.retryAfterMs,
            ),
          );
          return of(null);
        }
        // Only a server the person chose is asked; a well-known one is not contacted until they act.
        if (choice.kind !== 'set' || choice.source !== 'account') {
          return of({ choice, published: [], failed: false });
        }
        return this.identityServer
          .findable(accountId, choice.url, this.emailsOf(load))
          .pipe(
            map((found) => ({
              choice,
              ...foundState(found),
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
