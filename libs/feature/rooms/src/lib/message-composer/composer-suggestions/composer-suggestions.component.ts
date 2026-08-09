import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type { EmojiData } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import { type MentionMember } from '../mention-autocomplete';

/**
 * The two autocomplete menus floated above the composer input: `:shortcode` emoji and
 * `@mention` members.
 *
 * Presentational — the engines behind them live in `EmojiAutocomplete` /
 * `MentionAutocomplete` and the composer owns the caret. Both menus float
 * (`position: absolute`) against `.composer`, so the host generates no box at all
 * (`display: contents`) and the anchoring is unchanged.
 *
 * **The element ids here are a contract with the composer's textarea**, which points
 * `aria-controls` at `emoji-suggestions` / `mention-suggestions` and `aria-activedescendant`
 * at `emoji-suggestion-<index>` / `mention-suggestion-<index>`. The composer's
 * `scrollSuggestionIntoView` looks the same ids up by hand. Renaming one means renaming all
 * three sites.
 */
@Component({
  selector: 'trn-composer-suggestions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './composer-suggestions.component.html',
  styleUrl: './composer-suggestions.component.scss',
})
export class ComposerSuggestionsComponent {
  /** Whether the emoji menu is shown (a query yielded at least one match). */
  readonly emojiOpen = input(false);
  /** Ranked emoji suggestions for the current query. */
  readonly emojiMatches = input<readonly EmojiData[]>([]);
  /** Index of the highlighted emoji suggestion. */
  readonly emojiActiveIndex = input(0);
  /** Whether the mention menu is shown (a query yielded at least one member). */
  readonly mentionOpen = input(false);
  /** Members matching the current query. */
  readonly mentionMatches = input<readonly MentionMember[]>([]);
  /** Index of the highlighted member suggestion. */
  readonly mentionActiveIndex = input(0);

  /** The pointer moved onto an emoji suggestion — highlight it. */
  readonly emojiHighlight = output<number>();
  /** An emoji suggestion was clicked. */
  readonly emojiAccept = output<number>();
  /** The pointer moved onto a member suggestion — highlight it. */
  readonly mentionHighlight = output<number>();
  /** A member suggestion was clicked. */
  readonly mentionAccept = output<number>();
}
