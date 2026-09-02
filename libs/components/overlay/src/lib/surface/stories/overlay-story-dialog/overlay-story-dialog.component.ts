import {
  ChangeDetectionStrategy,
  Component,
  inject,
  input,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnDialogRef } from '../../../dialog/trn-dialog-ref';
import type { TrnOverlaySurfaceLayout } from '../../trn-overlay-surface-recipe';
import { TrnOverlaySurfaceDirective } from '../../trn-overlay-surface.directive';

@Component({
  selector: 'trn-overlay-story-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnOverlaySurfaceDirective],
  templateUrl: './overlay-story-dialog.component.html',
})
export class OverlayStoryDialogComponent {
  private readonly ref = inject<TrnDialogRef<string>>(TrnDialogRef);

  readonly title = input('Overlay dialog');
  readonly layout = input<TrnOverlaySurfaceLayout>('dialog');

  protected close(): void {
    this.ref.close(this.title());
  }
}
