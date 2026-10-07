import { type DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type TrnDialogService } from '@trinity/components/overlay';
import {
  type ConversationRuntime,
  type MessageView,
  isEditableMessage,
  isQuotableMessage,
  savableMediaKind,
} from '@trinity/data-access/timeline';
import { messagePermalink } from '@trinity/util/matrix';
import { defer, filter, take } from 'rxjs';
import { type EditHistoryDialogService } from '../edit-history/edit-history.service';
import { type ForwardService } from '../forward/forward.service';
import { type MediaSaveService } from '../media-attachment/media-save.service';
import { type MatrixLinkClickTarget } from '../matrix-link/matrix-link.directive';
import {
  type MessageRow,
  type MessageRowAction,
  type MessageRowCaps,
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
  readonly mediaSave: Pick<MediaSaveService, 'save'>;
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

/** What a host decides for every row; the rest of a row's caps derive from the row itself. */
export interface RowCapsPolicy {
  readonly canRedactOthers: boolean;
  readonly canPin: boolean;
  readonly canThread: boolean;
  readonly pinnedIds: readonly string[];
}

/** One row's capabilities under a host's {@link RowCapsPolicy}. */
export function buildRowCaps(
  message: MessageView,
  policy: RowCapsPolicy,
): MessageRowCaps {
  // An unsent message is only a local echo: its id is the SDK's `~roomId:txnId`
  // placeholder, which the homeserver has never seen. Threading off it would make
  // that placeholder the thread root — every reply then relates to an event the
  // server can't resolve — and pinning it would write it into `m.room.pinned_events`
  // room state. Both wait for the remote echo to swap in the real event id.
  const unsent = !!message.status;
  return {
    editable: isEditableMessage(message),
    // Own messages are always deletable; a moderator can also redact others'.
    deletable: (message.isOwn || policy.canRedactOthers) && !unsent,
    canPin: policy.canPin && !unsent,
    pinned: policy.pinnedIds.includes(message.id),
    canThread: policy.canThread && !unsent,
    canQuote: isQuotableMessage(message),
    saveMedia: savableMediaKind(message),
    readOnly: false,
  };
}

/** Whether two caps carry the same capabilities — all eight fields are flat primitives. */
export function sameRowCaps(a: MessageRowCaps, b: MessageRowCaps): boolean {
  return (
    a.editable === b.editable &&
    a.deletable === b.deletable &&
    a.canPin === b.canPin &&
    a.pinned === b.pinned &&
    a.canThread === b.canThread &&
    a.canQuote === b.canQuote &&
    a.saveMedia === b.saveMedia &&
    a.readOnly === b.readOnly
  );
}

/**
 * Caps for every row keyed by event id, reusing the `previous` object when nothing about
 * a row's caps changed. A host's message array gets a new identity on every timeline event;
 * without this reuse each event would hand every OnPush row a fresh `caps` input.
 */
export function buildRowCapsMap(
  messages: readonly MessageView[],
  policy: RowCapsPolicy,
  previous: ReadonlyMap<string, MessageRowCaps>,
): Map<string, MessageRowCaps> {
  const caps = new Map<string, MessageRowCaps>();
  for (const message of messages) {
    const next = buildRowCaps(message, policy);
    const prev = previous.get(message.id);
    caps.set(message.id, prev && sameRowCaps(prev, next) ? prev : next);
  }
  return caps;
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
      | 'save-media'
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
    case 'save-media':
      if (row.media) ctx.mediaSave.save(row.media);
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
