import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import { IonButton } from '@ionic/angular/standalone';
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
  imports: [IonButton],
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
      <ion-button
        expand="block"
        data-testid="sas-match"
        [disabled]="busy()"
        (click)="match.emit()"
      >
        They match
      </ion-button>
      <ion-button
        expand="block"
        fill="outline"
        color="danger"
        data-testid="sas-mismatch"
        [disabled]="busy()"
        (click)="mismatch.emit()"
      >
        They don't match
      </ion-button>
      <ion-button
        expand="block"
        fill="clear"
        [disabled]="busy()"
        (click)="cancelled.emit()"
      >
        Cancel
      </ion-button>
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
