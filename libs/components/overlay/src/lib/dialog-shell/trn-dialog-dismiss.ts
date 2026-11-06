import { Directive, HostAttributeToken, inject } from '@angular/core';
import { TrnDialogRef } from '../dialog/trn-dialog-ref';
import { TrnDialogShellComponent } from './trn-dialog-shell.component';

/**
 * Marks a footer action that only dismisses. A sheet hides it, since the shell's Cancel block
 * is the sheet's one dismissal; give the shell its text through `cancelText`. A static
 * `data-autofocus` on the host moves to that Cancel block.
 */
@Directive({
  selector: '[trnDialogDismiss]',
  host: {
    '[hidden]': 'sheet',
    '[attr.data-autofocus]': 'sheet ? null : autofocus',
  },
})
export class TrnDialogDismiss {
  protected readonly sheet =
    inject(TrnDialogRef, { optional: true })?.presentation === 'sheet';
  protected readonly autofocus = inject(
    new HostAttributeToken('data-autofocus'),
    { optional: true },
  );

  constructor() {
    if (this.sheet && this.autofocus !== null) {
      inject(TrnDialogShellComponent, { optional: true })?.autofocusCancel();
    }
  }
}
