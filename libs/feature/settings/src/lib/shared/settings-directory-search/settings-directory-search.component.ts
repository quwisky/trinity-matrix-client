import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  viewChild,
  input,
  model,
} from '@angular/core';
import { TrnButton, TrnInput } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';

@Component({
  selector: 'trn-settings-directory-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnInput, TrnIconComponent],
  templateUrl: './settings-directory-search.component.html',
  host: { class: 'block min-w-0 p-2' },
})
export class SettingsDirectorySearchComponent {
  private readonly search =
    viewChild.required<ElementRef<HTMLInputElement>>('search');

  readonly query = model('');
  readonly count = input(0);

  focus(): void {
    this.search().nativeElement.focus();
  }
}
