import { type DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type TrnDialogService } from '@trinity/components/overlay';
import { type ConversationRuntime } from '@trinity/data-access/timeline';
import { messagePermalink } from '@trinity/util/matrix';
import { defer, filter, take } from 'rxjs';
import { type EditHistoryDialogService } from '../edit-history/edit-history.service';
import { type ForwardService } from '../forward/forward.service';
import { type MatrixLinkClickTarget } from '../matrix-link/matrix-link.directive';
import {
  type MessageRow,
  type MessageRowAction,
} from '../message-row/message-row.component';
import { MessageSourceComponent } from '../message-source/message-source.component';
import { ReactionPickerComponent } from '../reaction-picker/reaction-picker.component';
import { type ReactionsDialogService } from '../reactions-dialog/reactions-dialog.service';
import { type ReportService } from '../report/report.service';

/** What the message list and the thread panel hand the shared row-action dispatcher. */
export interface SharedRowActionContext {
  readonly roomId: string;
  readonly destroyRef: DestroyRef;
  readonly dialog: Pick<TrnDialogService, 'open' | 'openAndWait$'>;
  readonly timeline: Pick<ConversationRuntime['timeline'], 'rawEvent'>;
  readonly forward: Pick<ForwardService, 'forward$'>;
  readonly report: Pick<ReportService, 'report$'>;
  readonly reactions: Pick<ReactionsDialogService, 'open$'>;
  readonly editHistory: Pick<EditHistoryDialogService, 'openHistory$'>;
  /** Toggle a reaction; each host sends it its own way. */
  readonly react: (id: string, key: string) => void;
  /** Quote a row into the composer; hosts differ in what quoting cancels. */
  readonly quote: (row: MessageRow) => void;
  /** A permalink followed inside the edit-history dialog; omitted where none are routed. */
  readonly onHistoryLink?: (target: MatrixLinkClickTarget) => void;
}

type SharedRowAction = Extract<
  MessageRowAction,
  {
    type:
      | 'react'
      | 'react-more'
      | 'quote'
      | 'copy'
      | 'copy-link'
      | 'view-source'
      | 'forward'
      | 'report'
      | 'reactors'
      | 'edit-history';
  }
>;

/**
 * Run the row actions that behave the same in the room timeline and in a thread.
 *
 * Returns true when it handled `action`, which also narrows the caller's remaining `switch`
 * to the host-specific actions, so the exhaustiveness guard there still catches a new variant.
 */
export function dispatchSharedRowAction(
  action: MessageRowAction,
  row: MessageRow,
  ctx: SharedRowActionContext,
): action is SharedRowAction {
  switch (action.type) {
    case 'react':
      ctx.react(row.id, action.key);
      return true;
    case 'react-more':
      defer(() =>
        ctx.dialog.openAndWait$<string, ReactionPickerComponent>(
          ReactionPickerComponent,
          // Names the CDK container, which IS the dialog here; the wrapper inside
          // deliberately claims no role of its own.
          { ariaLabel: 'Pick a reaction' },
        ),
      )
        .pipe(
          filter((key): key is string => key !== null),
          take(1),
          takeUntilDestroyed(ctx.destroyRef),
        )
        .subscribe((key) => ctx.react(row.id, key));
      return true;
    case 'quote':
      ctx.quote(row);
      return true;
    case 'copy':
      void navigator.clipboard?.writeText(row.body);
      return true;
    case 'copy-link':
      void navigator.clipboard?.writeText(messagePermalink(ctx.roomId, row.id));
      return true;
    case 'view-source': {
      const raw = ctx.timeline.rawEvent(ctx.roomId, row.id);
      if (raw) {
        ctx.dialog.open(MessageSourceComponent, {
          inputs: { source: JSON.stringify(raw, null, 2) },
        });
      }
      return true;
    }
    case 'forward':
      ctx.forward
        .forward$(ctx.roomId, row.id)
        .pipe(takeUntilDestroyed(ctx.destroyRef))
        .subscribe();
      return true;
    case 'report':
      ctx.report
        .report$(ctx.roomId, row.id)
        .pipe(takeUntilDestroyed(ctx.destroyRef))
        .subscribe();
      return true;
    case 'reactors':
      ctx.reactions
        .open$(row.id)
        .pipe(takeUntilDestroyed(ctx.destroyRef))
        .subscribe({ error: () => undefined });
      return true;
    case 'edit-history':
      // A permalink followed inside the dialog comes back to the host rather than being
      // routed there, so it travels the same path as one clicked in the timeline itself.
      ctx.editHistory
        .openHistory$(ctx.roomId, row.id)
        .pipe(takeUntilDestroyed(ctx.destroyRef))
        .subscribe((followed) => {
          if (followed) ctx.onHistoryLink?.(followed);
        });
      return true;
    default:
      return false;
  }
}
