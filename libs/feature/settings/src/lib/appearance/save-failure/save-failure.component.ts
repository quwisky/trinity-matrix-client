import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';

/**
 * The inline "This choice could not be saved." alert under an Appearance control, with an
 * optional Try again button.
 *
 * The host is the alert, so callers put `data-testid`, spacing and `justify-*` on the element.
 */
@Component({
  selector: 'trn-save-failure',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    role: 'alert',
    class: 'flex flex-wrap items-center gap-2 text-13 text-danger',
  },
  imports: [TrnButton],
  templateUrl: './save-failure.component.html',
})
export class SaveFailureComponent {
  /** Whether the failure offers Try again; some saves have nothing to retry. */
  readonly retryable = input(true);
  readonly retryTestId = input<string>();

  readonly retry = output<void>();
}
