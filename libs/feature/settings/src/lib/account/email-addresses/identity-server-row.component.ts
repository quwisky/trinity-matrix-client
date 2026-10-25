import {
  ChangeDetectionStrategy,
  DestroyRef,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter, map, of, switchMap, take } from 'rxjs';
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
  type IdentityServerClosed,
} from './change-identity-server-dialog.component';
import { serverNameOf } from '../delete-account/delete-account.copy';
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
  private readonly injector = inject(Injector);
  private readonly changeButton =
    viewChild<ElementRef<HTMLElement>>('changeButton');

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
          const released$ =
            published.length === 0
              ? of({ kind: 'unpublished' } as const)
              : this.identity.unpublishAll(accountId, choice.url, published);
          return released$.pipe(
            switchMap((released) =>
              released.kind === 'unpublished'
                ? this.identity
                    .turnOff(accountId)
                    .pipe(map((saved) => ({ stage: 'save', saved }) as const))
                : of({ stage: 'unpublish' } as const),
            ),
          );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((outcome) => {
        this.busy.set(false);
        if (outcome.stage === 'unpublish') {
          this.error.set(this.copy.serverUnreachable(host));
        } else if (outcome.saved.kind === 'saved') {
          this.focusChange();
        } else {
          this.error.set(this.copy.saveFailed(serverNameOf(accountId)));
        }
        // Some addresses may already be unpublished, so the group re-reads what is findable.
        if (
          published.length > 0 ||
          (outcome.stage === 'save' && outcome.saved.kind === 'saved')
        ) {
          this.changed.emit();
        }
      });
  }

  /** Turn off disappears once the server is off, so focus moves to the control that stays. */
  private focusChange(): void {
    afterNextRender(() => this.changeButton()?.nativeElement.focus(), {
      injector: this.injector,
    });
  }

  private open(current: string, published: readonly string[]): void {
    this.surfaces
      .open<IdentityServerClosed, ChangeIdentityServerDialogComponent>(
        ChangeIdentityServerDialogComponent,
        {
          autoFocus: '[data-autofocus]',
          inputs: { accountId: this.accountId(), current, published },
          dismissGuard: (dialog) => dialog?.canDismiss() ?? true,
        },
      )
      .closed.pipe(take(1), takeUntilDestroyed(this.destroyRef))
      .subscribe((result) => {
        if (!result) return;
        this.error.set(result.kind === 'partial' ? result.message : '');
        this.changed.emit();
      });
  }
}
