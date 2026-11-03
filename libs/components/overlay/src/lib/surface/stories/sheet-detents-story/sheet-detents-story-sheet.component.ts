import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { TrnInput } from '@trinity/components/controls';
import { TrnDialogShellComponent } from '../../../dialog-shell/trn-dialog-shell.component';

@Component({
  selector: 'trn-sheet-detents-story-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnDialogShellComponent, TrnInput],
  templateUrl: './sheet-detents-story-sheet.component.html',
})
export class SheetDetentsStorySheetComponent {
  readonly rows = input(40);
  protected readonly items = computed(() =>
    Array.from({ length: this.rows() }, (_, i) => `Row ${i + 1}`),
  );
}
