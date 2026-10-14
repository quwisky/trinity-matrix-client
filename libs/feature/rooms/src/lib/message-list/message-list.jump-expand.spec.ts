import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationRuntime,
  type MessageView,
} from '@trinity/data-access/timeline';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import { ExpandedBodiesStore } from '../rooms/expanded-bodies.store';
import { RoomShellStore } from '../rooms/room-shell-store';
import {
  ConversationComposeStub,
  ConversationMessagesStub,
} from '../testing/conversation-timeline.stub';
import { MessageListComponent } from './message-list.component';

function msg(id: string, ts: number): MessageView {
  return {
    id,
    senderId: '@a:hs',
    senderName: 'A',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body: `body ${id}`,
    html: null,
    timestamp: ts,
    isOwn: false,
    decryptionFailed: false,
    edited: false,
    reactions: [],
    replyTo: null,
    status: null,
    kind: 'text',
    media: null,
    caption: null,
    captionHtml: null,
    readReceipts: [],
    poll: null,
  };
}

const many = (n: number): MessageView[] =>
  Array.from({ length: n }, (_, i) => msg(`$${i}`, 1000 + i * 10_000));

describe('MessageListComponent — jump targets start expanded', () => {
  beforeEach(() => {
    const compose = new ConversationComposeStub();
    TestBed.overrideProvider(ConversationRuntime, {
      useValue: { compose, messages: new ConversationMessagesStub(compose) },
    });
    // As in message-list.component.spec.ts: no real frames, no scroll writes.
    vi.stubGlobal('requestAnimationFrame', () => 0);
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => vi.unstubAllGlobals());

  function renderList(
    inputs: Partial<{
      messages: MessageView[];
      jumpToId: string;
      jumpToNonce: number;
      firstUnreadId: string;
    }>,
  ) {
    return render(MessageListComponent, {
      inputs,
      imports: [MockComponent(MessageComposerComponent)],
      providers: [
        ExpandedBodiesStore,
        MockProvider(RoomShellStore, {
          activeAccountId: signal<string | null>('@me:hs'),
          activeRoomId: signal<string | null>('!r:hs'),
        }),
      ],
    });
  }

  it('starts an explicit jump target expanded', async () => {
    await renderList({ messages: many(10), jumpToId: '$4', jumpToNonce: 1 });

    expect(TestBed.inject(ExpandedBodiesStore).isExpanded('$4')).toBe(true);
  });

  it('starts a reply preview’s target expanded', async () => {
    const { fixture } = await renderList({ messages: many(10) });
    const list = fixture.componentInstance;

    list.onRowAction(list.rows()[9], { type: 'jump', id: '$2' });

    expect(TestBed.inject(ExpandedBodiesStore).isExpanded('$2')).toBe(true);
  });

  it('expands nothing when positioning at the first unread message', async () => {
    const { fixture } = await renderList({
      messages: many(10),
      firstUnreadId: '$6',
    });

    fixture.componentInstance.jumpToUnread();

    expect(TestBed.inject(ExpandedBodiesStore).expanded().size).toBe(0);
  });
});
