import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TrnTooltip } from '@trinity/components/tooltip';
import { type ReactionView } from '@trinity/util/matrix';
import { TrnIconComponent } from '@trinity/components/icon';

/** A reaction pill plus the "reacted by …" line shown on hover/focus. */
interface ReactionPill extends ReactionView {
  hint: string;
}

/** Join names into a phrase: "A", "A and B", "A, B and C". */
function listPhrase(items: string[]): string {
  if (items.length < 2) {
    return items[0] ?? '';
  }
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/**
 * "👍 reacted by You, Alice and 4 others" — the projection names only the first few
 * reactors ({@link ReactionView.reactors}), so everyone past that is summarised by count.
 */
function reactorsHint(reaction: ReactionView): string {
  const names = [...reaction.reactors];
  const others = Math.max(0, reaction.count - names.length);
  if (others > 0) {
    names.push(`${others} other${others === 1 ? '' : 's'}`);
  }
  return `${reaction.key} reacted by ${listPhrase(names)}`;
}

/**
 * Reaction pills under a message. Clicking one toggles the user's own reaction,
 * hovering (or focusing) it names the first few reactors, and the trailing chip asks
 * for the full list.
 */
@Component({
  selector: 'trn-message-reactions',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnIconComponent, TrnTooltip],
  templateUrl: './message-reactions.component.html',
  styleUrl: './message-reactions.component.scss',
})
export class MessageReactionsComponent {
  readonly reactions = input<ReactionView[]>([]);
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
