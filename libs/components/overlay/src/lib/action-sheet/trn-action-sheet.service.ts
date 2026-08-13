import { Injectable, inject } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { Overlay } from '@angular/cdk/overlay';
import {
  TrnActionSheetComponent,
  type ActionSheetData,
} from './trn-action-sheet.component';

/**
 * Bottom-sheet action menu — the spartan replacement for Ionic's
 * `ActionSheetController`. Opens {@link TrnActionSheetComponent} in a
 * bottom-anchored CDK dialog. Call `open({ header?, buttons })`.
 */
@Injectable({ providedIn: 'root' })
export class TrnActionSheetService {
  private readonly dialog = inject(Dialog);
  private readonly overlay = inject(Overlay);

  open(data: ActionSheetData): void {
    this.dialog.open(TrnActionSheetComponent, {
      data,
      backdropClass: ['cdk-overlay-dark-backdrop'],
      positionStrategy: this.overlay
        .position()
        .global()
        .centerHorizontally()
        .bottom('12px'),
    });
  }
}
