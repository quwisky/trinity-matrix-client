import {
  ChangeDetectionStrategy,
  Component,
  ViewEncapsulation,
  input,
  output,
} from '@angular/core';
import { PickerComponent } from '@ctrl/ngx-emoji-mart';
import type { EmojiEvent } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import type { TrnEmojiPick } from '../trn-emoji.model';

/**
 * Trinity's emoji picker.
 *
 * Wraps `@ctrl/ngx-emoji-mart` so the two call sites — the composer panel and the reaction
 * dialog — name Trinity's API rather than the vendor's. Both previously repeated the same
 * five inputs and read `event.emoji.native` out of a loosely typed event; that repetition
 * is now one place, and the narrowing is enforced by {@link TrnEmojiPick}.
 *
 * **`darkMode` is deliberately not exposed, and pinned `false`.** The vendor's idea of
 * theming is one boolean that toggles an `.emoji-mart-dark` class, which cannot express
 * Trinity's mode x palette grid — so the picker rendered its own purple and its own greys
 * under all four combinations. It has to be pinned rather than simply left unbound: the
 * vendor's default is `matchMedia('(prefers-color-scheme: dark)').matches`, so an absent
 * binding follows the OS. Pinned `false`, the class stays off the element entirely, which
 * means our overrides only have to beat `.emoji-mart` base rules rather than the ten more
 * specific `.emoji-mart-dark` ones. `trn-emoji-picker.component.scss` then paints it from
 * design tokens, so it re-themes with everything else.
 *
 * **The accent goes in through the vendor's `color` input, not through the stylesheet.**
 * It is rendered as an inline style in both places it appears — the anchor bar's background
 * and the selected category anchor, whose icon inherits it via `fill: currentColor` — and
 * an inline style outranks any rule we could write short of `!important`. Handing the
 * vendor `var(--trinity-accent)` puts one token in charge of both.
 *
 * **It claims no ARIA role of its own, and that is deliberate.** An earlier revision made
 * the host a `role="dialog"` with a label, which is wrong at both call sites. In the
 * reaction flow it sits inside a CDK dialog container that already carries that role, so it
 * produced a dialog nested in a dialog; in the composer it is an inline, absolutely
 * positioned panel with no modality and no focus trap, and `role="dialog"` promises focus
 * management that does not exist. Naming belongs to whatever actually is the dialog — the
 * CDK container, via `TrnDialogService`'s `ariaLabel` — or to the trigger relationship,
 * which is what `pickerId` plus the caller's `aria-controls` expresses.
 *
 * `ViewEncapsulation.None` because the vendor's inner DOM carries no `_ngcontent`
 * attribute, so an encapsulated stylesheet cannot reach `.emoji-mart-category-label` at
 * all. Scoped by the `.trn-emoji-picker` host class rather than leaking globally, and
 * loaded only with this component's chunk — which is why the override lives here and not
 * beside `rendered-markdown.scss`.
 */
@Component({
  selector: 'trn-emoji-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  encapsulation: ViewEncapsulation.None,
  imports: [PickerComponent],
  templateUrl: './trn-emoji-picker.component.html',
  styleUrl: './trn-emoji-picker.component.scss',
  host: {
    class: 'trn-emoji-picker',
    // No `role` and no `aria-label`, deliberately — see the note above.
    '[attr.id]': 'pickerId()',
    'data-testid': 'emoji-picker',
  },
})
export class TrnEmojiPickerComponent {
  /**
   * Host id, so a trigger can point `aria-controls` at the open panel. The composer's
   * toggle already carries `aria-expanded` with nothing to reference.
   */
  readonly pickerId = input<string | null>(null);
  /** Emoji glyph size in px. */
  readonly emojiSize = input(20);

  /**
   * Trinity's accent, handed to the vendor as its own `color`.
   *
   * A token rather than a literal, and passed rather than overridden: the vendor writes
   * this value into inline styles, which a stylesheet cannot outrank without `!important`.
   */
  protected readonly accent = 'var(--trinity-accent)';

  /** A usable pick. Entries without a `native` character never reach here. */
  readonly picked = output<TrnEmojiPick>();

  protected onSelect(event: EmojiEvent): void {
    const emoji = event.emoji as
      { native?: string; id?: string; colons?: string } | undefined;
    const native = emoji?.native;
    // Dropped rather than forwarded: a pick with no character is not insertable, and both
    // call sites used to handle it differently by accident — the reaction dialog closed
    // with `null` and the composer silently did nothing. Neither was a decision.
    if (!native) return;
    this.picked.emit({
      native,
      id: String(emoji?.id ?? ''),
      colons: String(emoji?.colons ?? ''),
    });
  }
}
