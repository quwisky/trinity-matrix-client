import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  AvatarComponent,
  EmptyStateComponent,
  TrnTooltip,
} from '@trinity/components/generic-content';
import {
  matchesRoomFilter,
  SpacesService,
  type SpaceChildRoom,
} from '@trinity/data-access/room-library';
import { type ExactSpaceSelection } from '../../shared/exact-selection';

/**
 * The active space's not-yet-joined rooms ("More rooms") and sub-spaces ("Spaces"), with
 * the loading and failure lines that stand in for them while the hierarchy loads.
 *
 * Reads `SpacesService` itself, as the sidebar did. The host is `display: contents` so the
 * rows stay direct children of the sidebar's scroller.
 */
@Component({
  selector: 'trn-space-children-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './space-children-list.component.html',
  styleUrl: './space-children-list.component.scss',
  imports: [TrnButton, TrnTooltip, EmptyStateComponent, AvatarComponent],
})
export class SpaceChildrenListComponent {
  protected readonly spaces = inject(SpacesService);

  // The filter box narrows everything under it, so these two lists follow it too.
  protected readonly joinableRooms = computed(() =>
    this.spaces
      .notJoinedRooms()
      .filter((child) => matchesRoomFilter(child.name, this.filter())),
  );
  protected readonly childSpaces = computed(() =>
    this.spaces
      .childSpaces()
      .filter((child) => matchesRoomFilter(child.name, this.filter())),
  );

  /** The sidebar's already-normalised filter query (`normalizeRoomFilter`). */
  readonly filter = input('');

  /** Rows shown after filtering — the sidebar's live region announces this. */
  readonly matchCount = computed(
    () => this.joinableRooms().length + this.childSpaces().length,
  );

  /** Join a not-yet-joined child room or sub-space. */
  readonly join = output<SpaceChildRoom>();
  /** Open a joined sub-space. */
  readonly open = output<ExactSpaceSelection>();
}
