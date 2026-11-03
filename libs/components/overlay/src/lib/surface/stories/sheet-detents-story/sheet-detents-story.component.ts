import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnDialogService } from '../../../dialog/trn-dialog.service';
import { SheetDetentsStorySheetComponent } from './sheet-detents-story-sheet.component';

@Component({
  selector: 'trn-sheet-detents-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton],
  templateUrl: './sheet-detents-story.component.html',
})
export class SheetDetentsStoryComponent {
  private readonly dialog = inject(TrnDialogService);

  protected open(rows: number): void {
    this.dialog.open(SheetDetentsStorySheetComponent, {
      placement: 'bottom',
      ariaLabel: 'Detent sheet',
      autoFocus: false,
      detents: ['medium', 'large'],
      inputs: { rows },
    });
  }
}
