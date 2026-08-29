import type { Signal } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  MediaTransferEvent,
  StagedMediaReference,
} from '@trinity/data-access/media';
import type { Mention } from '@trinity/util/matrix';
import type { ConversationKey } from './conversation-messages';
import type { MessageView } from './message-presentation';

export interface ThreadParticipant {
  readonly id: string;
  readonly name: string;
  readonly initial: string;
  readonly avatarMxc: string | null;
}

export interface ThreadSummary {
  readonly rootEventId: string;
  readonly rootPreview: string | null;
  readonly rootSenderName: string | null;
  readonly replyCount: number;
  readonly latestReplyTs: number | null;
  readonly latestActivityTs: number;
  readonly latestReplyPreview: string | null;
  readonly latestReplySenderName: string | null;
  readonly participants: readonly ThreadParticipant[];
  readonly unreadCount: number;
  readonly highlight: boolean;
}

export interface ConversationThreadKey extends ConversationKey {
  readonly rootEventId: string;
}

export type ConversationThreadOperation =
  'paginate' | 'send' | 'edit' | 'reply' | 'reaction' | 'redaction' | 'retry';

export type ConversationThreadOutcome =
  | {
      readonly kind: 'applied';
      readonly operation: ConversationThreadOperation;
    }
  | {
      readonly kind: 'rejected';
      readonly operation: ConversationThreadOperation;
      readonly failure:
        | 'conversation-unavailable'
        | 'thread-unavailable'
        | 'message-unavailable'
        | 'invalid-content'
        | 'invalid-reaction'
        | 'not-allowed'
        | 'event-not-retryable'
        | 'request-rejected';
      readonly retryable: boolean;
    };

export interface ConversationThreadMedia {
  send(
    media: StagedMediaReference,
    caption: string,
  ): Observable<MediaTransferEvent>;
}

/** One immutable Account, Room, and thread-root child of a Conversation handle. */
export interface ConversationThread {
  readonly key: ConversationThreadKey;
  readonly messages: Signal<readonly MessageView[]>;
  readonly loadingOlder: Signal<boolean>;
  readonly canLoadOlder: Signal<boolean>;
  readonly media: ConversationThreadMedia;
  loadOlder(): Observable<ConversationThreadOutcome>;
  send(
    body: string,
    mentions?: readonly Mention[],
  ): Observable<ConversationThreadOutcome>;
  edit(
    messageId: string,
    body: string,
    mentions?: readonly Mention[],
  ): Observable<ConversationThreadOutcome>;
  reply(
    messageId: string,
    body: string,
    mentions?: readonly Mention[],
  ): Observable<ConversationThreadOutcome>;
  toggleReaction(
    messageId: string,
    reaction: string,
  ): Observable<ConversationThreadOutcome>;
  redact(messageId: string): Observable<ConversationThreadOutcome>;
  retry(messageId: string): Observable<ConversationThreadOutcome>;
  release(): void;
}

/** Thread summaries plus an explicit exact-root child lookup for one Conversation. */
export interface ConversationThreads {
  readonly summaries: Signal<Readonly<Record<string, ThreadSummary>>>;
  readonly list: Signal<readonly ThreadSummary[]>;
  forRoot(rootEventId: string): ConversationThread | null;
}
