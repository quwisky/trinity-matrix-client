import { Injectable, inject } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { Overlay } from '@angular/cdk/overlay';
import { TrnDialogRef } from '../dialog/trn-dialog-ref';
import { TrnActionSheetRef } from './trn-action-sheet-ref';
import {
  TrnActionSheetComponent,
  type ActionSheetData,
} from './trn-action-sheet.component';

/**
 * Bottom-sheet action menu — the spartan replacement for Ionic's
 * `ActionSheetController`. Opens {@link TrnActionSheetComponent} in a
 * bottom-anchored CDK dialog. Call `open({ header?, buttons })`.
 *
 * `open()` RETURNS its handle. A sheet that cannot be closed by whoever opened it is a
 * menu that outlives the thing it acts on: the message timeline destroys a row when it
 * is redacted, edited, or scrolled out of the virtual window, and a sheet still standing
 * over a dead row offers actions that quietly do nothing. The opener closes it.
 *
 * `ariaLabel` for the same reason `TrnDialogService` takes one: CDK renders
 * `role="dialog"` with no accessible name, so a screen reader announces a bare "dialog".
 * The header is a muted caption, not a heading, and does not fill that gap.
 */
@Injectable({ providedIn: 'root' })
export class TrnActionSheetService {
  private readonly dialog = inject(Dialog);
  private readonly overlay = inject(Overlay);

  open(data: ActionSheetData, ariaLabel?: string): TrnActionSheetRef {
    const ref = this.dialog.open<
      void,
      ActionSheetData,
      TrnActionSheetComponent
    >(TrnActionSheetComponent, {
      data,
      ariaLabel: ariaLabel ?? data.header,
      backdropClass: ['cdk-overlay-dark-backdrop'],
      positionStrategy: this.overlay
        .position()
        .global()
        .centerHorizontally()
        .bottom('12px'),
    });
    return new TrnActionSheetRef(
      new TrnDialogRef<void>(ref),
      () => ref.componentInstance?.surface ?? null,
    );
  }
}
