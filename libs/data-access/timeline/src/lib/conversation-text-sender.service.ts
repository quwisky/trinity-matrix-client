import { Injectable, InjectionToken, inject, untracked } from '@angular/core';
import {
  BehaviorSubject,
  NEVER,
  type Observable,
  defer,
  finalize,
  map,
  of,
  switchMap,
  take,
  tap,
} from 'rxjs';
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

function holds(store: TimelineStore, transactionId: string): boolean {
  return untracked(store.items).some(
    (item) => item.kind === 'event' && item.transactionId === transactionId,
  );
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
    const transactionId = `trinity-${crypto.randomUUID()}`;
    // Cancelling unsubscribes the engine's send, so a request not yet made never is.
    const stopped = new BehaviorSubject(false);
    let store: TimelineStore | null = null;
    let settled = false;
    const outcome = defer(() => {
      const { store: opened, release } = this.stores.hold(request.key, LIVE);
      store = opened;
      let watching = false;
      return this.deliver(request, opened, transactionId).pipe(
        map(({ delivery, transactionId: echo }) => {
          if (delivery.kind !== 'rejected' || !echo) return delivery;
          watching = keepWhileWaiting(
            this.drafts,
            conversationDraftKey(request.key),
            request.body,
            {
              transactionId: echo,
              states: opened.sendStates(echo).pipe(finalize(release)),
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
      outcome: stopped.pipe(
        switchMap((stop) => (stop ? NEVER : outcome)),
        take(1),
      ),
      cancel: () =>
        defer(() => {
          // An edit's echo carries no id of ours; a cancelled edit only stops waiting for it.
          if (settled || request.intent.kind === 'edit') return of(false);
          const shown = store !== null && holds(store, transactionId);
          stopped.next(true);
          // `not-cancellable` once the request may have crossed the network boundary: that
          // is indeterminate, rather than restoring text that could now be a duplicate.
          return this.engine.cancelSend(accountId, roomId, transactionId).pipe(
            map(
              (result) =>
                result.ok ||
                // No echo was ever made, and with the send stopped none will be.
                (result.failure.code === 'message-unavailable' && !shown),
            ),
            tap((cancelled) => (settled ||= cancelled)),
          );
        }),
    };
  }

  private deliver(
    request: ConversationTextSendRequest,
    store: TimelineStore,
    transactionId: string,
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
          transactionId,
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
          if (!holds(store, transactionId)) throw new MissingLocalEchoError();
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
