import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
} from '@angular/core';
import { PickerComponent } from '@ctrl/ngx-emoji-mart';
import { type EmojiEvent } from '@ctrl/ngx-emoji-mart/ngx-emoji';
import { DialogRef } from '@trinity/kit/overlay';
import { ThemeService } from '@trinity/platform-native';

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
  imports: [PickerComponent],
  templateUrl: './reaction-picker.component.html',
  styleUrl: './reaction-picker.component.scss',
})
export class ReactionPickerComponent {
  private readonly dialogRef =
    inject<DialogRef<string | null, ReactionPickerComponent>>(DialogRef);
  private readonly theme = inject(ThemeService);

  /** Match the picker's chrome to the app's active theme. */
  readonly isDarkMode = computed(() => this.theme.resolved() === 'dark');

  /** A reaction was chosen — close with its native character. */
  onSelect(event: EmojiEvent): void {
    this.dialogRef.close(event.emoji.native ?? null);
  }
}
