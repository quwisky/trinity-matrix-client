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
 * One component because the message list and the thread panel both render it. Presentational:
 * the caller excludes the local user (see `TimelineService.refreshTyping`).
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
   * Whether this instance owns the announcement. False in a thread panel beside the room:
   * `m.typing` is room-scoped, so two persistent live regions over one fact would announce it
   * twice. A thread page over an inert room announces, as the room's region is then silent.
   */
  readonly announce = input(true);

  /** "X is typing" for the row, or `''` when nobody is (which hides it). */
  readonly typingLabel = computed(() => formatTypingNotice(this.names()));
}
