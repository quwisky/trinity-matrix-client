import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { HlmButton } from '@trinity/helm/button';
import { type SasEmoji } from '@trinity/data-access-crypto';

/**
 * The Short-Authentication-String emoji comparison: shows the seven emoji (glyph
 * + name) and asks the user whether they match the other device. Presentational —
 * it takes the emoji as an input and emits the user's decision; the host page owns
 * the verification lifecycle. Each emoji is announced by its **name** (the glyph is
 * decorative), since glyphs read inconsistently across screen readers.
 */
@Component({
  selector: 'trn-sas-compare',
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './sas-compare.component.scss',
  imports: [HlmButton],
  templateUrl: './sas-compare.component.html',
})
export class SasCompareComponent {
  /** The seven SAS emoji to compare. */
  readonly emoji = input.required<SasEmoji[]>();
  /** Disables the actions while a decision is being submitted. */
  readonly busy = input(false);

  readonly match = output<void>();
  readonly mismatch = output<void>();
  readonly cancelled = output<void>();
}
