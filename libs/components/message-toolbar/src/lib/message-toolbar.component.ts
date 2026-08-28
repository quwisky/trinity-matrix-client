import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { CdkMenuTrigger } from '@angular/cdk/menu';
import { TrnIconButton } from '@trinity/components/button';
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
  host: {
    '(pointerenter)': 'placeToolbar()',
    '(focusin)': 'placeToolbar()',
    '[class.toolbar-host--picker-below]': 'pickerBelow()',
  },
  imports: [
    TrnIconButton,
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
  private readonly element = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly caps = input<MessageToolbarCaps>({
    canEdit: false,
    canDelete: false,
    canPin: false,
    pinned: false,
    canThread: true,
    canQuote: false,
  });
  readonly action = output<MessageAction>();

  /**
   * The overflow menu's trigger, so a consumer can open the SAME menu from somewhere else —
   * the message row opens it on right-click and long-press. Exposed rather than duplicating
   * the item list: a second menu would drift from this one the first time an action is added
   * to either, and the two would disagree about what a message can do.
   */
  // Queried as the CDK trigger rather than the Helm wrapper: `HlmDropdownMenuTrigger`
  // composes `CdkMenuTrigger` as a host directive and does not re-expose its `open()`.
  // Naming a vendor is allowed here — this tier is a wrapper layer, which is the point of
  // the `ui:public` / `ui:vendor-wrapper` split.
  private readonly moreTrigger = viewChild(CdkMenuTrigger);

  readonly quickEmojis = QUICK_EMOJIS;
  readonly pickerOpen = signal(false);
  readonly pickerBelow = signal(false);
  /** Unique id linking the reaction toggle to its picker via aria-controls. */
  readonly pickerId = `trn-reaction-picker-${nextPickerId++}`;

  /**
   * Open the overflow menu programmatically. Anchored to the "⋯" button rather than to the
   * pointer, which is deliberate: the menu keeps one predictable position however it was
   * summoned, and on touch it does not land under the finger that opened it.
   */
  openMoreMenu(): void {
    this.moreTrigger()?.open();
  }

  /**
   * Toggle quick reactions and choose the side with enough room in the nearest clipping
   * container. Grouping cannot answer this: virtualization can put a continuation at the
   * scrollport edge, while a group start can be the newest row at the bottom.
   */
  togglePicker(): void {
    if (this.pickerOpen()) {
      this.pickerOpen.set(false);
      return;
    }

    this.pickerOpen.set(true);
    requestAnimationFrame(() => this.placePicker());
  }

  /** Clamp the raised toolbar to the real upper clipping edge before it is shown. */
  placeToolbar(): void {
    const host = this.element.nativeElement;
    const row = host.parentElement;
    if (!row) return;

    const bounds = this.verticalBounds(host);
    const rowTop = row.getBoundingClientRect().top;
    const raisedShift = -(host.getBoundingClientRect().height / 2 + 4);
    const clampedShift = Math.max(raisedShift, bounds.top - rowTop);
    host.style.setProperty(
      '--message-toolbar-translate-y',
      `${clampedShift}px`,
    );
  }

  private placePicker(): void {
    const host = this.element.nativeElement;
    const picker = host.querySelector<HTMLElement>('.toolbar__picker');
    if (!picker) return;

    const bounds = this.verticalBounds(host);
    const hostBox = host.getBoundingClientRect();
    const pickerHeight = picker.getBoundingClientRect().height + 4;
    const spaceAbove = hostBox.top - bounds.top;
    const spaceBelow = bounds.bottom - hostBox.bottom;
    this.pickerBelow.set(spaceAbove < pickerHeight && spaceBelow > spaceAbove);
  }

  private verticalBounds(host: HTMLElement): { top: number; bottom: number } {
    for (
      let parent = host.parentElement;
      parent;
      parent = parent.parentElement
    ) {
      const overflow = getComputedStyle(parent).overflowY;
      if (/auto|scroll|hidden|clip/.test(overflow)) {
        const box = parent.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom };
      }
    }
    return { top: 0, bottom: window.innerHeight };
  }

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
