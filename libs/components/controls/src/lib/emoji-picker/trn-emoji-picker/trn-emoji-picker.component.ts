import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  input,
  output,
} from '@angular/core';
import type { EmojiEvent } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import type { TrnEmojiPick } from '../trn-emoji.model';
import { TrnEmojiPickerPanelComponent } from './trn-emoji-picker-panel.component';
import type { TrnEmojiPickerSize } from './trn-emoji-picker-recipe';

export type { TrnEmojiPickerSize } from './trn-emoji-picker-recipe';

/**
 * `fixed` is the vendor's own nine-column width. `fill` takes the host's width: the columns
 * follow from it, at least 44px each on a touch screen, and are recomputed as it changes.
 */
export type TrnEmojiPickerLayout = 'fixed' | 'fill';

/**
 * Trinity's emoji picker. Wraps `@ctrl/ngx-emoji-mart` so call sites name Trinity's API, and
 * {@link TrnEmojiPick} narrows the loosely typed vendor event.
 *
 * **`darkMode` is not exposed and is pinned `false`.** The vendor's one-boolean
 * `.emoji-mart-dark` theming cannot express Trinity's Mode x Theme grid. Pinned, not left
 * unbound, because the vendor default follows `prefers-color-scheme`. With the class off,
 * our overrides only have to beat `.emoji-mart` base rules, and
 * `trn-emoji-picker.component.scss` paints it from design tokens.
 *
 * **The accent goes in through the vendor's `color` input, not the stylesheet.** The vendor
 * renders it as an inline style (anchor bar background, selected anchor via
 * `fill: currentColor`), which no rule outranks short of `!important`.
 *
 * **It claims no ARIA role, deliberately.** `role="dialog"` would nest a dialog inside the
 * CDK dialog container in the reaction flow, and in the composer the panel is inline with no
 * modality or focus trap, so the role would promise focus management that does not exist.
 * Naming belongs to the real dialog (the CDK container, via `TrnSurfaceService`'s
 * `ariaLabel`) or to the trigger relationship: `pickerId` plus the caller's `aria-controls`.
 *
 * `ViewEncapsulation.None` because the vendor's inner DOM carries no `_ngcontent` attribute,
 * so an encapsulated stylesheet cannot reach it. Scoped by the `.trn-emoji-picker` host
 * class so nothing leaks, and loaded only with this component's chunk, which is why the
 * override lives here and not beside `rendered-markdown.scss`.
 */
@Component({
  selector: 'trn-emoji-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [TrnEmojiPickerPanelComponent],
  templateUrl: './trn-emoji-picker.component.html',
  styleUrl: './trn-emoji-picker.component.scss',
  host: {
    class: 'trn-emoji-picker',
    // No `role` and no `aria-label`, deliberately; see the class note.
    '[attr.id]': 'pickerId()',
    '[attr.data-size]': 'size()',
    '[class.trn-emoji-picker--embedded]': '!framed()',
    '[class.trn-emoji-picker--fill]': "layout() === 'fill'",
    'data-testid': 'emoji-picker',
  },
})
export class TrnEmojiPickerComponent {
  /** Host id, so a trigger can point `aria-controls` at the open panel. */
  readonly pickerId = input<string | null>(null);
  /** Trinity-owned ordinal size; the vendor's pixel input stays private. */
  readonly size = input<TrnEmojiPickerSize>('md');
  /**
   * Move focus into the search field when the deferred grid arrives, for a surface that put
   * focus on its content before the vendor chunk loaded (the composer's bottom sheet).
   */
  readonly autoFocusSearch = input(false);
  /**
   * Draw the picker's own card (border, background, radius and shadow). Off only where a
   * surrounding surface already draws the card, as the composer's expression panel does.
   */
  readonly framed = input(true);
  /** The vendor's fixed width, or the host's whole width (a phone's bottom sheet). */
  readonly layout = input<TrnEmojiPickerLayout>('fixed');
  /**
   * How many times the surface holding the picker has been shown. A surface that keeps the
   * picker between opens bumps it on each open so the picker refreshes its frequently-used
   * row, which the vendor reads only when it is created.
   */
  readonly shown = input(0);
  /**
   * The account's recent emoji, most used first, shown in place of the vendor's per-device
   * frequently-used row. Undefined keeps that row.
   */
  readonly recent = input<readonly string[] | undefined>(undefined);

  /** A usable pick. Entries without a `native` character never reach here. */
  readonly picked = output<TrnEmojiPick>();

  protected onSelect(event: EmojiEvent): void {
    const emoji = event.emoji as
      { native?: string; id?: string; colons?: string } | undefined;
    const native = emoji?.native;
    // Dropped rather than forwarded: a pick with no character is not insertable.
    if (!native) return;
    this.picked.emit({
      native,
      id: String(emoji?.id ?? ''),
      colons: String(emoji?.colons ?? ''),
    });
  }
}
