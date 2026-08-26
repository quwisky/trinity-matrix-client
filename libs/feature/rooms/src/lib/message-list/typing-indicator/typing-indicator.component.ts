import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
} from '@angular/core';
import { formatTypingNotice } from '@trinity/util/matrix';

/**
 * The "X is typing" line above the composer, with its three animated dots.
 *
 * One component because three places render it — the simple list, the windowed list and the
 * thread panel — and a typing row that reads differently in one of them is a bug nobody
 * would look for. It was copy-pasted between the two lists before the thread panel wanted
 * it too, which is where copy-paste stopped being defensible.
 *
 * Presentational: it takes the names and formats them, and knows nothing about the client,
 * the room, or who the local user is. The caller excludes the local user (see
 * `TimelineService.refreshTyping`).
 */
@Component({
  selector: 'trn-typing-indicator',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './typing-indicator.component.html',
  styleUrl: './typing-indicator.component.scss',
})
export class TypingIndicatorComponent {
  /** Display names of the members currently typing, excluding the local user. */
  readonly names = input<readonly string[]>([]);
  /**
   * Whether this instance owns the announcement.
   *
   * False in the thread panel: `m.typing` is room-scoped, so the thread shows the same
   * typists as the list behind it, and two persistent live regions over one fact announce
   * it twice.
   */
  readonly announce = input(true);

  /** "X is typing" for the row, or `''` when nobody is — which hides it. */
  readonly typingLabel = computed(() => formatTypingNotice(this.names()));
}
