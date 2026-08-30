import { Injectable, inject } from '@angular/core';
import {
  TrnActionSheetService,
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
 * The one-tap reactions the sheet offers, mirroring the hover toolbar's quick set.
 *
 * Restated rather than imported from the message toolbar: that constant is
 * private to the component, and the two surfaces are free to diverge — a phone strip has room
 * for six, a hover row could grow.
 */
const QUICK_SHEET_REACTIONS = ['👍', '❤️', '😂', '🎉', '😮', '😢'] as const;

/**
 * The action variants carrying nothing but their `type`.
 *
 * `react` needs a `key` and `jump` needs an `id`. Building either from a bare type string
 * yields a half-formed action — `{ type: 'react' }` with no key, dispatched into an
 * `onReact(row.id, undefined)` — and a cast to `MessageRowAction` makes that compile. This
 * excludes them instead, so the mistake is a type error at the call below rather than the
 * one hole in each consumer's `never` exhaustiveness guard.
 *
 * Two limits worth knowing before extending `MessageRowAction`:
 *
 *  - `dispatch({ type })` with a union-typed discriminant typechecks through TypeScript's
 *    discriminant cross-product expansion, which is CAPPED AT 25 combinations. The union has
 *    15 payload-free members, so there is headroom for ten more; the 26th turns this line
 *    into a baffling "not assignable to type '{ type: … }'" error with no mention of the cap.
 *  - Exclusion is by REQUIRED property name. A future `{ type: 'react'; key?: string }` would
 *    survive `Exclude` and silently reopen exactly the gap this closes.
 */
type PayloadFreeAction = Exclude<
  MessageRowAction,
  { key: string } | { id: string }
>;

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
 * So the caller hands over a `dispatch` function of its own, which closes over the row it
 * was pressed on. That closure is the snapshot — nothing here depends on the pressed
 * component surviving, and `message-list-sheet.spec.ts` proves it by removing the row from
 * the list before picking an action.
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
 * ## Why `open` and `close` take an owner
 *
 * One sheet at a time, in a `root` singleton with two consumers that outlive each other in
 * either order. Without a token, `close()` is "shut whatever is open", and a thread panel
 * closing shuts the timeline's sheet standing behind it. With one, a consumer can only
 * dismiss the sheet it opened, so both can call it unconditionally from their own teardown —
 * which is what makes an orphaned sheet impossible: the overlay lives outside the router
 * outlet and survives the route change that destroys its opener.
 */
@Injectable({ providedIn: 'root' })
export class MessageActionSheetService {
  private readonly sheet = inject(TrnActionSheetService);
  private ref: TrnActionSheetRef | null = null;
  private owner: object | null = null;
  private viewport: MessageSheetViewportSession | null = null;

  /**
   * Offer the pressed row's actions, dispatching the chosen one through `dispatch`.
   *
   * `caps` decides what is on offer, exactly as it decides what the hover toolbar shows —
   * building the list from the overflow menu instead would silently drop Reply, Reply in
   * thread and the reactions, which are the bar's own buttons.
   *
   * `owner` is the consumer opening it, and the only thing that may close it again.
   */
  open(
    owner: object,
    caps: MessageRowCaps,
    dispatch: (action: MessageRowAction) => void,
    context?: MessageLongPressContext,
  ): void {
    let viewport: MessageSheetViewportSession | null = null;
    const run = (action: MessageRowAction) => {
      // TrnActionSheetComponent closes before invoking a handler. Whether `closed` emits
      // synchronously or on the next turn, this captured session makes restoration happen
      // before the action edits, redacts, or replaces the anchor.
      viewport?.release();
      if (this.viewport === viewport) {
        this.viewport = null;
      }
      dispatch(action);
    };
    const act = (type: PayloadFreeAction['type']) => () => run({ type });

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

    this.dismiss();
    this.owner = owner;
    const ref = this.sheet.open(
      {
        buttons,
        reactions: QUICK_SHEET_REACTIONS.map((key) => ({
          key,
          handler: () => run({ type: 'react', key }),
        })),
      },
      'Message actions',
    );
    this.ref = ref;
    if (context) {
      viewport = new MessageSheetViewportSession(context, () => ref.surface);
      this.viewport = viewport;
      viewport.start();
    }

    // Let go once the sheet closes ITSELF — a pick, a backdrop tap, Escape. Without this the
    // dead ref is retained until the next `open()` or the owner's own destroy, and through
    // CDK's `config.data` it holds the button handlers, their `dispatch` closure, and so the
    // row. Harmless (one row, and the opener is alive by definition) but pointless. Compared
    // against the captured local rather than by identity: `open()` may have replaced it, and
    // `TrnDialogRef`'s own docblock says its identity carries no meaning.
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
   * Dismiss the sheet, if `owner` is the consumer that opened it.
   *
   * A no-op otherwise, which is the point: both consumers call this from their own teardown
   * and from a room change, and the one whose sheet is not showing must not shut the other's.
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
