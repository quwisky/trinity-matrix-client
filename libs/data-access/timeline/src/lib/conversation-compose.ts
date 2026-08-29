import { type Signal, computed, signal } from '@angular/core';
import { Observable, defaultIfEmpty, defer, finalize, of, take } from 'rxjs';
import { type Mention } from '@trinity/util/matrix';
import {
  type ConversationKey,
  type ConversationState,
} from './conversation-runtime.service';

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
  beginReply(eventId: string): void;
  beginEdit(eventId: string, draft?: string): void;
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
      beginReply: (eventId: string) => this.setTarget('reply', eventId),
      beginEdit: (eventId: string, draft = '') =>
        this.beginEdit(eventId, draft),
      cancelIntent: () => this.cancelIntent(),
      setTyping: (typing: boolean) => this.ports.setTyping(typing),
      submit: (mentions: readonly Mention[] = []) => this.submit(mentions),
    });
  }

  stopTyping(): void {
    this.ports.setTyping(false);
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

  private beginEdit(eventId: string, draft: string): void {
    if (!eventId) return;
    this.editDraftState.set(draft);
    this.setTarget('edit', eventId);
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
              if (outcome.kind === 'accepted') {
                if (this.revision === revision) {
                  if (intent.kind !== 'edit') this.ports.persistDraft('');
                  this.finishIntent();
                }
                subscriber.next({ kind: 'sent', eventId: outcome.eventId });
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
    if (this.revision !== revision || intent.kind === 'edit') return;
    if (!this.messageDraftState()) {
      this.messageDraftState.set(draft);
      this.ports.persistDraft(draft);
    }
    if (this.intentState().kind === 'message') this.intentState.set(intent);
  }

  private rejected(
    failure: ConversationTextSendFailure,
    retryable: boolean,
  ): ConversationTextSendOutcome {
    return { kind: 'rejected', failure, retryable };
  }
}
