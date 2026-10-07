import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  viewChild,
  input,
  model,
  output,
} from '@angular/core';
import { TrnButton, TrnInput } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import type { SettingsSearchResult } from '../../settings-sections';

@Component({
  selector: 'trn-settings-directory-search',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnInput, TrnIconComponent],
  templateUrl: './settings-directory-search.component.html',
  host: { class: 'block min-w-0 py-2' },
})
export class SettingsDirectorySearchComponent {
  private readonly search =
    viewChild.required<ElementRef<HTMLInputElement>>('search');

  readonly query = model('');
  readonly count = input(0);
  /** The current matches; only the ones naming a part are listed here, sections are the nav. */
  readonly results = input<readonly SettingsSearchResult[]>([]);
  readonly resultSelected = output<SettingsSearchResult>();

  protected readonly partResults = computed(() =>
    this.results().filter(({ part }) => part),
  );

  focus(): void {
    this.search().nativeElement.focus();
  }
}
