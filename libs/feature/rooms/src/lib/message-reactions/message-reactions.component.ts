import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TrnIconButton } from '@trinity/components/controls';
import { TrnTooltip } from '@trinity/components/generic-content';
import { type ReactionView } from '@trinity/data-access/timeline';
import { TrnIconComponent } from '@trinity/components/foundations';

/** A reaction pill plus the "reacted by …" line shown on hover/focus. */
interface ReactionPill extends ReactionView {
  hint: string;
}

/** Join names into a phrase: "A", "A and B", "A, B and C". */
function listPhrase(items: readonly string[]): string {
  if (items.length < 2) {
    return items[0] ?? '';
  }
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The most of a key the hint repeats; the pill itself is capped by CSS. */
const HINT_KEY_MAX = 64;

/** `key` cut to {@link HINT_KEY_MAX} code points with an ellipsis, so no emoji is split. */
function hintKey(key: string): string {
  const chars = [...key];
  return chars.length > HINT_KEY_MAX
    ? `${chars.slice(0, HINT_KEY_MAX - 1).join('')}…`
    : key;
}

/**
 * "👍 7, reacted by You, Alice and 4 others" — the projection names only the first few
 * reactors ({@link ReactionView.reactors}), so everyone past that is summarised by count.
 * It is both the tooltip and the accessible name, and it starts with what the pill shows,
 * its key and count (WCAG 2.5.3 label in name), so a speech-input user can say it.
 */
function reactorsHint(reaction: ReactionView): string {
  const names = [...reaction.reactors];
  const others = Math.max(0, reaction.count - names.length);
  if (others > 0) {
    names.push(`${others} other${others === 1 ? '' : 's'}`);
  }
  return `${hintKey(reaction.key)} ${reaction.count}, reacted by ${listPhrase(names)}`;
}

/**
 * Reaction pills under a message. Clicking one toggles the user's own reaction,
 * hovering (or focusing) it names the first few reactors, and the trailing chip asks
 * for the full list.
 */
@Component({
  selector: 'trn-message-reactions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconButton, TrnIconComponent, TrnTooltip],
  templateUrl: './message-reactions.component.html',
  styleUrl: './message-reactions.component.scss',
})
export class MessageReactionsComponent {
  readonly reactions = input<readonly ReactionView[]>([]);
  readonly toggleReaction = output<string>();
  /** Show everyone who reacted (the trailing chip). */
  readonly showReactors = output<void>();

  /** The pills with their hover hint precomputed, so the template stays declarative. */
  readonly pills = computed<ReactionPill[]>(() =>
    this.reactions().map((reaction) => ({
      ...reaction,
      hint: reactorsHint(reaction),
    })),
  );
}
