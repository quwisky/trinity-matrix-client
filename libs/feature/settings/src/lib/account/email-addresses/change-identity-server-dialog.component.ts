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
import { map, of, switchMap, take } from 'rxjs';
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
import { serverNameOf } from '../delete-account/delete-account.copy';
import { EMAIL_ADDRESSES_COPY, hostOf } from './email-addresses.copy';

/** What the dialog closes with: the server saved, or addresses were unpublished but saving failed. */
export type IdentityServerClosed =
  | { readonly kind: 'changed' }
  | { readonly kind: 'partial'; readonly message: string };

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
    const old = this.current();
    const published = this.published();
    if (old && normalizeUrl(this.model().url) === normalizeUrl(old)) {
      this.ref?.close();
      return;
    }
    this.busy.set(true);
    this.identity
      .check(this.model().url)
      .pipe(
        switchMap((checked) => {
          if (checked.kind === 'refused') {
            return of({ kind: 'invalid', refusal: checked } as const);
          }
          const next = checked.url;
          if (published.length === 0) {
            return this.identity
              .use(accountId, next)
              .pipe(map((used) => ({ kind: 'used', used, next }) as const));
          }
          this.busy.set(false);
          return this.alert
            .confirm$({
              header: this.copy.changeServerQuestion,
              message: this.copy.unpublishBody(hostOf(old), published.length),
              confirmText: this.copy.changeButton,
            })
            .pipe(
              take(1),
              switchMap((yes) => {
                if (!yes) return of({ kind: 'cancelled' } as const);
                this.busy.set(true);
                const use$ = () =>
                  this.identity
                    .use(accountId, next)
                    .pipe(
                      map((used) => ({ kind: 'used', used, next }) as const),
                    );
                // The identity server URL is shared client state, so the old server finishes first.
                return this.identity
                  .unpublishAll(accountId, old, published)
                  .pipe(
                    switchMap((released) => {
                      if (released.kind === 'unpublished') return use$();
                      this.busy.set(false);
                      return this.alert
                        .confirm$({
                          header: this.copy.changeAnywayTitle,
                          message: this.copy.mayStillFindAll(hostOf(old)),
                          confirmText: this.copy.changeAnyway,
                        })
                        .pipe(
                          take(1),
                          switchMap((anyway) => {
                            if (!anyway) {
                              return of({ kind: 'unpublish-refused' } as const);
                            }
                            this.busy.set(true);
                            return use$();
                          }),
                        );
                    }),
                  );
              }),
            );
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((outcome) => {
        this.busy.set(false);
        const partial = published.length > 0;
        switch (outcome.kind) {
          case 'cancelled':
            return;
          case 'invalid':
            this.error.set(
              this.message(outcome.refusal.reason, this.model().url),
            );
            return;
          case 'unpublish-refused':
            this.stop(this.copy.serverUnreachable(hostOf(old)), partial);
            return;
          case 'used':
            if (outcome.used.kind === 'saved') {
              this.ref?.close({
                kind: 'changed',
              } satisfies IdentityServerClosed);
            } else {
              this.stop(
                this.message(outcome.used.reason, outcome.next),
                partial,
              );
            }
        }
      });
  }

  /** After addresses were unpublished, the row must reload even though the change failed. */
  private stop(message: string, partial: boolean): void {
    if (!partial) {
      this.error.set(message);
      return;
    }
    this.ref?.close({
      kind: 'partial',
      message,
    } satisfies IdentityServerClosed);
  }

  private message(reason: IdentityServerRefusal, url: string): string {
    switch (reason) {
      case 'not-https':
        return this.copy.notHttps;
      case 'not-identity-server':
        return this.copy.notIdentityServer;
      case 'unreachable':
        return this.copy.serverUnreachable(hostOf(url));
      default:
        return this.copy.saveFailed(serverNameOf(this.accountId()));
    }
  }
}

function normalizeUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}
