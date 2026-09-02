import {
  booleanAttribute,
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { HlmLabel } from '@trinity/helm/label';
import {
  resolveTrnFieldLabelEmphasis,
  trnFieldLabelRecipe,
  type TrnFieldLabelEmphasis,
  type TrnFieldLabelVariant,
} from '../trn-field-recipe';

export type {
  TrnFieldLabelEmphasis,
  TrnFieldLabelVariant,
} from '../trn-field-recipe';

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
  readonly emphasis = input<TrnFieldLabelEmphasis | null>(null);
  /** Temporary compatibility alias for the login consumer migration. */
  readonly variant = input<TrnFieldLabelVariant>('default');
  readonly invalid = input(false, { transform: booleanAttribute });

  protected readonly resolvedEmphasis = computed(() =>
    resolveTrnFieldLabelEmphasis(this.emphasis(), this.variant()),
  );
  protected readonly labelClass = computed(() =>
    trnFieldLabelRecipe(this.resolvedEmphasis(), this.invalid()),
  );
}
