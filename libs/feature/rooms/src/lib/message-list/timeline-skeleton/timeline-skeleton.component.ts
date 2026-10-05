import { ChangeDetectionStrategy, Component } from '@angular/core';

/** Line widths (%) per placeholder group: a short, a one-line and a long message. */
const GROUPS: readonly (readonly number[])[] = [[72, 48], [86], [64, 90, 40]];

/** Grouped-message placeholders shown only during a real timeline loading interval (#545). */
@Component({
  selector: 'trn-timeline-skeleton',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './timeline-skeleton.component.html',
  styleUrl: './timeline-skeleton.component.scss',
  host: { 'data-testid': 'timeline-skeleton' },
})
export class TimelineSkeletonComponent {
  protected readonly groups = GROUPS;
}
