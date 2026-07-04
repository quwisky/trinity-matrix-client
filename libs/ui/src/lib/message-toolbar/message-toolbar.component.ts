import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  signal,
} from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { HlmTooltip } from '@trinity/helm/tooltip';
import {
  lucideCopy,
  lucideMessagesSquare,
  lucidePencil,
  lucideReply,
  lucideSmile,
  lucideTrash2,
} from '@ng-icons/lucide';

/** A small set of one-tap reactions offered by the picker. */
const QUICK_EMOJIS = ['👍', '❤️', '😂', '🎉', '😮', '😢'];

/** Per-instance id source so each row's reaction toggle → picker association
 * (aria-controls) is unique — the toolbar is rendered once per message row. */
let nextPickerId = 0;

/**
 * Discord-style floating action toolbar revealed when hovering a message.
 * React is always available (a quick-emoji picker); copy too; edit and delete
 * are gated to the user's own messages.
 */
@Component({
  selector: 'trn-message-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgIcon, HlmTooltip],
  templateUrl: './message-toolbar.component.html',
  styleUrl: './message-toolbar.component.scss',
  viewProviders: [
    provideIcons({
      lucideSmile,
      lucideReply,
      lucideMessagesSquare,
      lucideCopy,
      lucidePencil,
      lucideTrash2,
    }),
  ],
})
export class MessageToolbarComponent {
  readonly canEdit = input(false);
  readonly canDelete = input(false);
  /** Whether to offer "Reply in thread" — false inside a thread (no nested threads). */
  readonly canThread = input(true);
  readonly react = output<string>();
  readonly replyMessage = output<void>();
  readonly openThread = output<void>();
  readonly copyMessage = output<void>();
  readonly editMessage = output<void>();
  readonly deleteMessage = output<void>();

  readonly quickEmojis = QUICK_EMOJIS;
  readonly pickerOpen = signal(false);
  /** Unique id linking the reaction toggle to its picker via aria-controls. */
  readonly pickerId = `trn-reaction-picker-${nextPickerId++}`;

  pick(emoji: string): void {
    this.react.emit(emoji);
    this.pickerOpen.set(false);
  }
}
