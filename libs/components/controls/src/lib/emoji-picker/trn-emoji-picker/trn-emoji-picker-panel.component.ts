import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { PickerComponent } from '@ctrl/ngx-emoji-mart';
import type { EmojiEvent } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import {
  trnEmojiPickerGlyphSize,
  type TrnEmojiPickerSize,
} from './trn-emoji-picker-recipe';

/**
 * The vendor `emoji-mart` picker, and nothing else.
 *
 * Internal to {@link TrnEmojiPickerComponent}, which loads it through `@defer` so the
 * vendor's chunk (about 1 MB) stays out of the initial bundle. It must stay unreachable
 * from the library barrel and from any static import, or the bundler pulls it back in.
 * Theming, ARIA and the pinned vendor inputs are explained on the wrapper and in the
 * template.
 */
@Component({
  selector: 'trn-emoji-picker-panel',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [PickerComponent],
  templateUrl: './trn-emoji-picker-panel.component.html',
  host: { style: 'display: block' },
})
export class TrnEmojiPickerPanelComponent {
  readonly size = input.required<TrnEmojiPickerSize>();
  readonly emojiSelect = output<EmojiEvent>();

  protected readonly vendorEmojiSize = computed(() =>
    trnEmojiPickerGlyphSize(this.size()),
  );

  /**
   * Trinity's accent, handed to the vendor as its own `color`.
   *
   * A token rather than a literal, and passed rather than overridden: the vendor writes
   * this value into inline styles, which a stylesheet cannot outrank without `!important`.
   */
  protected readonly accent = 'var(--trinity-accent)';
}
