import { Injectable, computed, signal } from '@angular/core';
import type {
  ConversationCompose,
  ConversationComposeIntent,
  ConversationMessages,
  ConversationTimeline,
} from '@trinity/data-access/timeline';
import { of } from 'rxjs';
import { vi } from 'vitest';

/** Controllable test double for the focused Conversation's durable compose intent. */
export class ConversationComposeStub implements ConversationCompose {
  private readonly messageDraftState = signal('');
  private readonly editDraftState = signal('');
  private readonly intentState = signal<ConversationComposeIntent>({
    kind: 'message',
  });
  private readonly sendingState = signal(false);

  readonly draft = computed(() =>
    this.intentState().kind === 'edit'
      ? this.editDraftState()
      : this.messageDraftState(),
  );
  readonly intent = this.intentState.asReadonly();
  readonly sending = this.sendingState.asReadonly();
  readonly setTyping = vi.fn();
  readonly submit: ConversationCompose['submit'] = vi.fn(() =>
    of({ kind: 'sent' as const, eventId: '$test' }),
  );

  setDraft(draft: string): void {
    if (this.intentState().kind === 'edit') this.editDraftState.set(draft);
    else this.messageDraftState.set(draft);
  }

  /** Internal test hook used by the public ConversationMessagesStub. */
  beginReply(eventId: string): void {
    this.intentState.set({ kind: 'reply', eventId });
  }

  /** Internal test hook used by the public ConversationMessagesStub. */
  beginEdit(eventId: string, draft = ''): void {
    this.editDraftState.set(draft);
    this.intentState.set({ kind: 'edit', eventId });
  }

  cancelIntent(): void {
    this.editDraftState.set('');
    this.intentState.set({ kind: 'message' });
  }

  setSending(sending: boolean): void {
    this.sendingState.set(sending);
  }
}

/** Message-command double that keeps reply/edit tests on the public runtime seam. */
export class ConversationMessagesStub implements ConversationMessages {
  constructor(private readonly compose: ConversationComposeStub) {}

  beginReply(messageId: string) {
    this.compose.beginReply(messageId);
    return { kind: 'applied' as const, operation: 'reply' as const };
  }

  beginEdit(messageId: string, draft: string) {
    this.compose.beginEdit(messageId, draft);
    return { kind: 'applied' as const, operation: 'edit' as const };
  }

  readonly toggleReaction: ConversationMessages['toggleReaction'] = vi.fn(() =>
    of({ kind: 'applied' as const, operation: 'reaction' as const }),
  );
  readonly redact: ConversationMessages['redact'] = vi.fn(() =>
    of({ kind: 'applied' as const, operation: 'redaction' as const }),
  );
  readonly retry: ConversationMessages['retry'] = vi.fn(() =>
    of({ kind: 'applied' as const, operation: 'retry' as const }),
  );
  readonly acknowledge: ConversationMessages['acknowledge'] = vi.fn(() =>
    of({ kind: 'applied' as const, operation: 'receipt' as const }),
  );
}

/** Safe test double for the public Conversation timeline capability. */
@Injectable()
export class ConversationTimelineStub implements ConversationTimeline {
  readonly messages: ConversationTimeline['messages'] = signal([]).asReadonly();
  readonly loadingOlder: ConversationTimeline['loadingOlder'] =
    signal(false).asReadonly();
  readonly canLoadOlder: ConversationTimeline['canLoadOlder'] =
    signal(false).asReadonly();
  readonly oldestEventId: ConversationTimeline['oldestEventId'] =
    signal(null).asReadonly();
  readonly typingNames: ConversationTimeline['typingNames'] = signal(
    [],
  ).asReadonly();
  readonly canRedactOthers: ConversationTimeline['canRedactOthers'] =
    signal(false).asReadonly();
  readonly tombstone: ConversationTimeline['tombstone'] =
    signal(null).asReadonly();
  readonly firstUnreadId: ConversationTimeline['firstUnreadId'] =
    signal(null).asReadonly();
  openRoomId: string | null = null;
  roomEncrypted = false;
  readonly loadOlder: ConversationTimeline['loadOlder'] = vi.fn(() =>
    of(void 0),
  );
  readonly jumpToDate: ConversationTimeline['jumpToDate'] = vi.fn(() =>
    of({ kind: 'no-event' as const }),
  );
  readonly setTyping: ConversationTimeline['setTyping'] = vi.fn();
  readonly rawEvent: ConversationTimeline['rawEvent'] = vi.fn(() => null);
  readonly reactionDetails: ConversationTimeline['reactionDetails'] = vi.fn(
    () => [],
  );
  readonly open = vi.fn((roomId: string) => {
    this.openRoomId = roomId;
  });
  readonly close = vi.fn(() => {
    this.openRoomId = null;
  });

  focusRoom(roomId: string): void {
    this.open(roomId);
  }

  blurRoom(): void {
    this.close();
  }
}
