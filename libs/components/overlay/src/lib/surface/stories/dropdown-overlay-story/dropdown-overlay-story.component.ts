import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnDropdownMenu,
  TrnDropdownMenuItem,
  TrnDropdownMenuTrigger,
} from '../../../dropdown/trn-dropdown-menu';

@Component({
  selector: 'trn-dropdown-overlay-story',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    TrnButton,
    TrnDropdownMenu,
    TrnDropdownMenuItem,
    TrnDropdownMenuTrigger,
  ],
  templateUrl: './dropdown-overlay-story.component.html',
})
export class DropdownOverlayStoryComponent {
  protected readonly result = signal('Nothing chosen');
}
