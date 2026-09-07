import { ChangeDetectionStrategy, Component, input } from '@angular/core';

/**
 * The two rules that break up a timeline: a day boundary and the unread mark.
 *
 * One component because both lists rendered them character-for-character identically, and a
 * divider that reads differently in the windowed list than in the simple one is a bug nobody
 * would look for. They share a stylesheet already (`_message-list-shared.scss`); this gives
 * them a shared template too.
 *
 * Deliberately NOT inside `trn-message-row`: a divider sits BETWEEN rows and belongs to
 * neither, and folding it into the row would make the row's measured height depend on
 * whether a day happened to change above it — which the windowed list's prefix sums read.
 */
@Component({
  selector: 'trn-timeline-divider',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './timeline-divider.component.html',
  styleUrl: './timeline-divider.component.scss',
})
export class TimelineDividerComponent {
  /**
   * `day` carries the date it announces; `unread` announces itself.
   *
   * A discriminated pair rather than two booleans: the two are mutually exclusive in the
   * markup, and a row can legitimately need both — which is why the lists render two
   * elements rather than one with a mode.
   */
  readonly kind = input.required<'day' | 'unread'>();
  /** The day label. Ignored for `unread`, which has nothing to vary. */
  readonly label = input<string>('');
  /** Continue the avatar column across an unread marker inside a sender group. */
  readonly threadConnected = input(false);
}
