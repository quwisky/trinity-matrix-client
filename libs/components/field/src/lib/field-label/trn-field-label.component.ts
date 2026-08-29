import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { HlmLabel } from '@trinity/helm/label';

export type TrnFieldLabelVariant = 'default' | 'eyebrow';

/** A native label whose visual treatment belongs to Trinity's public field API. */
@Component({
  selector: 'trn-field-label',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [HlmLabel],
  templateUrl: './trn-field-label.component.html',
  styleUrl: './trn-field-label.component.scss',
})
export class TrnFieldLabelComponent {
  readonly controlId = input.required<string>();
  readonly variant = input<TrnFieldLabelVariant>('default');
}
