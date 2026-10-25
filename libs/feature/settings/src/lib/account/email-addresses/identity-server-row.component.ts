import {
  ChangeDetectionStrategy,
  DestroyRef,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, of, switchMap, take } from 'rxjs';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnAlertService,
  TrnSettingsRowComponent,
  TrnSurfaceService,
} from '@trinity/components/overlay';
import {
  IdentityServerService,
  type IdentityServerChoice,
} from '@trinity/data-access/contact-addresses';
import {
  ChangeIdentityServerDialogComponent,
  type IdentityServerChanged,
} from './change-identity-server-dialog.component';
import { EMAIL_ADDRESSES_COPY, hostOf } from './email-addresses.copy';

/** Settings › Account › Email addresses › Identity server: which server lets people find you. */
@Component({
  selector: 'trn-identity-server-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './identity-server-row.component.html',
  imports: [TrnButton, TrnSettingsRowComponent],
})
export class IdentityServerRowComponent {
  private readonly identity = inject(IdentityServerService);
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly alert = inject(TrnAlertService);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copy = EMAIL_ADDRESSES_COPY;
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  readonly accountId = input.required<string>();
  readonly choice = input.required<IdentityServerChoice>();
  /** The addresses the current server lets people find the account by. */
  readonly published = input<readonly string[]>([]);
  readonly changed = output<void>();

  protected readonly value = computed(() => {
    const choice = this.choice();
    switch (choice.kind) {
      case 'set':
        return hostOf(choice.url);
      case 'off':
        return this.copy.identityServerOff;
      case 'none':
        return this.copy.identityServerNone;
    }
  });

  change(): void {
    const choice = this.choice();
    const set = choice.kind === 'set';
    this.open(set ? choice.url : '', set ? this.published() : []);
  }

  turnOff(): void {
    const choice = this.choice();
    if (choice.kind !== 'set' || this.busy()) return;
    const accountId = this.accountId();
    const published = this.published();
    const host = hostOf(choice.url);
    this.error.set('');
    this.alert
      .confirm$({
        header: this.copy.turnOffTitle,
        message:
          published.length === 0
            ? this.copy.turnOffBody
            : this.copy.unpublishBody(host, published.length),
        confirmText: this.copy.turnOffButton,
        variant: 'danger',
      })
      .pipe(
        take(1),
        filter(Boolean),
        switchMap(() => {
          this.busy.set(true);
          return published.length === 0
            ? of({ kind: 'unpublished' } as const)
            : this.identity.unpublishAll(accountId, choice.url, published);
        }),
        switchMap((released) =>
          released.kind === 'unpublished'
            ? this.identity.turnOff(accountId)
            : of(released),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((result) => {
        this.busy.set(false);
        if (result.kind === 'saved') this.changed.emit();
        else this.error.set(this.copy.serverUnreachable(host));
      });
  }

  private open(current: string, published: readonly string[]): void {
    this.surfaces
      .open<IdentityServerChanged, ChangeIdentityServerDialogComponent>(
        ChangeIdentityServerDialogComponent,
        {
          ariaDescribedBy: 'identity-server-body',
          autoFocus: '[data-autofocus]',
          inputs: { accountId: this.accountId(), current, published },
          dismissGuard: (dialog) => dialog?.canDismiss() ?? true,
        },
      )
      .closed.pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        if (result?.kind === 'changed') {
          this.error.set('');
          this.changed.emit();
        }
      });
  }
}
