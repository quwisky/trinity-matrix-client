import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
  FormField,
  FormRoot,
  form,
  pattern,
  required,
} from '@angular/forms/signals';
import { filter, of, switchMap, take } from 'rxjs';
import { TrnButton, TrnInput, TrnLabel } from '@trinity/components/controls';
import {
  TrnAlertService,
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import {
  IdentityServerService,
  type IdentityServerRefusal,
} from '@trinity/data-access/contact-addresses';
import { EMAIL_ADDRESSES_COPY, hostOf } from './email-addresses.copy';

/** What the dialog closes with once the server is saved. */
export interface IdentityServerChanged {
  readonly kind: 'changed';
}

/** Settings › Account › Change identity server. */
@Component({
  selector: 'trn-change-identity-server-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './change-identity-server-dialog.component.html',
  imports: [
    FormField,
    FormRoot,
    TrnButton,
    TrnDialogActions,
    TrnDialogShellComponent,
    TrnInput,
    TrnLabel,
  ],
})
export class ChangeIdentityServerDialogComponent {
  private readonly identity = inject(IdentityServerService);
  private readonly alert = inject(TrnAlertService);
  private readonly ref = inject(TrnDialogRef, { optional: true });
  private readonly destroyRef = inject(DestroyRef);

  protected readonly copy = EMAIL_ADDRESSES_COPY;
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  readonly accountId = input.required<string>();
  /** The server in use now, or empty when there is none. */
  readonly current = input('');
  /** The addresses `current` lets people find the account by. */
  readonly published = input<readonly string[]>([]);

  private readonly model = signal({ url: '' });
  protected readonly urlForm = form(this.model, (path) => {
    required(path.url);
    pattern(path.url, /^https:\/\/\S+$/i);
  });
  protected readonly invalid = computed(() => this.urlForm().invalid());

  canDismiss(): boolean {
    return !this.busy();
  }

  close(): void {
    if (this.canDismiss()) this.ref?.close();
  }

  submit(): void {
    if (this.busy()) return;
    this.urlForm.url().value.update((value) => value.trim());
    if (this.invalid()) {
      this.error.set(this.copy.notHttps);
      return;
    }
    this.error.set('');
    const accountId = this.accountId();
    const url = this.model().url;
    const old = this.current();
    const published = this.published();
    const release$ =
      old === '' || published.length === 0
        ? of(true)
        : this.alert.confirm$({
            header: this.copy.changeServerQuestion,
            message: this.copy.unpublishBody(hostOf(old), published.length),
            confirmText: this.copy.changeButton,
          });
    release$
      .pipe(
        take(1),
        filter(Boolean),
        switchMap(() => {
          this.busy.set(true);
          // The identity server URL is shared client state, so the old server finishes first.
          return old === '' || published.length === 0
            ? of({ kind: 'unpublished' } as const)
            : this.identity.unpublishAll(accountId, old, published);
        }),
        switchMap((released) =>
          released.kind === 'unpublished'
            ? this.identity.use(accountId, url)
            : of(released),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((result) => {
        this.busy.set(false);
        if (result.kind === 'saved') {
          this.ref?.close({ kind: 'changed' } satisfies IdentityServerChanged);
        } else {
          this.error.set(this.message(result.reason, old || url));
        }
      });
  }

  private message(reason: IdentityServerRefusal, url: string): string {
    switch (reason) {
      case 'not-https':
        return this.copy.notHttps;
      case 'not-identity-server':
        return this.copy.notIdentityServer;
      default:
        return this.copy.serverUnreachable(hostOf(url));
    }
  }
}
