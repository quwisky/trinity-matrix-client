import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';

/** What applying the document in the box would do: why it was refused, what it skips, what moves. */
@Component({
  selector: 'trn-config-apply-review',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './config-apply-review.component.html',
  host: { class: 'block' },
  imports: [TrnButton],
})
export class ConfigApplyReviewComponent {
  readonly problems = input.required<readonly string[]>();
  readonly warnings = input.required<readonly string[]>();
  readonly changeLines = input.required<readonly string[]>();
  readonly nothingToChange = input.required<boolean>();
  readonly applying = input.required<boolean>();
  readonly confirmed = output<void>();
  readonly cancelled = output<void>();
}
