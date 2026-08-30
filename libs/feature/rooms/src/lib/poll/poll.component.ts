import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { type PollView } from '@trinity/util/matrix';
import { TrnButton } from '@trinity/components/controls';

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
  imports: [TrnButton],
})
export class PollComponent {
  readonly poll = input.required<PollView>();
  /** Whether to offer the "End poll" control (the creator, while the poll is open). */
  readonly canEnd = input(false);
  /**
   * Whether the poll's own event is still being sent (a local echo). A vote and an end
   * both *relate* to the poll's event id, and until the remote echo lands that id is the
   * SDK's `~roomId:txnId` placeholder — matrix-js-sdk throws outright on a relation to a
   * pending event — so both controls stay inert for those few hundred milliseconds.
   */
  readonly pending = input(false);

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
    if (!this.poll().ended && !this.pending()) {
      this.vote.emit(answerId);
    }
  }
}
