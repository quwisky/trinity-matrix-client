import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { classes, hlm } from '@trinity/helm/utils';
import { TrnDialogRef } from '../dialog/trn-dialog-ref';
import {
  TRN_SHEET_DISMISS,
  TrnSheetDrag,
  TrnSheetDragHandle,
  sheetDismissFor,
} from '../dialog-shell/trn-sheet-drag.directive';
import { TrnSheetKeyboardAvoidance } from './trn-sheet-keyboard.directive';
import {
  trnOverlaySurfaceRecipe,
  type TrnOverlaySurfaceSize,
} from '../surface/trn-overlay-surface-recipe';

/**
 * The one bottom-sheet surface: the overlay recipe's sheet layout, the entrance, the bottom
 * safe-area inset, the touch handle and swipe-down-to-dismiss, and keeping clear of the
 * on-screen keyboard ({@link TrnSheetKeyboardAvoidance}).
 *
 * It only sits inside a dialog the surface service opened, so a swipe dismisses through that
 * dialog's ref and keeps its `dismissGuard` and `disableClose`. Content projected with
 * `trnSheetFrameHeader` joins the handle as the drag area; everything else is the body.
 * Opened with `detents`, a phone sheet rests at half or full height instead of its content's.
 */
@Component({
  selector: 'trn-sheet-frame',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnSheetDragHandle],
  hostDirectives: [
    { directive: TrnSheetDrag, inputs: [], outputs: [] },
    { directive: TrnSheetKeyboardAvoidance, inputs: [], outputs: [] },
  ],
  providers: [
    {
      provide: TRN_SHEET_DISMISS,
      useFactory: () => sheetDismissFor(inject(TrnDialogRef), inject(Dialog)),
    },
  ],
  templateUrl: './trn-sheet-frame.component.html',
  styleUrl: './trn-sheet-frame.component.scss',
  host: {
    'data-trn-layout': 'sheet',
    'data-trn-variant': 'neutral',
    '[attr.data-trn-size]': 'size()',
    '[attr.data-testid]': 'testId()',
  },
})
export class TrnSheetFrameComponent {
  private readonly ref = inject(TrnDialogRef);
  private readonly drag = inject(TrnSheetDrag);

  /** A sheet opened `disableClose` shows no handle; the drag directive ignores it too. */
  protected readonly swipeable = !this.ref.disableClose;

  readonly size = input<TrnOverlaySurfaceSize>('md');
  /** Dialogs and action lists keep the test hooks their journeys already use. */
  readonly testId = input('sheet-surface');

  constructor() {
    classes(() =>
      hlm(
        trnOverlaySurfaceRecipe('neutral', this.size(), 'sheet'),
        'trn-overlay-enter-sheet flex flex-col border-[var(--trinity-border-overlay)] bg-[var(--trinity-surface-overlay)]',
        // A detent sheet takes the height its drag sets, up to full height; both set by TrnSheetDrag.
        this.drag.detent() &&
          'h-[var(--trn-sheet-height)] max-h-[var(--trn-sheet-max-height)]',
      ),
    );
  }
}
