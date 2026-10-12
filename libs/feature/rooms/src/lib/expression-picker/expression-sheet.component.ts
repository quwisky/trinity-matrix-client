import {
  ChangeDetectionStrategy,
  Component,
  input,
  type Signal,
} from '@angular/core';
import { type TrnEmojiPick } from '@trinity/components/controls';
import { TrnDialogShellComponent } from '@trinity/components/overlay';
import { type GifResult } from '@trinity/data-access/gif';
import type { ImagePack, ImagePackImage } from '@trinity/data-access/media';
import { ExpressionPickerComponent } from './expression-picker.component';

/**
 * What the composer lends the sheet: live state as signals, because a dialog's inputs are set
 * once at open, and the composer's own handlers, so a pick in the sheet runs exactly the path
 * a pick in the anchored panel does.
 */
export interface ExpressionSheetBridge {
  readonly panelId: string;
  readonly gifEnabled: Signal<boolean>;
  readonly stickerEnabled: Signal<boolean>;
  readonly stickerPacks: Signal<readonly ImagePack[]>;
  readonly gifBusy: Signal<boolean>;
  emojiPick(pick: TrnEmojiPick): void;
  gifSelect(gif: GifResult): void;
  stickerSelect(sticker: ImagePackImage): void;
  manage(): void;
  dismiss(): void;
}

/**
 * The expression panel as a bottom sheet, for phones and narrow screens. Opened by the
 * composer through `TrnSurfaceService`, so it has the app's sheet frame: the handle, swipe
 * and Escape to close, the backdrop and focus restored to the trigger. Its close button sits
 * on the panel's tab row rather than in a header row of its own.
 *
 * It is as tall as its picker (each picker caps its own height). While the on-screen
 * keyboard is open, the sheet frame lifts the sheet above it, fits it to the visible area and
 * scrolls the focused search back into view (`TrnSheetKeyboardAvoidance`), so the search
 * stays visible even where the keyboard overlays the page rather than resizing it.
 */
@Component({
  selector: 'trn-expression-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnDialogShellComponent, ExpressionPickerComponent],
  templateUrl: './expression-sheet.component.html',
})
export class ExpressionSheetComponent {
  readonly bridge = input.required<ExpressionSheetBridge>();
}
