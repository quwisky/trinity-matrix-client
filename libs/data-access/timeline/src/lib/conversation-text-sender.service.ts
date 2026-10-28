import { Injectable, InjectionToken, inject, untracked } from '@angular/core';
import { type Observable, defer, finalize, map, of, tap } from 'rxjs';
import {
  type EngineResult,
  outgoingReplyText,
  renderMarkdown,
  slashCommandContent,
  textMessageContent,
} from '@trinity/util/matrix';
import { ImagePackEditorService } from '@trinity/data-access/media';
import { DraftStoreService } from '@trinity/platform-native';
import {
  type ConversationTextDelivery,
  type ConversationTextSendOperation,
  type ConversationTextSendRequest,
  type ConversationTextSender,
} from './conversation-compose';
import { conversationDraftKey } from './conversation-draft-key';
import type { OutgoingText } from './timeline-engine';
import { TIMELINE_ENGINE } from './timeline-engine.token';
import { type TimelineStore, TimelineStores } from './timeline-store';
import { keepWhileWaiting } from './waiting-draft';

class MissingLocalEchoError extends Error {
  constructor() {
    super('The Matrix SDK accepted a message without exposing its local echo.');
  }
}

const LIVE = { kind: 'live' } as const;
const NO_THREAD = { threadRootId: null } as const;

/** The engine's form of message content a builder in `@trinity/util/matrix` made. */
function outgoingText(content: Record<string, unknown>): OutgoingText {
  const mentions = (content['m.mentions'] ?? {}) as {
    readonly user_ids?: readonly string[];
    readonly room?: boolean;
  };
  const formatted = content['formatted_body'];
  return {
    msgtype: String(content['msgtype']).slice(
      'm.'.length,
    ) as OutgoingText['msgtype'],
    body: String(content['body']),
    formattedBody: typeof formatted === 'string' ? formatted : null,
    mentions: {
      userIds: mentions.user_ids ?? [],
      room: mentions.room === true,
    },
  };
}

/** The own local echo `store` holds now, with a transaction id not in `before`. */
function newEcho(
  store: TimelineStore,
  before: ReadonlySet<string>,
): string | null {
  for (const item of untracked(store.items)) {
    if (item.kind !== 'event' || !item.isOwn || item.transactionId === null)
      continue;
    if (!before.has(item.transactionId)) return item.transactionId;
  }
  return null;
}

function transactionIds(store: TimelineStore): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const item of untracked(store.items)) {
    if (item.kind === 'event' && item.transactionId !== null)
      ids.add(item.transactionId);
  }
  return ids;
}

@Injectable({ providedIn: 'root' })
class EngineConversationTextSender implements ConversationTextSender {
  private readonly engine = inject(TIMELINE_ENGINE);
  // Held per send: the echo's state is watched past the Conversation's lifetime.
  private readonly stores = inject(TimelineStores);
  // Its emoticons() map is filled only while the rooms page subscribes run(); else it is empty.
  private readonly packs = inject(ImagePackEditorService);
  private readonly drafts = inject(DraftStoreService);

  send(request: ConversationTextSendRequest): ConversationTextSendOperation {
    const { accountId, roomId } = request.key;
    let store: TimelineStore | null = null;
    let before: ReadonlySet<string> = new Set();
    let settled = false;
    const outcome = defer(() => {
      const { store: opened, release } = this.stores.hold(request.key, LIVE);
      store = opened;
      before = transactionIds(opened);
      let watching = false;
      return this.deliver(request, opened).pipe(
        map(({ delivery, transactionId }) => {
          if (delivery.kind !== 'rejected' || !transactionId) return delivery;
          watching = keepWhileWaiting(
            this.drafts,
            conversationDraftKey(request.key),
            request.body,
            {
              transactionId,
              states: opened.sendStates(transactionId).pipe(finalize(release)),
            },
          );
          return watching ? ({ kind: 'queued' } as const) : delivery;
        }),
        tap({
          next: () => (settled = true),
          error: () => (settled = true),
        }),
        finalize(() => {
          if (!watching) release();
        }),
      );
    });
    return {
      outcome,
      cancel: () => {
        if (settled || !store) return of(false);
        const transactionId = newEcho(store, before);
        // No echo shown yet proves nothing: the send may be on the wire behind a page flush.
        if (transactionId === null) return of(false);
        // `not-cancellable` once the request may have crossed the network boundary: that is
        // indeterminate, rather than restoring text that could now be a duplicate.
        return this.engine.cancelSend(accountId, roomId, transactionId).pipe(
          map((result) => result.ok),
          tap((cancelled) => (settled ||= cancelled)),
        );
      },
    };
  }

  private deliver(
    request: ConversationTextSendRequest,
    store: TimelineStore,
  ): Observable<{
    readonly delivery: ConversationTextDelivery;
    readonly transactionId: string | null;
  }> {
    const { accountId, roomId } = request.key;
    const { intent } = request;
    if (intent.kind === 'edit') {
      return this.engine
        .edit(
          accountId,
          roomId,
          { eventId: intent.eventId, transactionId: null },
          this.text(request),
          NO_THREAD,
        )
        .pipe(
          map((result) => ({
            delivery: result.ok
              ? { kind: 'accepted' as const, eventId: null }
              : rejected(result),
            transactionId: null,
          })),
        );
    }
    return this.engine
      .send(
        accountId,
        roomId,
        { kind: 'text', ...this.text(request) },
        {
          threadRootId: null,
          replyTo: intent.kind === 'reply' ? intent.eventId : null,
        },
      )
      .pipe(
        map((result) => {
          if (!result.ok)
            return { delivery: rejected(result), transactionId: null };
          const { transactionId, eventId } = result.value;
          if (eventId === null) {
            return {
              delivery: { kind: 'rejected', retryable: true } as const,
              transactionId,
            };
          }
          const echo = untracked(store.items).some(
            (item) =>
              item.kind === 'event' && item.transactionId === transactionId,
          );
          if (!echo) throw new MissingLocalEchoError();
          return {
            delivery: { kind: 'accepted' as const, eventId },
            transactionId,
          };
        }),
      );
  }

  private text(request: ConversationTextSendRequest): OutgoingText {
    const mentions = [...request.mentions];
    const emoticons = this.packs.emoticons();
    const render = (text: string) => renderMarkdown(text, emoticons);
    const { body, intent } = request;
    switch (intent.kind) {
      case 'message':
        return outgoingText(
          slashCommandContent(body, render, mentions) ??
            textMessageContent(body, render(body), mentions),
        );
      case 'reply':
        return outgoingReplyText(body, render(body), mentions);
      case 'edit':
        // The engine adds the `m.replace` relation and the `* ` fallback around it.
        return outgoingText(textMessageContent(body, render(body), mentions));
    }
  }
}

/** A send the account cannot make now is final; anything else may be tried again. */
function rejected(
  result: Extract<EngineResult<unknown>, { ok: false }>,
): ConversationTextDelivery {
  const { code } = result.failure;
  return {
    kind: 'rejected',
    retryable: code !== 'account-not-live' && code !== 'message-unavailable',
  };
}

export const CONVERSATION_TEXT_SENDER =
  new InjectionToken<ConversationTextSender>(
    'conversation-runtime.text-sender',
    {
      providedIn: 'root',
      factory: () => inject(EngineConversationTextSender),
    },
  );

export type { ConversationTextSender } from './conversation-compose';
