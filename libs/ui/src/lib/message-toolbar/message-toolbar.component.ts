import {
  ChangeDetectionStrategy,
  Component,
  input,
  output,
  signal,
} from '@angular/core';
import { TrnTooltip } from '@trinity/components/tooltip';
import { TrnIconComponent } from '@trinity/components/icon';
import {
  HlmDropdownMenu,
  HlmDropdownMenuItem,
  HlmDropdownMenuSeparator,
  HlmDropdownMenuTrigger,
} from '@trinity/helm/dropdown-menu';

/** Which optional actions the toolbar offers for a given message. */
export interface MessageToolbarCaps {
  canEdit: boolean;
  canDelete: boolean;
  /** Whether the current user may pin/unpin this message (room permission). */
  canPin: boolean;
  /** Whether this message is currently pinned (drives the Pin/Unpin label). */
  pinned: boolean;
  /** Whether to offer "Reply in thread" — false inside a thread. */
  canThread: boolean;
  /** Whether this message has text worth pulling into the composer as a quote. */
  canQuote: boolean;
}

/** A single action a user triggers from the message toolbar. */
export type MessageAction =
  | { type: 'react'; key: string }
  /** Open the full emoji picker to react with any emoji (beyond the quick set). */
  | { type: 'react-more' }
  | { type: 'reply' }
  /** Pull this message's text into the composer as a `>` block to write around. Distinct
   *  from `reply`, which points at the event without bringing its words. */
  | { type: 'quote' }
  | { type: 'edit' }
  | { type: 'delete' }
  | { type: 'copy' }
  | { type: 'copy-link' }
  | { type: 'view-source' }
  | { type: 'forward' }
  | { type: 'report' }
  | { type: 'pin' }
  | { type: 'thread' };

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
    TrnIconComponent,
    TrnTooltip,
    HlmDropdownMenu,
    HlmDropdownMenuItem,
    HlmDropdownMenuSeparator,
    HlmDropdownMenuTrigger,
  ],
  templateUrl: './message-toolbar.component.html',
  styleUrl: './message-toolbar.component.scss',
})
export class MessageToolbarComponent {
  readonly caps = input<MessageToolbarCaps>({
    canEdit: false,
    canDelete: false,
    canPin: false,
    pinned: false,
    canThread: true,
    canQuote: false,
  });
  readonly action = output<MessageAction>();

  readonly quickEmojis = QUICK_EMOJIS;
  readonly pickerOpen = signal(false);
  /** Unique id linking the reaction toggle to its picker via aria-controls. */
  readonly pickerId = `trn-reaction-picker-${nextPickerId++}`;

  pick(emoji: string): void {
    this.action.emit({ type: 'react', key: emoji });
    this.pickerOpen.set(false);
  }

  /** Escalate from the quick set to the full emoji picker (handled by the host). */
  pickMore(): void {
    this.action.emit({ type: 'react-more' });
    this.pickerOpen.set(false);
  }
}
