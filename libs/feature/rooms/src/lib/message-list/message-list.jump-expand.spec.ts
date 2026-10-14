import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockComponent, MockProvider } from 'ng-mocks';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
  type MockInstance,
} from 'vitest';
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
  const scrollIntoViewOwn = Object.getOwnPropertyDescriptor(
    Element.prototype,
    'scrollIntoView',
  );
  let scrollIntoView: Mock<(arg?: boolean | ScrollIntoViewOptions) => void>;
  let expand: MockInstance<ExpandedBodiesStore['expand']>;

  beforeEach(() => {
    const compose = new ConversationComposeStub();
    TestBed.overrideProvider(ConversationRuntime, {
      useValue: { compose, messages: new ConversationMessagesStub(compose) },
    });
    // As in message-list.component.spec.ts: no real frames, no scroll writes.
    vi.stubGlobal('requestAnimationFrame', () => 0);
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    expand = vi.spyOn(ExpandedBodiesStore.prototype, 'expand');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    expand.mockRestore();
    if (scrollIntoViewOwn) {
      Object.defineProperty(
        Element.prototype,
        'scrollIntoView',
        scrollIntoViewOwn,
      );
    } else {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    }
  });

  /** The expansion came first, then exactly one scroll, aimed at the target row. */
  function expectExpandedThenOneScroll(container: Element, id: string): void {
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(
      container.querySelector(`[data-mid="${id}"]`),
    );
    expect(expand.mock.invocationCallOrder[0]).toBeLessThan(
      scrollIntoView.mock.invocationCallOrder[0],
    );
  }

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

  it('starts an explicit jump target expanded, then scrolls to it once', async () => {
    const { container } = await renderList({
      messages: many(10),
      jumpToId: '$4',
      jumpToNonce: 1,
    });

    expect(TestBed.inject(ExpandedBodiesStore).isExpanded('$4')).toBe(true);
    expectExpandedThenOneScroll(container, '$4');
  });

  it('starts a reply preview’s target expanded, and scrolls after it renders', async () => {
    const { fixture, container } = await renderList({ messages: many(10) });
    const list = fixture.componentInstance;

    list.onRowAction(list.rows()[9], { type: 'jump', id: '$2' });

    expect(TestBed.inject(ExpandedBodiesStore).isExpanded('$2')).toBe(true);
    // The row on screen is still collapsed: no scroll until the expansion renders.
    expect(scrollIntoView).not.toHaveBeenCalled();
    await fixture.whenStable();
    expectExpandedThenOneScroll(container, '$2');
  });

  it('scrolls at once to a jump target that is already expanded', async () => {
    const { fixture, container } = await renderList({ messages: many(10) });
    const list = fixture.componentInstance;
    TestBed.inject(ExpandedBodiesStore).expand('$2');

    list.onRowAction(list.rows()[9], { type: 'jump', id: '$2' });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(
      container.querySelector('[data-mid="$2"]'),
    );
  });

  it('expands nothing when positioning at the first unread message', async () => {
    const { fixture } = await renderList({
      messages: many(10),
      firstUnreadId: '$6',
    });

    fixture.componentInstance.jumpToUnread();

    expect(TestBed.inject(ExpandedBodiesStore).expanded().size).toBe(0);
    expect(expand).not.toHaveBeenCalled();
  });
});
