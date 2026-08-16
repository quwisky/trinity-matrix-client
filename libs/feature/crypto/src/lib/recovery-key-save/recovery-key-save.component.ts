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
import { HlmButton } from '@trinity/helm/button';
import { TrnCheckboxComponent } from '@trinity/components/checkbox';
import { RecoveryKeyDisplayComponent } from '../recovery-key-display/recovery-key-display.component';

/**
 * "Here is your recovery key — save it before you go anywhere." The shown-once gate,
 * shared by first-run setup and by the reset that mints a replacement.
 *
 * It exists as a component because the two surfaces had a copy each and they had already
 * drifted apart in seven ways — including one page losing the `.warning` style entirely
 * (it lived only in the other page's stylesheet, so encapsulation left the warning as
 * plain body text) and only one of them moving focus to the heading on reveal. The
 * contract this enforces — the key is displayed exactly once, and the way out is disabled
 * until the user says they have it — is not something to maintain in two places.
 *
 * The visible checkbox label is load-bearing for three Playwright specs, which select it
 * by accessible name. It carries no `aria-label`: an override there would make the
 * accessible name differ from the words on screen (WCAG 2.5.3).
 */
@Component({
  selector: 'trn-recovery-key-save',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './recovery-key-save.component.html',
  styleUrls: ['./recovery-key-save.component.scss'],
  imports: [HlmButton, TrnCheckboxComponent, RecoveryKeyDisplayComponent],
})
export class RecoveryKeySaveComponent {
  readonly recoveryKey = input.required<string>();
  readonly heading = input.required<string>();
  /** Optional lead paragraph above the warning; setup has one, the reset does not. */
  readonly intro = input<string | null>(null);
  readonly warning = input.required<string>();
  readonly confirmLabel = input.required<string>();
  /** Test hook for the confirm button, so each surface keeps its own established id. */
  readonly confirmTestId = input<string | null>(null);

  /** The user says the key is saved; the way out opens. */
  readonly confirmed = output<void>();

  /**
   * Ticked-and-saved, reset whenever a DIFFERENT key is shown.
   *
   * `linkedSignal` rather than a plain signal because a surface can present a second key
   * without being destroyed in between — a reset whose `returnTo` points back at the page
   * it is already on navigates nowhere. A stale tick there would hand someone a
   * shown-once key with the gate already open.
   */
  readonly saved = linkedSignal<string, boolean>({
    source: this.recoveryKey,
    computation: () => false,
  });

  private readonly headingRef =
    viewChild<ElementRef<HTMLElement>>('savedHeading');
  /**
   * Which key we have already moved focus for.
   *
   * Keyed off the key rather than latched by a boolean, for the same reason {@link saved}
   * is: a second key shown by this instance is a second "save this now" moment, and a
   * screen-reader user who is left where they were will not know it happened.
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
