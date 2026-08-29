import { computed } from '@angular/core';
import { catchError, defer, map, of, type Observable } from 'rxjs';
import type {
  MediaPipeline,
  MediaTransferEvent,
  StagedMediaReference,
} from '@trinity/data-access/media';
import type { Mention } from '@trinity/util/matrix';
import type {
  ConversationMessageAdapter,
  ConversationMessageOutcome,
} from './conversation-messages';
import type { ConversationKey } from './conversation-messages';
import type {
  ConversationThread,
  ConversationThreadOperation,
  ConversationThreadOutcome,
  ConversationThreads,
} from './conversation-threads';
import { isEditableMessage } from './message-presentation';
import type { ThreadsService } from './threads.service';

export interface ConversationThreadChildren {
  readonly threads: ConversationThreads;
  release(): void;
}

interface ConversationThreadChildrenOptions {
  readonly key: ConversationKey;
  readonly isFocused: () => boolean;
  readonly projection: ThreadsService;
  readonly messages: ConversationMessageAdapter;
  readonly media: Pick<MediaPipeline, 'transfer'>;
}

/**
 * Creates and generation-guards the exact-root children owned by one Conversation.
 * The parent runtime coordinates focus and retention; this workflow owns root
 * replacement, command validation, adapter translation, and child release.
 */
export function createConversationThreadChildren(
  options: ConversationThreadChildrenOptions,
): ConversationThreadChildren {
  let active: {
    readonly handle: ConversationThread;
    released: boolean;
  } | null = null;

  const release = (): void => {
    const child = active;
    if (!child || child.released) return;
    child.released = true;
    active = null;
    options.projection.closeThread();
  };

  const rejected = (
    operation: ConversationThreadOperation,
    failure: Extract<
      ConversationThreadOutcome,
      { kind: 'rejected' }
    >['failure'],
    retryable = false,
  ): ConversationThreadOutcome => ({
    kind: 'rejected',
    operation,
    failure,
    retryable,
  });
  const applied = (
    operation: ConversationThreadOperation,
  ): ConversationThreadOutcome => ({ kind: 'applied', operation });

  const threads: ConversationThreads = Object.freeze({
    summaries: options.projection.summaries,
    list: options.projection.threadList,
    forRoot: (rootEventId: string): ConversationThread | null => {
      if (!options.isFocused() || !rootEventId) return null;
      if (active?.handle.key.rootEventId === rootEventId) return active.handle;

      release();
      options.projection.attachThreadRoot(rootEventId);
      const key = Object.freeze({ ...options.key, rootEventId });
      const available = (): boolean =>
        options.isFocused() && active?.handle === handle && !active.released;
      const action = (
        operation: ConversationThreadOperation,
        run: () => Observable<void>,
        validate: () =>
          | Extract<ConversationThreadOutcome, { kind: 'rejected' }>['failure']
          | null = () => null,
      ): Observable<ConversationThreadOutcome> =>
        defer(() => {
          if (!available()) {
            return of(rejected(operation, 'conversation-unavailable'));
          }
          const failure = validate();
          if (failure) return of(rejected(operation, failure));
          return run().pipe(
            map(() => applied(operation)),
            catchError(() => of(rejected(operation, 'request-rejected', true))),
          );
        });
      const messageAction = (
        operation: ConversationThreadOperation,
        run: () => Observable<ConversationMessageOutcome>,
      ): Observable<ConversationThreadOutcome> =>
        defer(() => {
          if (!available()) {
            return of(rejected(operation, 'conversation-unavailable'));
          }
          return run().pipe(
            map((outcome) =>
              outcome.kind === 'applied'
                ? applied(operation)
                : rejected(operation, outcome.failure, outcome.retryable),
            ),
          );
        });
      const presented = (messageId: string) =>
        options.projection
          .threadMessages()
          .find((message) => message.id === messageId);

      const handle: ConversationThread = Object.freeze({
        key,
        messages: computed(() =>
          available() ? options.projection.threadMessages() : [],
        ),
        loadingOlder: computed(
          () => available() && options.projection.loadingOlderThread(),
        ),
        canLoadOlder: computed(
          () => available() && options.projection.canPaginateThread(),
        ),
        media: Object.freeze({
          send: (
            media: StagedMediaReference,
            caption: string,
          ): Observable<MediaTransferEvent> =>
            defer(() =>
              available()
                ? options.media.transfer({
                    key: options.key,
                    threadRootId: rootEventId,
                    media,
                    caption,
                  })
                : of({
                    kind: 'rejected' as const,
                    failure: 'conversation-unavailable' as const,
                    retryable: false,
                  }),
            ),
        }),
        loadOlder: () =>
          action('paginate', () => options.projection.paginateOpenThread()),
        send: (body: string, mentions: readonly Mention[] = []) =>
          action(
            'send',
            () => options.projection.sendToThread(body, [...mentions]),
            () => (body.trim() ? null : 'invalid-content'),
          ),
        edit: (
          messageId: string,
          body: string,
          mentions: readonly Mention[] = [],
        ) =>
          action(
            'edit',
            () =>
              options.projection.editInThread(messageId, body, [...mentions]),
            () => {
              if (!body.trim()) return 'invalid-content';
              const message = presented(messageId);
              return message && isEditableMessage(message)
                ? null
                : 'message-unavailable';
            },
          ),
        reply: (
          messageId: string,
          body: string,
          mentions: readonly Mention[] = [],
        ) =>
          action(
            'reply',
            () =>
              options.projection.replyInThread(messageId, body, [...mentions]),
            () => {
              if (!body.trim()) return 'invalid-content';
              return presented(messageId) ? null : 'message-unavailable';
            },
          ),
        toggleReaction: (messageId: string, reaction: string) =>
          messageAction('reaction', () =>
            options.messages.toggleReaction({
              key: options.key,
              threadRootId: rootEventId,
              messageId,
              reaction,
            }),
          ),
        redact: (messageId: string) =>
          messageAction('redaction', () =>
            options.messages.redact({
              key: options.key,
              threadRootId: rootEventId,
              messageId,
            }),
          ),
        retry: (messageId: string) =>
          messageAction('retry', () =>
            options.messages.retry({
              key: options.key,
              threadRootId: rootEventId,
              messageId,
            }),
          ),
        release: () => {
          if (active?.handle === handle) release();
        },
      });
      active = { handle, released: false };
      return handle;
    },
  });

  return Object.freeze({ threads, release });
}
