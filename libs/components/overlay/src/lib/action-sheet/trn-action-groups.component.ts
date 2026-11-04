import {
  ChangeDetectionStrategy,
  Component,
  computed,
  input,
  output,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import { TrnIconComponent } from '@trinity/components/foundations';
import type {
  ActionSheetButton,
  ActionSheetData,
  ActionSheetReaction,
} from './trn-action-list.component';

/**
 * A phone sheet's body: the quick reactions as square tiles, then the rows in rounded cards,
 * one per group. {@link TrnActionListComponent} owns closing and running the handlers.
 */
@Component({
  selector: 'trn-action-groups',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnIconComponent],
  templateUrl: './trn-action-groups.component.html',
  host: {
    class: 'flex min-h-0 flex-1 flex-col',
    // Without a header the first tile or card would touch the grab handle.
    '[class.pt-2]': '!data().header',
  },
})
export class TrnActionGroupsComponent {
  /** A new card at each separator or card break, and for Cancel. */
  protected readonly groups = computed(() => {
    const groups: ActionSheetButton[][] = [];
    for (const button of this.rows()) {
      if (button.reactionTile) continue;
      const last = groups.at(-1);
      if (
        last &&
        !button.separatorBefore &&
        !button.cardBefore &&
        button.role !== 'cancel'
      ) {
        last.push(button);
      } else {
        groups.push([button]);
      }
    }
    return groups.map((rows) => ({
      rows,
      icons: rows.some((row) => row.icon),
    }));
  });
  protected readonly tiles = computed(() =>
    this.rows().filter((button) => button.reactionTile),
  );

  readonly data = input.required<ActionSheetData>();
  readonly rows = input.required<readonly ActionSheetButton[]>();
  readonly picked = output<ActionSheetButton>();
  readonly reacted = output<ActionSheetReaction>();
}
