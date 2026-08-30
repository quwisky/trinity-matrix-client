import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TrnIconComponent } from '@trinity/components/foundations';

/**
 * The "drop them here" sheet shown over the conversation while files are dragged across it.
 *
 * Its own component only because both message lists need it and neither has a wrapper element
 * to hang it on; it holds no state and takes no inputs, since whether to render it is the
 * drop directive's `active`.
 */
@Component({
  selector: 'trn-drop-overlay',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent],
  templateUrl: './drop-overlay.component.html',
  styleUrl: './drop-overlay.component.scss',
})
export class DropOverlayComponent {}
