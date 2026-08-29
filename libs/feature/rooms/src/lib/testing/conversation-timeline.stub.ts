import { Injectable, signal } from '@angular/core';
import type { ConversationTimeline } from '@trinity/data-access/timeline';
import { of } from 'rxjs';
import { vi } from 'vitest';

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
