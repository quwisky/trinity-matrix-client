import { type DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { type TrnSurfaceService } from '@trinity/components/overlay';
import {
  type ConversationRuntime,
  type MessageView,
  isEditableMessage,
  isForwardableMessage,
  isQuotableMessage,
  savableMediaKind,
} from '@trinity/data-access/timeline';
import { isValidMxcUri, type AddInput } from '@trinity/data-access/media';
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
import { type AddToMyEmojiService } from './add-to-my-emoji.service';
import { type UndecryptableFixService } from './undecryptable-fix.service';

/** What the message list and the thread panel hand the shared row-action dispatcher. */
export interface SharedRowActionContext {
  readonly roomId: string;
  /** The account that sees this Conversation; reports go to its server's admins. */
  readonly accountId: string | null;
  readonly destroyRef: DestroyRef;
  readonly dialog: Pick<
    TrnSurfaceService,
    'open' | 'openAndWait$' | 'openActions'
  >;
  readonly timeline: Pick<ConversationRuntime['timeline'], 'eventSource'>;
  readonly forward: Pick<ForwardService, 'forward$'>;
  readonly mediaSave: Pick<MediaSaveService, 'save'>;
  readonly report: Pick<ReportService, 'report$'>;
  readonly reactions: Pick<ReactionsDialogService, 'open$'>;
  readonly editHistory: Pick<EditHistoryDialogService, 'openHistory$'>;
  /** Open the fix for a message this device could not decrypt. */
  readonly undecryptableFix: Pick<UndecryptableFixService, 'open'>;
  readonly addToEmoji: Pick<AddToMyEmojiService, 'add' | 'canAdd'>;
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
  /** Whether this message has an image (its sticker, or an emoji) to offer for the personal pack. */
  readonly canAddToEmoji: (message: MessageView) => boolean;
}

/** One row's capabilities under a host's {@link RowCapsPolicy}. */
export function buildRowCaps(
  message: MessageView,
  policy: RowCapsPolicy,
): MessageRowCaps {
  // An unsent message is a local echo with the SDK's `~roomId:txnId` placeholder id, which the
  // homeserver has never seen. Threading off it would make the placeholder the thread root (replies
  // relate to an event the server can't resolve), and pinning it would write it into
  // `m.room.pinned_events`. Replies and reactions would point at it too. All wait for the remote
  // echo to swap in the real event id.
  const unsent = !!message.status;
  return {
    editable: isEditableMessage(message),
    // Own messages are always deletable; a moderator can also redact others'.
    deletable: (message.isOwn || policy.canRedactOthers) && !unsent,
    canPin: policy.canPin && !unsent,
    pinned: policy.pinnedIds.includes(message.id),
    canThread: policy.canThread && !unsent,
    canQuote: !unsent && isQuotableMessage(message),
    canRespond: !unsent,
    saveMedia: savableMediaKind(message),
    canForward: isForwardableMessage(message),
    addToEmoji: !unsent && policy.canAddToEmoji(message),
    readOnly: false,
  };
}

/**
 * A sticker row's image as "Add to my emoji" takes it: its own mxc, info and body. Null for
 * anything else, or an encrypted sticker, which has no plain mxc to put in a pack.
 */
function stickerImage(
  message: MessageView,
): Extract<AddInput, { kind: 'existing' }> | null {
  const image = message.kind === 'sticker' ? message.stickerImage : null;
  if (!image || !isValidMxcUri(image.url)) return null;
  return {
    kind: 'existing',
    url: image.url,
    ...(image.info ? { info: { ...image.info } } : {}),
    ...(image.body !== undefined ? { body: image.body } : {}),
  };
}

/** A custom emoji in a rendered body: its mxc and `:code:`. */
interface Emoticon {
  readonly url: string;
  readonly code: string;
}

/** Parsed once per message: caps are rebuilt for every row on each timeline change. */
const emoticonCache = new WeakMap<MessageView, readonly Emoticon[]>();

/** The distinct custom emoji in `message`'s sanitized HTML, which moved each mxc to `data-mx-src`. */
function emoticonsIn(message: MessageView): readonly Emoticon[] {
  if (!message.html?.includes('mx-emoticon')) return [];
  let found = emoticonCache.get(message);
  if (!found) {
    const seen = new Map<string, Emoticon>();
    new DOMParser()
      .parseFromString(message.html, 'text/html')
      .querySelectorAll('img.mx-emoticon')
      .forEach((image) => {
        const url = image.getAttribute('data-mx-src') ?? '';
        if (isValidMxcUri(url) && !seen.has(url)) {
          seen.set(url, { url, code: image.getAttribute('alt') ?? url });
        }
      });
    found = [...seen.values()];
    emoticonCache.set(message, found);
  }
  return found;
}

/**
 * A host's {@link RowCapsPolicy.canAddToEmoji}: a sticker in `roomId`, or a message with a custom
 * emoji, whose image is not in the pack yet.
 */
export function addableImages(
  adder: Pick<AddToMyEmojiService, 'canAdd'>,
): (message: MessageView) => boolean {
  return (message) => {
    if (message.kind !== 'sticker') {
      return emoticonsIn(message).some(({ url }) => adder.canAdd(url));
    }
    const image = stickerImage(message);
    return !!image && adder.canAdd(image.url);
  };
}

/** Open the dialog for one emoji, or let the user choose among several by `:code:`. */
function addEmoticon(row: MessageRow, ctx: SharedRowActionContext): void {
  const add = ({ url, code }: Emoticon): void => {
    const name = code.replace(/^:|:$/g, '');
    ctx.addToEmoji.add({ kind: 'existing', url, body: name }, name);
  };
  const choices = emoticonsIn(row).filter(({ url }) =>
    ctx.addToEmoji.canAdd(url),
  );
  if (choices.length < 2) {
    if (choices[0]) add(choices[0]);
    return;
  }
  ctx.dialog.openActions(
    {
      header: 'Add to my emoji',
      buttons: [
        ...choices.map((choice) => ({
          text: choice.code,
          handler: () => add(choice),
        })),
        { text: 'Cancel', role: 'cancel' as const },
      ],
    },
    { ariaLabel: 'Add to my emoji' },
  );
}

/** Whether two caps carry the same capabilities — every field is a flat primitive. */
export function sameRowCaps(a: MessageRowCaps, b: MessageRowCaps): boolean {
  return (
    a.editable === b.editable &&
    a.deletable === b.deletable &&
    a.canPin === b.canPin &&
    a.pinned === b.pinned &&
    a.canThread === b.canThread &&
    a.canQuote === b.canQuote &&
    a.canRespond === b.canRespond &&
    a.saveMedia === b.saveMedia &&
    a.canForward === b.canForward &&
    a.addToEmoji === b.addToEmoji &&
    a.readOnly === b.readOnly
  );
}

/**
 * Caps for every row keyed by event id, reusing the `previous` object when nothing about a row's
 * caps changed. A host's message array gets a new identity on every timeline event; without this
 * reuse each event would hand every OnPush row a fresh `caps` input.
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
      | 'add-to-emoji'
      | 'view-source'
      | 'forward'
      | 'report'
      | 'reactors'
      | 'edit-history'
      | 'fix-undecryptable';
  }
>;

/**
 * Run the row actions that behave the same in the room timeline and in a thread. Returns true when
 * it handled `action`, which narrows the caller's remaining `switch` to the host-specific actions
 * so its exhaustiveness guard still catches a new variant.
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
    case 'add-to-emoji': {
      const image = stickerImage(row);
      // The dialog's shortcode starts from this name, so it is never empty.
      if (image) ctx.addToEmoji.add(image, image.body || 'sticker');
      else addEmoticon(row, ctx);
      return true;
    }
    case 'view-source':
      ctx.timeline
        .eventSource(row.id)
        .pipe(takeUntilDestroyed(ctx.destroyRef))
        .subscribe((raw) => {
          if (raw) {
            ctx.dialog.open(MessageSourceComponent, {
              inputs: { source: JSON.stringify(raw, null, 2) },
            });
          }
        });
      return true;
    case 'forward':
      ctx.forward
        .forward$(ctx.roomId, row.id)
        .pipe(takeUntilDestroyed(ctx.destroyRef))
        .subscribe();
      return true;
    case 'report':
      ctx.report
        .report$(
          ctx.accountId
            ? { accountId: ctx.accountId, roomId: ctx.roomId }
            : ctx.roomId,
          row.id,
        )
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
      // A permalink followed inside the dialog comes back to the host, so it travels the same path as one clicked in the timeline.
      ctx.editHistory
        .openHistory$(ctx.roomId, row.id)
        .pipe(takeUntilDestroyed(ctx.destroyRef))
        .subscribe((followed) => {
          if (followed) ctx.onHistoryLink?.(followed);
        });
      return true;
    case 'fix-undecryptable':
      ctx.undecryptableFix
        .open()
        .pipe(takeUntilDestroyed(ctx.destroyRef))
        .subscribe({ error: () => undefined });
      return true;
    default:
      return false;
  }
}
