import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
} from '@angular/core';
import type { TrnEmojiSuggestion } from '@trinity/components/controls';
import { AvatarComponent } from '@trinity/components/generic-content';
import {
  TrnAnchoredOverlayDirective,
  TrnOverlaySurfaceDirective,
} from '@trinity/components/overlay';
import { type MentionMember } from '../mention-autocomplete';
import { type SlashCommand } from '@trinity/util/matrix';

/**
 * The autocomplete menus floated above the composer input: `:shortcode` emoji, `@mention`
 * members and `/command`s.
 *
 * Presentational; the engines live in `EmojiAutocomplete` / `MentionAutocomplete` and the
 * composer owns the caret. The menus render in the CDK overlay container, anchored to the
 * composer's input row and matched to its width.
 *
 * Neither the emoji nor the mention menu closes itself on an outside press, deliberately:
 * `emojiOpen` and `mentionOpen` are `computed(() => matches().length > 0)` upstream, so there
 * is no flag for a self-close to write to, and a menu that vanished on its own would leave the
 * composer answering Enter for it and pointing `aria-activedescendant` at an invisible row.
 * Clicking away closes them by blurring the textarea, which clears the query.
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
  imports: [
    AvatarComponent,
    TrnAnchoredOverlayDirective,
    TrnOverlaySurfaceDirective,
  ],
  templateUrl: './composer-suggestions.component.html',
  styleUrl: './composer-suggestions.component.scss',
})
export class ComposerSuggestionsComponent {
  /**
   * The composer's input row, which the menus sit above and match the width of. Optional: a
   * menu with nowhere to anchor renders nothing, which is what the overlay does on its own.
   */
  readonly anchor = input<HTMLElement | undefined>(undefined);

  /** Whether the emoji menu is shown (a query yielded at least one match). */
  readonly emojiOpen = input(false);
  /** Ranked emoji suggestions for the current query. */
  readonly emojiMatches = input<readonly TrnEmojiSuggestion[]>([]);
  /** Index of the highlighted emoji suggestion. */
  readonly emojiActiveIndex = input(0);
  /** Whether the mention menu is shown (a query yielded at least one member). */
  readonly mentionOpen = input(false);
  /** Members matching the current query. */
  readonly mentionMatches = input<readonly MentionMember[]>([]);
  /** Index of the highlighted member suggestion. */
  readonly mentionActiveIndex = input(0);
  /** Whether the `/command` menu is shown. */
  readonly slashOpen = input(false);
  /** Commands matching the current `/fragment`. */
  readonly slashMatches = input<readonly SlashCommand[]>([]);
  /** Index of the highlighted command. */
  readonly slashActiveIndex = input(0);

  /** The pointer moved onto a command — highlight it. */
  readonly slashHighlight = output<number>();
  /** A command was chosen. */
  readonly slashAccept = output<number>();

  /** The pointer moved onto an emoji suggestion — highlight it. */
  readonly emojiHighlight = output<number>();
  /** An emoji suggestion was clicked. */
  readonly emojiAccept = output<number>();
  /** The pointer moved onto a member suggestion — highlight it. */
  readonly mentionHighlight = output<number>();
  /** A member suggestion was clicked. */
  readonly mentionAccept = output<number>();
}
