import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnDropdownMenuImports } from '../../../dropdown/trn-dropdown-menu';

@Component({
  selector: 'trn-dropdown-overlay-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnDropdownMenuImports],
  templateUrl: './dropdown-overlay-story.component.html',
})
export class DropdownOverlayStoryComponent {
  protected readonly result = signal('Nothing chosen');
}
