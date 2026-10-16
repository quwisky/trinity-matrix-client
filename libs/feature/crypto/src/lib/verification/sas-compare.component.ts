import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnSpinnerComponent } from '@trinity/components/generic-content';
import { type SasEmoji } from '@trinity/data-access/trust';

/**
 * The Short-Authentication-String emoji comparison: the seven emoji (glyph + name) and a
 * match decision. Presentational; the host page owns the lifecycle. Each emoji is
 * announced by its **name** (the glyph is decorative), since glyphs read inconsistently
 * across screen readers.
 */
@Component({
  selector: 'trn-sas-compare',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './sas-compare.component.scss',
  imports: [TrnButton, TrnSpinnerComponent],
  templateUrl: './sas-compare.component.html',
})
export class SasCompareComponent {
  readonly emoji = input.required<SasEmoji[]>();
  readonly busy = input(false);
  /**
   * We already answered "they match" and are waiting for the other side. The emoji stay
   * on screen (the other device may still be waiting to be read) but the answer is spent.
   */
  readonly confirmed = input(false);

  readonly match = output<void>();
  readonly mismatch = output<void>();
  readonly cancelled = output<void>();
}
