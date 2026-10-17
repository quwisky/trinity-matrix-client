import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The two rules that break up a timeline: a day boundary and the unread mark.
 *
 * Deliberately NOT inside `trn-message-row`: a divider sits BETWEEN rows, and folding it into the
 * row would make the row's measured height depend on whether a day changed above it, which the
 * windowed list's prefix sums read.
 */
@Component({
  selector: 'trn-timeline-divider',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './timeline-divider.component.html',
  styleUrl: './timeline-divider.component.scss',
})
export class TimelineDividerComponent {
  /**
   * `day` carries the date it announces; `unread` announces itself. A discriminated pair, not two
   * booleans: a row can need both, so the lists render two elements rather than one with a mode.
   */
  readonly kind = input.required<'day' | 'unread'>();
  /** The day label. Ignored for `unread`. */
  readonly label = input<string>('');
  /** Continue the avatar column across an unread marker inside a sender group. */
  readonly threadConnected = input(false);
}
