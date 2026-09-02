import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnAnchoredOverlayDirective } from '../../../anchored/trn-anchored-overlay.directive';
import { TrnOverlaySurfaceDirective } from '../../trn-overlay-surface.directive';

@Component({
  selector: 'trn-layered-overlay-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnAnchoredOverlayDirective, TrnButton, TrnOverlaySurfaceDirective],
  templateUrl: './layered-overlay-story.component.html',
})
export class LayeredOverlayStoryComponent {
  protected readonly open = signal(true);
}
