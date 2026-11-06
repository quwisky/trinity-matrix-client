import { Directive, ElementRef, inject } from '@angular/core';
import { TrnDialogRef } from '../dialog/trn-dialog-ref';
import { TrnDialogShellComponent } from './trn-dialog-shell.component';

/**
 * Marks a footer action that only dismisses. A sheet hides it, since the shell's Cancel block
 * is the sheet's one dismissal; give the shell its text through `cancelText`. In a sheet, a
 * static `data-autofocus` on the host moves to that Cancel block.
 */
@Directive({
  selector: '[trnDialogDismiss]',
  host: { '[hidden]': 'sheet' },
})
export class TrnDialogDismiss {
  protected readonly sheet =
    inject(TrnDialogRef, { optional: true })?.presentation === 'sheet';

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
    // Imperative and sheet-only, so a dialog's bound `[attr.data-autofocus]` stays the caller's.
    if (this.sheet && host.hasAttribute('data-autofocus')) {
      host.removeAttribute('data-autofocus');
      inject(TrnDialogShellComponent, { optional: true })?.autofocusCancel();
    }
  }
}
