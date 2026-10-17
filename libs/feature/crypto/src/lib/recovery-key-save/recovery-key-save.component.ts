import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  effect,
  input,
  linkedSignal,
  output,
  viewChild,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnCheckboxComponent } from '@trinity/components/controls';
import { RecoveryKeyDisplayComponent } from '../recovery-key-display/recovery-key-display.component';

/**
 * The shown-once gate, shared by first-run setup and by the reset that mints a
 * replacement key. The contract: the key is displayed exactly once, and the way out is
 * disabled until the user says they have it.
 *
 * The visible checkbox label is load-bearing for three Playwright specs, which select it
 * by accessible name. It carries no `aria-label`: an override would make the accessible
 * name differ from the words on screen (WCAG 2.5.3).
 */
@Component({
  selector: 'trn-recovery-key-save',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recovery-key-save.component.html',
  styleUrls: ['./recovery-key-save.component.scss'],
  imports: [TrnButton, TrnCheckboxComponent, RecoveryKeyDisplayComponent],
})
export class RecoveryKeySaveComponent {
  readonly recoveryKey = input.required<string>();
  readonly heading = input.required<string>();
  readonly intro = input<string | null>(null);
  readonly warning = input.required<string>();
  readonly confirmLabel = input.required<string>();
  /** Test hook for the confirm button; each surface keeps its own id. */
  readonly confirmTestId = input<string | null>(null);

  readonly confirmed = output<void>();

  /**
   * Ticked-and-saved, reset whenever a DIFFERENT key is shown. A `linkedSignal` because a
   * surface can show a second key without being destroyed (a reset whose `returnTo` is
   * the current page navigates nowhere); a stale tick would open the gate on a new key.
   */
  readonly saved = linkedSignal<string, boolean>({
    source: this.recoveryKey,
    computation: () => false,
  });

  private readonly headingRef =
    viewChild<ElementRef<HTMLElement>>('savedHeading');
  /**
   * Which key focus has already moved for. Keyed off the key, not a boolean, like
   * {@link saved}: a second key needs focus moved again for screen-reader users.
   */
  private focusedKey: string | null = null;

  constructor() {
    effect(() => {
      const heading = this.headingRef();
      const key = this.recoveryKey();
      if (heading && this.focusedKey !== key) {
        this.focusedKey = key;
        heading.nativeElement.focus();
      }
    });
  }
}
