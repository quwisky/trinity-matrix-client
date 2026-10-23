import { Injectable, inject } from '@angular/core';
import { RecentEmojiService } from '@trinity/data-access/media';
import {
  TrnSurfaceService,
  type TrnActionSheetRef,
  type ActionSheetButton,
} from '@trinity/components/overlay';
import {
  type MessageLongPressContext,
  type MessageRowAction,
  type MessageRowCaps,
} from '../message-row/message-row.component';
import { MessageSheetViewportSession } from './message-sheet-viewport-session';

/**
 * The one-tap reactions the sheet offers, mirroring the hover toolbar's quick set. Restated
 * because the toolbar's constant is private and the two surfaces may diverge.
 */
const QUICK_SHEET_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢'] as const;

/**
 * The action variants carrying nothing but their `type`.
 *
 * `react` needs a `key` and `jump` needs an `id`; building either from a bare type string
 * yields a half-formed action that a cast would let compile. Excluding them makes that a
 * type error here.
 *
 * Two limits before extending `MessageRowAction`:
 *
 *  - `dispatch({ type })` with a union-typed discriminant typechecks through TypeScript's
 *    discriminant cross-product expansion, which is CAPPED AT 25 combinations. The union has
 *    16 payload-free members; the 26th turns this line into a baffling "not assignable to
 *    type '{ type: … }'" error with no mention of the cap.
 *  - Exclusion is by REQUIRED property name. A future `{ type: 'react'; key?: string }` would
 *    survive `Exclude` and silently reopen the gap this closes.
 */
type PayloadFreeAction = Exclude<
  MessageRowAction,
  { key: string } | { id: string }
>;

/**
 * A message's actions for the long press on a phone or tablet: a bottom sheet, or a menu beside
 * the row where one fits.
 *
 * ## Why a service, and not the component that was pressed
 *
 * A row is destroyed by a redaction, an edit, the local-echo id swap when your own send
 * lands, or scrolling out of the list's window behind the sheet's backdrop. An `output()`
 * on a destroyed component is a SILENT no-op, so a sheet holding the row's handlers would
 * be a menu where nothing happens. The caller therefore hands over a `dispatch` function
 * closing over the pressed row; nothing here depends on the component surviving
 * (`message-list-sheet.spec.ts` removes the row before picking an action).
 *
 * ## Why a service, and not a method on the list
 *
 * `trn-message-row` has two consumers: the message list (`MessageListBase`) and
 * {@link ThreadViewComponent}, which carries its own `onRowAction`. A method on the list
 * left thread replies unreachable by touch. Shared here so a third consumer inherits it.
 *
 * ## Why `open` and `close` take an owner
 *
 * One sheet at a time, in a `root` singleton with two consumers that outlive each other in
 * either order. Without a token, a thread panel closing would shut the timeline's sheet
 * behind it. With one, a consumer can only dismiss the sheet it opened, so both can call
 * it unconditionally from teardown, which prevents an orphaned sheet: the overlay lives
 * outside the router outlet and survives the route change that destroys its opener.
 */
@Injectable({ providedIn: 'root' })
export class MessageActionSheetService {
  private readonly surfaces = inject(TrnSurfaceService);
  private readonly recentEmoji = inject(RecentEmojiService);
  private ref: TrnActionSheetRef | null = null;
  private owner: object | null = null;
  private viewport: MessageSheetViewportSession | null = null;

  /**
   * Offer the pressed row's actions, dispatching the chosen one through `dispatch`.
   *
   * `caps` decides what is on offer, as for the hover toolbar; building the list from the
   * overflow menu would drop Reply, Reply in thread and the reactions, which are the bar's
   * own buttons. `owner` is the consumer opening it, and the only one that may close it.
   */
  open(
    owner: object,
    caps: MessageRowCaps,
    dispatch: (action: MessageRowAction) => void,
    context?: MessageLongPressContext,
  ): void {
    let viewport: MessageSheetViewportSession | null = null;
    const run = (action: MessageRowAction) => {
      // TrnActionListComponent closes before invoking a handler. Whether `closed` emits
      // synchronously or on the next turn, this captured session restores before the action
      // edits, redacts, or replaces the anchor.
      viewport?.release();
      if (this.viewport === viewport) {
        this.viewport = null;
      }
      dispatch(action);
    };
    const act = (type: PayloadFreeAction['type']) => () => run({ type });

    const buttons: ActionSheetButton[] = [];
    if (caps.canRespond) {
      buttons.push({
        text: 'Reply',
        icon: 'reply',
        testId: 'sheet-reply',
        handler: act('reply'),
      });
    }
    if (caps.canThread) {
      buttons.push({
        text: 'Reply in thread',
        icon: 'messages-square',
        testId: 'sheet-thread',
        handler: act('thread'),
      });
    }
    if (caps.canRespond) {
      buttons.push({
        // The escape hatch from the six-emoji strip: `react-more` is raised nowhere else, and
        // the hover bar is never revealed on a mobile OS.
        text: 'More reactions…',
        icon: 'smile',
        testId: 'sheet-react-more',
        handler: act('react-more'),
      });
    }
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
      ...(caps.saveMedia
        ? [
            {
              text: `Save ${caps.saveMedia}`,
              icon: 'download' as const,
              testId: 'sheet-save-media',
              handler: act('save-media'),
            },
          ]
        : []),
      ...(caps.addToEmoji
        ? [
            {
              text: 'Add to my emoji',
              icon: 'smile' as const,
              testId: 'sheet-add-to-emoji',
              handler: act('add-to-emoji'),
            },
          ]
        : []),
      ...(caps.canForward
        ? [
            {
              text: 'Forward',
              icon: 'forward' as const,
              testId: 'sheet-forward',
              handler: act('forward'),
            },
          ]
        : []),
      {
        text: 'View source',
        icon: 'code',
        testId: 'sheet-view-source',
        handler: act('view-source'),
      },
      {
        text: 'Report',
        icon: 'flag',
        testId: 'sheet-report',
        handler: act('report'),
      },
    );
    if (caps.editable) {
      buttons.push({
        text: 'Edit',
        icon: 'pencil',
        testId: 'sheet-edit',
        handler: act('edit'),
      });
    }
    if (caps.deletable) {
      buttons.push({
        text: 'Delete',
        icon: 'trash-2',
        variant: 'danger',
        separatorBefore: true,
        testId: 'sheet-delete',
        handler: act('delete'),
      });
    }
    buttons.push({ text: 'Cancel', role: 'cancel' });

    this.dismiss();
    this.owner = owner;
    const ref = this.surfaces.openActions(
      {
        buttons,
        reactions: (caps.canRespond ? QUICK_SHEET_REACTIONS : []).map(
          (key) => ({
            key,
            handler: () => {
              this.recentEmoji.record(key);
              run({ type: 'react', key });
            },
          }),
        ),
      },
      { ariaLabel: 'Message actions', anchor: context?.anchor },
    );
    this.ref = ref;
    // Only a bottom sheet covers the timeline; a menu beside the row needs no clearance.
    if (context && ref.presentation === 'sheet') {
      viewport = new MessageSheetViewportSession(context, () => ref.surface);
      this.viewport = viewport;
      viewport.start();
    }

    // Let go once the sheet closes ITSELF (pick, backdrop tap, Escape); otherwise the dead
    // ref keeps the handlers, `dispatch` closure and so the row alive. Compared against the
    // captured local, not by identity: `open()` may have replaced it, and `TrnDialogRef`'s
    // identity carries no meaning.
    ref.closed.subscribe(() => {
      viewport?.release();
      if (this.ref === ref) {
        this.ref = null;
        this.owner = null;
        if (this.viewport === viewport) {
          this.viewport = null;
        }
      }
    });
  }

  /**
   * Dismiss the sheet, if `owner` is the consumer that opened it. A no-op otherwise: both
   * consumers call this from teardown and room change, and must not shut the other's sheet.
   */
  close(owner: object): void {
    if (this.owner === owner) {
      this.dismiss();
    }
  }

  /** Shut whatever is open, whoever opened it. Only `open` may do that. */
  private dismiss(): void {
    this.viewport?.release();
    this.viewport = null;
    this.ref?.close();
    this.ref = null;
    this.owner = null;
  }
}
