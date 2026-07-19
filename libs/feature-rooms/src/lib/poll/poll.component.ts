import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { type PollView } from '@trinity/util-matrix';
import { HlmButton } from '@trinity/helm/button';

/**
 * Renders a poll (MSC3381): the question, each answer with its live tally and share
 * bar, the total vote count, and — for the poll's creator, while it's open — an
 * "End poll" control. Clicking an answer casts (or changes) the local user's vote.
 * Presentational: it emits `vote`/`end` and leaves the sending to the host.
 */
@Component({
  selector: 'trn-poll',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './poll.component.html',
  styleUrl: './poll.component.scss',
  imports: [HlmButton],
})
export class PollComponent {
  readonly poll = input.required<PollView>();
  /** Whether to offer the "End poll" control (the creator, while the poll is open). */
  readonly canEnd = input(false);

  /** The chosen answer id to cast a vote for. */
  readonly vote = output<string>();
  /** Close the poll. */
  readonly end = output<void>();

  /** Per-answer share of the total, for the bar width. */
  readonly percentages = computed<Record<string, number>>(() => {
    const total = this.poll().totalVotes;
    const out: Record<string, number> = {};
    for (const option of this.poll().options) {
      out[option.id] = total > 0 ? Math.round((option.votes / total) * 100) : 0;
    }
    return out;
  });

  onVote(answerId: string): void {
    if (!this.poll().ended) {
      this.vote.emit(answerId);
    }
  }
}
