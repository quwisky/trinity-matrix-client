import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TrnDialogRef } from '@trinity/helm/overlay';
import {
  TrnEmojiPickerComponent,
  type TrnEmojiPick,
} from '@trinity/helm/emoji-picker';

/**
 * The full `emoji-mart` picker presented as a dialog for reacting with any emoji,
 * beyond the six quick reactions in the message toolbar. Opened by
 * {@link ReactionPickerService}; closes with the chosen native emoji, or `null` when
 * dismissed. Presentational: it reads the theme for the picker's chrome but sends no
 * reaction itself — the host does that with the returned emoji.
 */
@Component({
  selector: 'trn-reaction-picker',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TrnEmojiPickerComponent],
  templateUrl: './reaction-picker.component.html',
  styleUrl: './reaction-picker.component.scss',
})
export class ReactionPickerComponent {
  private readonly dialogRef =
    inject<TrnDialogRef<string | null>>(TrnDialogRef);
  /**
   * A reaction was chosen — close with its character.
   *
   * No `?? null` any more: the wrapper drops a pick that has no `native`, so anything
   * arriving here is insertable. Previously this closed the dialog with `null` on such an
   * event, which the caller could not distinguish from a dismissal.
   */
  onSelect(pick: TrnEmojiPick): void {
    this.dialogRef.close(pick.native);
  }
}
