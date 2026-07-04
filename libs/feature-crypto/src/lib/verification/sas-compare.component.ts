import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { HlmButton } from '@trinity/helm/button';
import type { SasEmoji } from '@trinity/core';

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
  template: `
    <ul class="emoji" aria-label="Compare these emoji with your other device">
      @for (e of emoji(); track $index) {
        <li class="emoji__item">
          <span class="emoji__glyph" aria-hidden="true">{{ e.glyph }}</span>
          <span class="emoji__name">{{ e.name }}</span>
        </li>
      }
    </ul>

    <p class="hint">
      Do these emoji match the ones shown on your other device?
    </p>

    <div class="actions">
      <button
        hlmBtn
        class="w-full"
        data-testid="sas-match"
        [disabled]="busy()"
        (click)="match.emit()"
      >
        They match
      </button>
      <button
        hlmBtn
        class="w-full text-destructive"
        variant="outline"
        data-testid="sas-mismatch"
        [disabled]="busy()"
        (click)="mismatch.emit()"
      >
        They don't match
      </button>
      <button
        hlmBtn
        class="w-full"
        variant="ghost"
        [disabled]="busy()"
        (click)="cancelled.emit()"
      >
        Cancel
      </button>
    </div>
  `,
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
