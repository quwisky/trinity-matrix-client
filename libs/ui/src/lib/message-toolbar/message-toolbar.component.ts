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
  HlmDropdownMenu,
  HlmDropdownMenuItem,
  HlmDropdownMenuSeparator,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';
import {
  lucideCopy,
  lucideEllipsis,
  lucideMessagesSquare,
  lucidePencil,
  lucidePin,
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
 * Discord-style floating action toolbar revealed when hovering a message. React,
 * Reply and Reply-in-thread stay inline; the remaining actions (Pin/Unpin, Copy,
 * Edit, Delete) collapse into an overflow "⋯" dropdown menu. Pin is offered only
 * when the user may edit the room's pinned events; Edit and Delete are gated to the
 * user's own messages.
 */
@Component({
  selector: 'trn-message-toolbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    NgIcon,
    HlmTooltip,
    HlmDropdownMenu,
    HlmDropdownMenuItem,
    HlmDropdownMenuSeparator,
    HlmDropdownMenuTrigger,
  ],
  templateUrl: './message-toolbar.component.html',
  styleUrl: './message-toolbar.component.scss',
  viewProviders: [
    provideIcons({
      lucideSmile,
      lucideReply,
      lucideMessagesSquare,
      lucideEllipsis,
      lucidePin,
      lucideCopy,
      lucidePencil,
      lucideTrash2,
    }),
  ],
})
export class MessageToolbarComponent {
  readonly canEdit = input(false);
  readonly canDelete = input(false);
  /** Whether the current user may pin/unpin this message (room permission). */
  readonly canPin = input(false);
  /** Whether this message is currently pinned (drives the Pin/Unpin label). */
  readonly pinned = input(false);
  /** Whether to offer "Reply in thread" — false inside a thread (no nested threads). */
  readonly canThread = input(true);
  readonly react = output<string>();
  readonly replyMessage = output<void>();
  readonly openThread = output<void>();
  readonly togglePin = output<void>();
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
