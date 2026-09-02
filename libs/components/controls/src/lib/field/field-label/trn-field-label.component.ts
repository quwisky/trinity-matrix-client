import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { HlmLabel } from '@trinity/helm/label';
import {
  trnFieldLabelRecipe,
  type TrnFieldLabelEmphasis,
} from '../trn-field-recipe';

export type { TrnFieldLabelEmphasis } from '../trn-field-recipe';

/** A native label whose visual treatment belongs to Trinity's public field API. */
@Component({
  selector: 'trn-field-label',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmLabel],
  templateUrl: './trn-field-label.component.html',
  host: { class: 'block' },
})
export class TrnFieldLabelComponent {
  readonly controlId = input.required<string>();
  /** Canonical typographic prominence; validation stays a separate state. */
  readonly emphasis = input<TrnFieldLabelEmphasis>('normal');
  readonly invalid = input(false, { transform: booleanAttribute });

  protected readonly labelClass = computed(() =>
    trnFieldLabelRecipe(this.emphasis(), this.invalid()),
  );
}
