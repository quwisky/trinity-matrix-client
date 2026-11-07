import { type Signal, computed, signal } from '@angular/core';
import { Observable, defaultIfEmpty, defer, finalize, of, take } from 'rxjs';
import { type Mention } from '@trinity/util/matrix';
import { type ConversationState } from './conversation-runtime.service';
import { type ConversationKey } from './conversation-messages';
import { appendDraft, withoutSent } from './draft-text';

export type ConversationComposeIntent =
  | { readonly kind: 'message' }
  | { readonly kind: 'reply'; readonly eventId: string }
  | { readonly kind: 'edit'; readonly eventId: string };

export type ConversationTextSendFailure =
  | 'conversation-unavailable'
  | 'empty-draft'
  | 'send-in-progress'
  | 'send-rejected';

export type ConversationTextSendOutcome =
  | { readonly kind: 'sent'; readonly eventId: string }
  /** Failed offline: it waits in the timeline and goes out by itself on reconnect. */
  | { readonly kind: 'queued' }
  | {
      readonly kind: 'rejected';
      readonly failure: ConversationTextSendFailure;
      readonly retryable: boolean;
    };

export interface ConversationTextSendRequest {
  readonly key: ConversationKey;
  readonly body: string;
  readonly mentions: readonly Mention[];
  readonly intent: ConversationComposeIntent;
}

export type ConversationTextDelivery =
  | { readonly kind: 'accepted'; readonly eventId: string }
  | { readonly kind: 'queued' }
  | { readonly kind: 'rejected'; readonly retryable: boolean };

export interface ConversationTextSendOperation {
  readonly outcome: Observable<ConversationTextDelivery>;
  /** Cancel only when the SDK can prove the event has not left the client. */
  cancel(): boolean;
}

export interface ConversationTextSender {
  send(request: ConversationTextSendRequest): ConversationTextSendOperation;
}

export interface ConversationCompose {
  readonly draft: Signal<string>;
  readonly intent: Signal<ConversationComposeIntent>;
  readonly sending: Signal<boolean>;
  setDraft(draft: string): void;
  cancelIntent(): void;
  setTyping(typing: boolean): void;
  submit(
    mentions?: readonly Mention[],
  ): Observable<ConversationTextSendOutcome>;
}

export interface ConversationComposeSnapshot {
  readonly intent: Exclude<
    ConversationComposeIntent,
    { readonly kind: 'message' }
  >;
  readonly editDraft: string;
}

interface ConversationComposePorts {
  readonly key: ConversationKey;
  readonly state: Signal<ConversationState>;
  readonly initialDraft: string;
  readonly initialSnapshot?: ConversationComposeSnapshot;
  persistDraft(draft: string): void;
  /** The persisted draft, which still holds a message in flight that the box no longer shows. */
  readDraft(): string;
  persistSnapshot(snapshot: ConversationComposeSnapshot | null): void;
  setTyping(typing: boolean): void;
  send(request: ConversationTextSendRequest): ConversationTextSendOperation;
}

const MESSAGE_INTENT: ConversationComposeIntent = Object.freeze({
  kind: 'message',
});

/**
 * Mutable user intent owned by one immutable Conversation handle.
 *
 * The textarea still owns its caret and transient editing mechanics. This object owns the
 * durable meaning of what is being composed, and commits it only after the SDK adapter has
 * exposed the authoritative local echo.
 */
export class ConversationComposeController {
  private readonly messageDraftState;
  private readonly editDraftState;
  private readonly intentState;
  private readonly sendingState = signal(false);
  private revision = 0;

  readonly compose: ConversationCompose;

  constructor(private readonly ports: ConversationComposePorts) {
    this.messageDraftState = signal(ports.initialDraft);
    this.editDraftState = signal(ports.initialSnapshot?.editDraft ?? '');
    this.intentState = signal<ConversationComposeIntent>(
      ports.initialSnapshot?.intent ?? MESSAGE_INTENT,
    );
    this.compose = Object.freeze({
      draft: this.currentDraft(),
      intent: this.intentState.asReadonly(),
      sending: this.sendingState.asReadonly(),
      setDraft: (draft: string) => this.setDraft(draft),
      cancelIntent: () => this.cancelIntent(),
      setTyping: (typing: boolean) => this.ports.setTyping(typing),
      submit: (mentions: readonly Mention[] = []) => this.submit(mentions),
    });
  }

  stopTyping(): void {
    this.ports.setTyping(false);
  }

  beginReply(eventId: string): void {
    this.setTarget('reply', eventId);
  }

  beginEdit(eventId: string, draft = ''): void {
    if (!eventId) return;
    this.editDraftState.set(draft);
    this.setTarget('edit', eventId);
  }

  /**
   * Add `text` to the message draft, even while an edit is in progress: the edit's end shows it.
   * Not a user edit, so it leaves {@link revision} alone: a send in flight still settles as
   * it would have, and its text stays in the persisted draft until it does.
   */
  keepMessageDraft(text: string): void {
    this.messageDraftState.set(appendDraft(this.messageDraftState(), text));
    this.ports.persistDraft(appendDraft(this.ports.readDraft(), text));
  }

  private setDraft(draft: string): void {
    if (this.compose.draft() === draft) return;
    this.revision += 1;
    if (this.intentState().kind === 'edit') {
      this.editDraftState.set(draft);
      this.persistSnapshot();
    } else {
      this.messageDraftState.set(draft);
      this.ports.persistDraft(draft);
    }
  }

  private setTarget(kind: 'reply' | 'edit', eventId: string): void {
    if (!eventId) return;
    this.revision += 1;
    this.intentState.set(Object.freeze({ kind, eventId }));
    this.persistSnapshot();
  }

  private cancelIntent(): void {
    this.revision += 1;
    this.finishIntent();
  }

  private finishIntent(): void {
    this.editDraftState.set('');
    this.intentState.set(MESSAGE_INTENT);
    this.ports.persistSnapshot(null);
  }

  private persistSnapshot(): void {
    const intent = this.intentState();
    this.ports.persistSnapshot(
      intent.kind === 'message'
        ? null
        : Object.freeze({ intent, editDraft: this.editDraftState() }),
    );
  }

  private currentDraft(): Signal<string> {
    return computed(() =>
      this.intentState().kind === 'edit'
        ? this.editDraftState()
        : this.messageDraftState(),
    );
  }

  private submit(
    mentions: readonly Mention[],
  ): Observable<ConversationTextSendOutcome> {
    return defer(() => {
      if (this.ports.state() !== 'focused') {
        return of(this.rejected('conversation-unavailable', false));
      }
      if (this.sendingState()) {
        return of(this.rejected('send-in-progress', false));
      }
      const draft = this.compose.draft();
      const body = draft.trim();
      if (!body) {
        return of(this.rejected('empty-draft', false));
      }

      const intent = this.intentState();
      const revision = this.revision;
      const request: ConversationTextSendRequest = Object.freeze({
        key: this.ports.key,
        body,
        mentions: Object.freeze([...mentions]),
        intent,
      });
      this.sendingState.set(true);
      if (intent.kind !== 'edit') {
        this.messageDraftState.set('');
      }
      let settled = false;

      return new Observable<ConversationTextSendOutcome>((subscriber) => {
        const operation = this.ports.send(request);
        const delivery = operation.outcome
          .pipe(
            take(1),
            defaultIfEmpty({ kind: 'rejected', retryable: true } as const),
          )
          .subscribe({
            next: (outcome) => {
              settled = true;
              if (outcome.kind !== 'rejected') {
                // Storage drops the sent text even if a reply or edit began meanwhile, or a
                // reload would offer it again; only the box waits on the revision.
                if (intent.kind !== 'edit') {
                  this.ports.persistDraft(
                    withoutSent(this.ports.readDraft(), draft),
                  );
                }
                if (this.revision === revision) this.finishIntent();
                subscriber.next(
                  outcome.kind === 'queued'
                    ? outcome
                    : { kind: 'sent', eventId: outcome.eventId },
                );
              } else {
                this.restore(draft, intent, revision);
                subscriber.next(
                  this.rejected('send-rejected', outcome.retryable),
                );
              }
            },
            error: (error: unknown) => {
              // An adapter defect (for example an accepted event with no authoritative local
              // echo) is indeterminate, not proof that sending failed. Do not invite a duplicate.
              settled = true;
              subscriber.error(error);
            },
            complete: () => subscriber.complete(),
          });
        return () => {
          if (!settled && operation.cancel()) {
            this.restore(draft, intent, revision);
          }
          delivery.unsubscribe();
        };
      }).pipe(
        finalize(() => {
          this.sendingState.set(false);
        }),
      );
    });
  }

  private restore(
    draft: string,
    intent: ConversationComposeIntent,
    revision: number,
  ): void {
    if (intent.kind === 'edit') return;
    // Never skipped: text typed or kept since the send goes after the failed one. A retired
    // handle's box is empty; what was kept for it waits in storage behind the failed text.
    const since =
      this.messageDraftState() || withoutSent(this.ports.readDraft(), draft);
    const restored = appendDraft(draft, since);
    this.messageDraftState.set(restored);
    this.ports.persistDraft(restored);
    if (this.revision === revision && this.intentState().kind === 'message') {
      this.intentState.set(intent);
    }
  }

  private rejected(
    failure: ConversationTextSendFailure,
    retryable: boolean,
  ): ConversationTextSendOutcome {
    return { kind: 'rejected', failure, retryable };
  }
}
