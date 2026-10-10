import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  type Signal,
} from '@angular/core';
import { TrnButton } from '@trinity/components/controls';
import {
  TrnDialogRef,
  TrnDialogShellComponent,
} from '@trinity/components/overlay';
import { type ExactRoomSelection } from '../../shared/exact-selection';
import {
  moreUnreadChatsLabel,
  type RailUnreadChat,
} from '../rail-unread-chats';
import { RailUnreadOverflowRowComponent } from '../rail-unread-overflow-row/rail-unread-overflow-row.component';

/** What the reader picked in the "+N" sheet. */
export type RailOverflowChoice =
  | { readonly kind: 'chat'; readonly selection: ExactRoomSelection }
  | { readonly kind: 'recent' };

/**
 * The phone form of the list "+N" opens: the same rows as the desktop menu, in a bottom
 * sheet. It closes with the reader's choice; the rail acts on it.
 */
@Component({
  selector: 'trn-rail-unread-overflow-sheet',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnButton, TrnDialogShellComponent, RailUnreadOverflowRowComponent],
  templateUrl: './rail-unread-overflow-sheet.component.html',
})
export class RailUnreadOverflowSheetComponent {
  private readonly ref = inject<TrnDialogRef<RailOverflowChoice>>(TrnDialogRef);

  /** The rail's live overflow list, so the sheet follows new messages while it is open. */
  readonly chats = input.required<Signal<readonly RailUnreadChat[]>>();

  protected readonly title = computed(() =>
    moreUnreadChatsLabel(this.chats()().length),
  );

  protected choose(choice: RailOverflowChoice): void {
    this.ref.close(choice);
  }
}
