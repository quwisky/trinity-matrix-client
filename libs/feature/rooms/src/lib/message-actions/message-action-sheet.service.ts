import { Injectable, inject } from '@angular/core';
import {
  TrnActionSheetService,
  TrnDialogRef,
  type ActionSheetButton,
} from '@trinity/components/overlay';
import {
  type MessageRow,
  type MessageRowAction,
  type MessageRowCaps,
} from '../message-row/message-row.component';

/**
 * The one-tap reactions the sheet offers, mirroring the hover toolbar's quick set.
 *
 * Restated rather than imported from `@trinity/components/message-toolbar`: that constant is
 * private to the component, and the two surfaces are free to diverge — a phone strip has room
 * for six, a hover row could grow.
 */
const QUICK_SHEET_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢'] as const;

/**
 * A message's actions as a bottom sheet, for the long press on a phone or tablet.
 *
 * ## Why a service, and not the component that was pressed
 *
 * A row is destroyed by any of the things that routinely happen to a message — a redaction,
 * an edit, the local-echo id swap when your own send lands, or simply scrolling out of the
 * virtual window, which happens behind the sheet's own backdrop where the reader cannot see
 * it. An `output()` on a destroyed component is a SILENT no-op, so a sheet holding the row's
 * handlers would be a menu where every row is still tappable and nothing happens.
 *
 * So the caller hands over a row SNAPSHOT and a dispatch function of its own, and neither
 * depends on the pressed component surviving.
 *
 * ## Why a service, and not a method on the list
 *
 * It started as one, and that was wrong: `trn-message-row` has THREE consumers, not two. The
 * two message lists extend `MessageListBase`, but {@link ThreadViewComponent} does not — it
 * carries its own `onRowAction`. A long press on a thread reply consequently emitted into
 * nothing and every action on it was unreachable by touch, with the Android `contextmenu`
 * fallback removed as well. Shared here so a fourth consumer inherits the behaviour instead
 * of having to remember it.
 *
 * One sheet at a time: opening closes whatever was open. Callers close it on their own
 * destroy, and when the room changes.
 */
@Injectable({ providedIn: 'root' })
export class MessageActionSheetService {
  private readonly sheet = inject(TrnActionSheetService);
  private ref: TrnDialogRef<void> | null = null;

  /**
   * Offer `row`'s actions, dispatching the chosen one through `dispatch`.
   *
   * `caps` decides what is on offer, exactly as it decides what the hover toolbar shows —
   * building the list from the overflow menu instead would silently drop Reply, Reply in
   * thread and the reactions, which are the bar's own buttons.
   */
  open(
    row: MessageRow,
    caps: MessageRowCaps,
    dispatch: (action: MessageRowAction) => void,
  ): void {
    const act = (type: MessageRowAction['type']) => () =>
      dispatch({ type } as MessageRowAction);

    const buttons: ActionSheetButton[] = [
      {
        text: 'Reply',
        icon: 'reply',
        testId: 'sheet-reply',
        handler: act('reply'),
      },
    ];
    if (caps.canThread) {
      buttons.push({
        text: 'Reply in thread',
        icon: 'messages-square',
        testId: 'sheet-thread',
        handler: act('thread'),
      });
    }
    buttons.push({
      // The escape hatch from the six-emoji strip. Without it an arbitrary reaction is
      // unreachable on a phone: `react-more` is raised nowhere else, and the hover bar that
      // used to raise it is never revealed on a mobile OS.
      text: 'More reactions…',
      icon: 'smile',
      testId: 'sheet-react-more',
      handler: act('react-more'),
    });
    if (caps.canQuote) {
      buttons.push({
        text: 'Quote',
        icon: 'quote',
        testId: 'sheet-quote',
        handler: act('quote'),
      });
    }
    if (caps.canPin) {
      buttons.push({
        text: caps.pinned ? 'Unpin message' : 'Pin message',
        icon: 'pin',
        testId: 'sheet-pin',
        handler: act('pin'),
      });
    }
    buttons.push(
      {
        text: 'Copy text',
        icon: 'copy',
        testId: 'sheet-copy',
        handler: act('copy'),
      },
      {
        text: 'Copy link',
        icon: 'link',
        testId: 'sheet-copy-link',
        handler: act('copy-link'),
      },
      {
        text: 'Forward',
        icon: 'forward',
        testId: 'sheet-forward',
        handler: act('forward'),
      },
      {
        text: 'View source',
        icon: 'code',
        testId: 'sheet-view-source',
        handler: act('view-source'),
      },
      {
        text: 'Report message',
        icon: 'flag',
        testId: 'sheet-report',
        handler: act('report'),
      },
    );
    if (caps.editable) {
      buttons.push({
        text: 'Edit message',
        icon: 'pencil',
        testId: 'sheet-edit',
        handler: act('edit'),
      });
    }
    if (caps.deletable) {
      buttons.push({
        text: 'Delete message',
        icon: 'trash-2',
        role: 'destructive',
        separatorBefore: true,
        testId: 'sheet-delete',
        handler: act('delete'),
      });
    }
    buttons.push({ text: 'Cancel', role: 'cancel' });

    this.close();
    this.ref = this.sheet.open(
      {
        buttons,
        reactions: QUICK_SHEET_REACTIONS.map((key) => ({
          key,
          handler: () => dispatch({ type: 'react', key }),
        })),
      },
      'Message actions',
    );
  }

  /** Dismiss the sheet, if one is open. */
  close(): void {
    this.ref?.close();
    this.ref = null;
  }
}
