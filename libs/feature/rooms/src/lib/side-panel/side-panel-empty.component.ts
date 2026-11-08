import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import {
  TrnIconComponent,
  type TrnIconName,
} from '@trinity/components/foundations';

/** What a room panel shows when it has no rows: the panel's icon, a title and one line. */
@Component({
  selector: 'trn-side-panel-empty',
  imports: [TrnIconComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './side-panel-empty.component.html',
  styleUrl: './side-panel-empty.component.scss',
  host: { role: 'status' },
})
export class SidePanelEmptyComponent {
  readonly icon = input.required<TrnIconName>();
  /** Not `title`: a static `title` attribute is also a native tooltip. */
  readonly heading = input.required<string>();
  readonly body = input.required<string>();
}
