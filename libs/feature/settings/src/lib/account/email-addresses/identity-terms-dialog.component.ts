import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnDialogActions,
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import type { IdentityPolicy } from '@trinity/data-access/contact-addresses';
import { EMAIL_ADDRESSES_COPY } from './email-addresses.copy';

/** Settings › Account › Email addresses: the terms an identity server wants accepted. Closes with `true` on Accept. */
@Component({
  selector: 'trn-identity-terms-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './identity-terms-dialog.component.html',
  imports: [TrnButton, TrnDialogActions, TrnDialogShellComponent],
})
export class IdentityTermsDialogComponent {
  private readonly ref = inject(TrnDialogRef, { optional: true });

  protected readonly copy = EMAIL_ADDRESSES_COPY;

  readonly host = input.required<string>();
  readonly policies = input.required<readonly IdentityPolicy[]>();

  close(accepted = false): void {
    if (accepted) this.ref?.close(true);
    else this.ref?.close();
  }
}
