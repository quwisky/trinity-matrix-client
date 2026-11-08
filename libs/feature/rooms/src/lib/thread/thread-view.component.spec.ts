import { inject, signal, type Provider } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import {
  TrnAlertService,
  TrnSurfaceService,
  TrnToastService,
  lastInputTarget,
} from '@trinity/components/overlay';
import { render } from '@trinity/testing';
import type {
  MediaTransferEvent,
  StagedMediaReference,
} from '@trinity/data-access/media';

// `isMobileOs` is a plain exported function, so the barrel is mocked and the rest passed
// through — the same shape `message-row.mobile.spec.ts` uses, and hoisted for the same reason.
const platform = vi.hoisted(() => ({ mobile: true }));

/**
 * Report the drawer breakpoint as matching, or not.
 *
 * Stubbed per test rather than once at module scope: the shared setup installs its own
 * `matchMedia` and would overwrite a module-level stub. `mediaQuerySignal` reads
 * `window.matchMedia` once at construction and then listens, so this has to be in place
 * before the component is built.
 */
function belowMembers(matches: boolean): void {
  vi.stubGlobal('matchMedia', () => ({
    matches,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

vi.mock('@trinity/platform-native', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@trinity/platform-native')>()),
  isMobileOs: () => platform.mobile,
}));
import {
  ConversationRuntime,
  TimelineActionsService,
  threadDraftKey,
  type ConversationThread,
  type MessageView,
  type ThreadSummary,
} from '@trinity/data-access/timeline';
import {
  type MemberSummary,
  RoomMembersService,
} from '@trinity/data-access/room-administration';
import { MockProvider } from 'ng-mocks';
import { DraftStoreService } from '@trinity/platform-native';
import {
  MessageGestureSettingsService,
  type SwipeAction,
} from '@trinity/platform-native';
import { Subject, of, throwError } from 'rxjs';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from 'vitest';
import { ThreadViewComponent } from './thread-view.component';
import {
  ConversationComposeStub,
  ConversationMessagesStub,
  ConversationTimelineStub,
} from '../testing/conversation-timeline.stub';
import { MessageListComponent } from '../message-list/message-list.component';
import { MESSAGE_LIST_COMMANDS } from '../message-list/message-list-commands';
import { ThreadCommands } from './thread-commands';
import { messageView } from '../testing/message-view.fixture';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import { MessageSourceComponent } from '../message-source/message-source.component';
import type { MessageRow } from '../message-row/message-row.component';
import { ExpandedBodiesStore } from '../rooms/expanded-bodies.store';
import { RoomShellStore } from '../rooms/room-shell-store';

function msg(id: string, senderId: string, body: string): MessageView {
  return messageView({
    id,
    senderId,
    senderName: senderId,
    senderInitial: senderId[1]?.toUpperCase() ?? '?',
    body,
  });
}

/** The composer this panel renders, for asserting what a quote put into it. */
function composerOf(
  fixture: ComponentFixture<ThreadViewComponent>,
): MessageComposerComponent {
  return fixture.debugElement.query(By.directive(MessageComposerComponent))
    .componentInstance as MessageComposerComponent;
}

/** The shared list this panel hosts. */
function listOf(
  fixture: ComponentFixture<ThreadViewComponent>,
): MessageListComponent {
  return fixture.debugElement.query(By.directive(MessageListComponent))
    .componentInstance as MessageListComponent;
}

function row(id: string, senderId: string, body: string): MessageRow {
  return { ...msg(id, senderId, body), showHeader: true };
}

function staged(id: string): StagedMediaReference {
  return {
    id,
    filename: `${id}.png`,
    mimeType: 'image/png',
    size: 1,
    previewUrl: null,
  } as StagedMediaReference;
}

async function build(
  messages: MessageView[] = [],
  state: {
    canPaginate?: boolean;
    pageRefused?: boolean;
    loadingOlder?: boolean;
    canRedactOthers?: boolean;
    canSendMessages?: boolean;
    typingNames?: string[];
  } = {},
  extraProviders: Provider[] = [],
) {
  const threadMessages = signal<MessageView[]>(messages);
  const threadSummaries = signal<Readonly<Record<string, ThreadSummary>>>({});
  const canPaginateThread = signal(state.canPaginate ?? false);
  const loadingOlderThread = signal(state.loadingOlder ?? false);
  /** The thread's oldest raw event, hidden ones included; null before any has loaded. */
  const oldestThreadEvent = signal<string | null>(null);
  const openThread = vi.fn();
  const closeThread = vi.fn();
  const paginateOpenThread = vi.fn().mockReturnValue(of(void 0));
  const sendToThread = vi.fn();
  const editInThread = vi.fn().mockReturnValue(of(void 0));
  const replyInThread = vi.fn().mockReturnValue(of(void 0));
  const toggleReactionInThread = vi.fn().mockReturnValue(of(void 0));
  const retryInThread = vi.fn().mockReturnValue(of(void 0));
  const redactInThread = vi.fn();
  const confirm$ = vi.fn(() => of(false));
  const sendMediaToThread = vi
    .fn()
    .mockReturnValue(of({ kind: 'sent' as const, eventId: '$media' }));
  const sentRoots = vi.fn();
  const releasedRoots = vi.fn();
  const toastShow = vi.fn();
  const sourceOpen = vi.fn();
  const setTypingCalls = vi.fn();
  // The thread composer's @-mention list comes from the room's member projection. The spec
  // supplied no RoomMembersService at all, so `return []` in the component went unnoticed — only
  // a `throw` failed, and that was the template crashing rather than an assertion.
  const roster = signal<readonly MemberSummary[]>([
    {
      userId: '@ada:hs',
      roomDisplayName: 'Ada',
      roomInitial: 'A',
      roomAvatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    },
  ]);
  const sheetClose = vi.fn();
  // `closed` too: the real `TrnDialogRef` has it, and the service subscribes to release
  // the dead ref. A stub missing part of the API turns a correct change into a red suite.
  const sheetOpen = vi.fn().mockReturnValue({
    close: sheetClose,
    closed: new Subject(),
    presentation: 'sheet',
    surface: null,
  });
  // The room's compose seam: a thread must never drive it.
  const roomCompose = new ConversationComposeStub();
  const roomMessages = new ConversationMessagesStub(roomCompose);
  const membersFor = vi.fn((roomId: string | null) =>
    roomId === '!r:hs'
      ? roster.asReadonly()
      : signal<readonly MemberSummary[]>([]).asReadonly(),
  );
  const rendered = await render(ThreadViewComponent, {
    inputs: { roomId: '!r:hs', rootEventId: '$root' },
    providers: [
      MockProvider(ConversationTimelineStub, {
        canRedactOthers: signal(state.canRedactOthers ?? false).asReadonly(),
        canSendMessages: signal(state.canSendMessages ?? true),
        // Seeded because it is an INSTANCE field, which ng-mocks does not reflect: left
        // out, `typingNames` is undefined and the typing row throws on every render here.
        typingNames: signal<string[]>(state.typingNames ?? []).asReadonly(),
        setTyping: setTypingCalls,
        rawEvent: vi.fn(() => ({ type: 'm.room.message' })),
        roomVia: vi.fn(() => ['hs']),
      }),
      {
        provide: ConversationRuntime,
        useFactory: () => {
          const applied = (operation: string) =>
            of({ kind: 'applied' as const, operation });
          return {
            timeline: inject(ConversationTimelineStub),
            compose: roomCompose,
            messages: roomMessages,
            threads: {
              summaries: threadSummaries.asReadonly(),
              forRoot: vi.fn((rootEventId: string) => {
                openThread('!r:hs', rootEventId);
                let released = false;
                return {
                  key: {
                    accountId: '@me:hs',
                    roomId: '!r:hs',
                    rootEventId,
                  },
                  messages: threadMessages.asReadonly(),
                  canLoadOlder: canPaginateThread.asReadonly(),
                  loadingOlder: loadingOlderThread.asReadonly(),
                  oldestEventId: oldestThreadEvent.asReadonly(),
                  media: { send: sendMediaToThread },
                  loadOlder: vi.fn(() => {
                    paginateOpenThread();
                    return state.pageRefused
                      ? of({
                          kind: 'rejected' as const,
                          operation: 'paginate' as const,
                          failure: 'request-rejected' as const,
                          retryable: true,
                        })
                      : applied('paginate');
                  }),
                  send: vi.fn((body: string, mentions: readonly unknown[]) => {
                    sentRoots(rootEventId);
                    return sendToThread(body, mentions) ?? applied('send');
                  }),
                  edit: vi.fn(
                    (
                      id: string,
                      body: string,
                      mentions: readonly unknown[],
                    ) => {
                      editInThread(id, body, mentions);
                      return applied('edit');
                    },
                  ),
                  reply: vi.fn(
                    (
                      id: string,
                      body: string,
                      mentions: readonly unknown[],
                    ) => {
                      replyInThread(id, body, mentions);
                      return applied('reply');
                    },
                  ),
                  toggleReaction: vi.fn((id: string, reaction: string) => {
                    toggleReactionInThread(id, reaction);
                    return applied('reaction');
                  }),
                  redact: vi.fn((id: string) => {
                    redactInThread(id);
                    return applied('redaction');
                  }),
                  retry: vi.fn((id: string) => {
                    retryInThread(id);
                    return applied('retry');
                  }),
                  release: vi.fn(() => {
                    if (released) return;
                    released = true;
                    releasedRoots(rootEventId);
                    closeThread();
                  }),
                } as unknown as ConversationThread;
              }),
            },
          };
        },
      },
      MockProvider(TimelineActionsService),
      MockProvider(RoomMembersService, { membersFor }),
      MockProvider(TrnSurfaceService, {
        open: sourceOpen,
        openActions: sheetOpen,
      }),
      MockProvider(TrnAlertService, { confirm$ }),
      MockProvider(TrnToastService, { show: toastShow }),
      // Seeded to a real direction. Left unprovided, the root service returns its `off`
      // default and every assertion below reads the value the guards would have produced
      // anyway — which is how three of these tests passed with both guards deleted.
      MockProvider(MessageGestureSettingsService, {
        messageSwipe: signal<SwipeAction>('right').asReadonly(),
      }),
      ...extraProviders,
    ],
  });
  const { fixture, container } = rendered;
  /** How many times the panel announced a close, for the dismissal assertions. */
  let dismissals = 0;
  fixture.componentInstance.dismissed.subscribe(() => (dismissals += 1));
  return {
    fixture,
    container,
    queryByRole: rendered.queryByRole,
    threadMessages,
    roster,
    sheetOpen,
    sheetClose,
    membersFor,
    canPaginateThread,
    loadingOlderThread,
    oldestThreadEvent,
    openThread,
    closeThread,
    paginateOpenThread,
    sendToThread,
    editInThread,
    replyInThread,
    toggleReactionInThread,
    retryInThread,
    redactInThread,
    confirm$,
    sendMediaToThread,
    sentRoots,
    releasedRoots,
    toastShow,
    sourceOpen,
    setTypingCalls,
    roomCompose,
    roomMessages,
    dismissals: () => dismissals,
  };
}

describe('ThreadViewComponent hosts the message list', () => {
  /** Run the list's deferred frames now, as a settled render would. */
  function settle(fixture: ComponentFixture<ThreadViewComponent>): void {
    TestBed.tick();
    fixture.detectChanges();
  }
  const three = [
    msg('$root', '@a:hs', 'the root'),
    msg('$r1', '@b:hs', 'one'),
    msg('$r2', '@b:hs', 'two'),
  ];

  it('renders replies through trn-message-list', async () => {
    const { fixture, container, threadMessages } = await build(three, {
      canPaginate: true,
      loadingOlder: true,
    });
    const list = listOf(fixture);

    expect(container.querySelectorAll('trn-message-list')).toHaveLength(1);
    expect(list.messages()).toBe(threadMessages());
    expect(list.loadingOlder()).toBe(true);
    expect(list.canLoadOlder()).toBe(true);
    expect(list.composerEnabled()).toBe(false);
    const composers = container.querySelectorAll('trn-message-composer');
    expect(composers).toHaveLength(1);
    expect(composers[0].closest('trn-message-list')).toBeNull();
    expect(
      container
        .querySelector('trn-message-list')!
        .compareDocumentPosition(composers[0]) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('has no Load older replies button', async () => {
    const { queryByRole } = await build(three, { canPaginate: true });

    expect(queryByRole('button', { name: 'Load older replies' })).toBeNull();
  });

  it('a short thread does not page', async () => {
    const { fixture, paginateOpenThread } = await build(three, {
      canPaginate: false,
    });
    settle(fixture);
    await fixture.whenStable();

    expect(paginateOpenThread).not.toHaveBeenCalled();
  });

  it('keeps filling a short thread as older replies land', async () => {
    // A short panel: jsdom reports no scroll height, so the list is never full. The fill
    // frame is queued and run by hand, the way the list's own fill tests do.
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frames.push(cb);
      return frames.length;
    });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const runFrames = () => {
      for (const frame of frames.splice(0)) frame(0);
    };
    const root = msg('$root', '@a:hs', 'the root');
    const { fixture, threadMessages, oldestThreadEvent, paginateOpenThread } =
      await build([root, msg('$r3', '@b:hs', 'three')], { canPaginate: true });
    oldestThreadEvent.set('$r3');
    settle(fixture);
    runFrames();
    expect(paginateOpenThread).toHaveBeenCalledTimes(1);

    // The page lands: the replies and the thread's oldest raw event both move.
    oldestThreadEvent.set('$r2');
    threadMessages.set([
      root,
      msg('$r2', '@b:hs', 'two'),
      msg('$r3', '@b:hs', 'three'),
    ]);
    settle(fixture);
    runFrames();

    expect(paginateOpenThread).toHaveBeenCalledTimes(2);
  });

  describe('a short thread that must page', () => {
    /** Queue the list's fill frames to run by hand: jsdom reports no height, so never full. */
    function queueFrames() {
      const frames: FrameRequestCallback[] = [];
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        frames.push(cb);
        return frames.length;
      });
      onTestFinished(() => {
        vi.unstubAllGlobals();
      });
      return () => {
        for (const frame of frames.splice(0)) frame(0);
      };
    }

    it('asks for a page when only the root has loaded', async () => {
      const runFrames = queueFrames();
      const { fixture, paginateOpenThread } = await build(
        [msg('$root', '@a:hs', 'the root')],
        { canPaginate: true },
      );
      settle(fixture);
      runFrames();

      expect(paginateOpenThread).toHaveBeenCalledTimes(1);
    });

    it('keeps filling after a page that brought only hidden events', async () => {
      const runFrames = queueFrames();
      const replies = [
        msg('$root', '@a:hs', 'the root'),
        msg('$r3', '@b:hs', 'three'),
      ];
      const { fixture, threadMessages, oldestThreadEvent, paginateOpenThread } =
        await build(replies, { canPaginate: true });
      oldestThreadEvent.set('$r3');
      settle(fixture);
      runFrames();
      expect(paginateOpenThread).toHaveBeenCalledTimes(1);

      // An edit paged in: no reply is new, but the raw oldest event moved.
      oldestThreadEvent.set('$edit');
      threadMessages.set([...replies]);
      settle(fixture);
      runFrames();

      expect(paginateOpenThread).toHaveBeenCalledTimes(2);
    });
  });

  it("loads older on the list's loadOlder", async () => {
    const { fixture, paginateOpenThread } = await build(three, {
      canPaginate: true,
    });
    paginateOpenThread.mockClear();

    listOf(fixture).loadOlder.emit();

    expect(paginateOpenThread).toHaveBeenCalledTimes(1);
  });

  it('hides thread, pin and unread', async () => {
    const { fixture, container } = await build(three);
    const list = listOf(fixture);

    for (const r of list.rows()) {
      expect(list.rowCaps(r).canThread).toBe(false);
      expect(list.rowCaps(r).canPin).toBe(false);
    }
    expect(list.firstUnreadId()).toBeNull();
    expect(
      container.querySelector('[data-testid="new-messages-divider"]'),
    ).toBeNull();
  });

  it('shows day dividers', async () => {
    const day = (id: string, date: number) => ({
      ...msg(id, '@a:hs', id),
      timestamp: new Date(2026, 6, date, 9).getTime(),
    });
    const { container } = await build([day('$a', 20), day('$b', 21)]);

    expect(container.querySelectorAll('trn-timeline-divider')).toHaveLength(1);
  });

  it('asks before deleting', async () => {
    const { fixture, confirm$, redactInThread } = await build([
      { ...msg('$1', '@me:hs', 'mine'), isOwn: true },
    ]);
    const commands = fixture.debugElement.injector.get(ThreadCommands);
    const del = vi.spyOn(commands, 'delete');
    const list = listOf(fixture);

    confirm$.mockReturnValueOnce(of(false));
    list.onRowAction(list.rows()[0], { type: 'delete' });
    expect(del).not.toHaveBeenCalled();

    confirm$.mockReturnValueOnce(of(true));
    list.onRowAction(list.rows()[0], { type: 'delete' });
    expect(confirm$).toHaveBeenCalledTimes(2);
    expect(del).toHaveBeenCalledExactlyOnceWith('$1');
    expect(redactInThread).toHaveBeenCalledExactlyOnceWith('$1');
  });

  it('quotes into the thread composer', async () => {
    const { fixture } = await build([
      { ...msg('$1', '@me:hs', 'mine'), isOwn: true },
    ]);
    const commands = fixture.debugElement.injector.get(ThreadCommands);
    const list = listOf(fixture);
    list.startEdit(list.rows()[0]);
    fixture.detectChanges();

    list.onRowAction(list.rows()[0], { type: 'quote' });
    fixture.detectChanges();
    await Promise.resolve();

    expect(composerOf(fixture).text()).toBe('> mine\n\n');
    expect(commands.editingId()).toBeNull();
  });

  it('shows no drop overlay over the replies while a reply is being edited', async () => {
    const { fixture, container } = await build([
      { ...msg('$1', '@me:hs', 'mine'), isOwn: true },
    ]);
    const list = listOf(fixture);
    const enter = () => {
      const event = new Event('dragenter', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], files: [], dropEffect: 'none' },
      });
      container.querySelector('trn-message-list')!.dispatchEvent(event);
      fixture.detectChanges();
    };
    enter();
    // The control: a drag over the replies does raise it.
    expect(container.querySelector('trn-drop-overlay')).not.toBeNull();
    container
      .querySelector('trn-message-list')!
      .dispatchEvent(new Event('dragleave'));

    list.startEdit(list.rows()[0]);
    fixture.detectChanges();
    enter();

    expect(container.querySelector('trn-drop-overlay')).toBeNull();
  });

  it('stages files dropped on the replies into the thread composer', async () => {
    const { fixture, container } = await build(three);
    const stage = vi.spyOn(composerOf(fixture), 'stageFiles');
    const file = new File(['x'], 'a.png', { type: 'image/png' });
    const event = new Event('drop', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
      value: { types: ['Files'], files: [file], dropEffect: 'none' },
    });

    container.querySelector('trn-message-list')!.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(stage).toHaveBeenCalledExactlyOnceWith([file]);
  });

  it('passes on a matrix.to link clicked in a reply', async () => {
    const { fixture } = await build(three);
    const links: unknown[] = [];
    fixture.componentInstance.matrixLink.subscribe((click) =>
      links.push(click),
    );
    const click = { target: { kind: 'invalid' as const } };

    listOf(fixture).matrixLink.emit(click);

    expect(links).toEqual([click]);
  });

  it('editing a thread reply leaves the room composer alone', async () => {
    const { fixture, roomCompose, roomMessages } = await build([
      { ...msg('$1', '@me:hs', 'mine'), isOwn: true },
    ]);
    const commands = fixture.debugElement.injector.get(ThreadCommands);
    const startEdit = vi.spyOn(commands, 'startEdit');
    const roomEdit = vi.spyOn(roomMessages, 'beginEdit');
    const list = listOf(fixture);

    list.startEdit(list.rows()[0]);

    expect(startEdit).toHaveBeenCalledExactlyOnceWith('$1');
    expect(roomEdit).not.toHaveBeenCalled();
    expect(roomCompose.intent()).toEqual({ kind: 'message' });
  });

  it('thread provider routes edit/reply/cancel to ThreadCommands', async () => {
    const { fixture } = await build(three);
    const thread = fixture.debugElement.injector.get(ThreadCommands);
    const seam = fixture.debugElement
      .query(By.directive(MessageListComponent))
      .injector.get(MESSAGE_LIST_COMMANDS);

    seam.beginEdit('$r1', 'one');
    expect(thread.editingId()).toBe('$r1');
    expect(seam.editingId()).toBe('$r1');
    seam.cancelEdit();
    expect(thread.editingId()).toBeNull();

    seam.beginReply('$r2');
    expect(thread.replyingToId()).toBe('$r2');
    expect(seam.replyingToId()).toBe('$r2');
    seam.cancelReply();
    expect(thread.replyingToId()).toBeNull();

    expect(seam.sending).toBe(thread.sending);
  });

  it('reveal pages then jumps once', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => {
      delete (Element.prototype as Partial<Element>).scrollIntoView;
    });
    const a = msg('$a', '@a:hs', 'first');
    const b = msg('$b', '@a:hs', 'second');
    const {
      fixture,
      container,
      threadMessages,
      canPaginateThread,
      paginateOpenThread,
    } = await build([b], { canPaginate: true });
    const failed = vi.fn();
    fixture.componentInstance.revealFailed.subscribe(failed);
    const list = listOf(fixture);
    const nonce = list.jumpToNonce();

    fixture.componentRef.setInput('revealEventId', '$a');
    settle(fixture);
    expect(paginateOpenThread).toHaveBeenCalled();
    expect(list.jumpToId()).toBeNull();

    threadMessages.set([a, b]);
    canPaginateThread.set(false);
    settle(fixture);
    expect(list.jumpToId()).toBe('$a');
    expect(list.jumpToNonce()).toBe(nonce + 1);
    await fixture.whenStable();
    expect(scrollIntoView.mock.contexts.at(-1)).toBe(
      container.querySelector('[data-mid="$a"]'),
    );

    threadMessages.set([a, b, msg('$c', '@a:hs', 'third')]);
    settle(fixture);
    expect(list.jumpToNonce()).toBe(nonce + 1);
    expect(failed).not.toHaveBeenCalled();
  });

  it('switching threads resets the list', async () => {
    const { fixture, container, threadMessages } = await build(three);
    const list = listOf(fixture);
    const key = list.resetKey();
    threadMessages.set([...three, msg('$r3', '@b:hs', 'three')]);
    settle(fixture);
    expect(container.querySelector('.msg-enter')).not.toBeNull();

    fixture.componentRef.setInput('rootEventId', '$next');
    settle(fixture);

    expect(listOf(fixture)).toBe(list);
    expect(list.resetKey()).not.toBe(key);
    expect(list.roomId()).toBe('!r:hs');
    expect(container.querySelector('.msg-enter')).toBeNull();
  });
});

describe('ThreadViewComponent reveal', () => {
  async function revealing(
    messages: MessageView[],
    state: Parameters<typeof build>[1] = {},
  ) {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const built = await build(messages, state);
    const settle = (): void => {
      TestBed.tick();
      built.fixture.detectChanges();
    };
    const reveal = (id: string): void => {
      built.fixture.componentRef.setInput('revealEventId', id);
      settle();
    };
    return { ...built, scrollIntoView, settle, reveal };
  }
  const a = msg('$a', '@a:hs', 'first');
  const b = msg('$b', '@a:hs', 'second');

  it('scrolls nothing without a message to reveal', async () => {
    const { settle, scrollIntoView } = await revealing([a, b]);
    settle();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('scrolls to the message, on the row it asked for', async () => {
    const { reveal, scrollIntoView, container } = await revealing([a, b]);

    reveal('$a');

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(
      container.querySelector('[data-mid="$a"]'),
    );
  });

  it('waits for the row, rendered, when the message comes later', async () => {
    const {
      reveal,
      settle,
      threadMessages,
      scrollIntoView,
      container,
      paginateOpenThread,
    } = await revealing([a]);

    reveal('$b');
    expect(scrollIntoView).not.toHaveBeenCalled();
    expect(paginateOpenThread).not.toHaveBeenCalled();

    threadMessages.set([a, b]);
    settle();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(
      container.querySelector('[data-mid="$b"]'),
    );
  });

  it('scrolls again when the same message is requested again', async () => {
    const { reveal, settle, fixture, scrollIntoView } = await revealing([a, b]);
    const request = (key: object): void => {
      fixture.componentRef.setInput('revealRequest', key);
      settle();
    };

    request({});
    reveal('$a');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    request({});
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('reveals only once, however the rows change after', async () => {
    const { reveal, settle, threadMessages, scrollIntoView } = await revealing([
      a,
    ]);

    reveal('$a');
    threadMessages.set([a, b]);
    settle();

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('moves to another message when asked', async () => {
    const { reveal, scrollIntoView } = await revealing([a, b]);

    reveal('$a');
    reveal('$b');

    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('pages older replies until the message is there', async () => {
    const {
      reveal,
      settle,
      threadMessages,
      paginateOpenThread,
      loadingOlderThread,
      canPaginateThread,
      scrollIntoView,
    } = await revealing([b], { canPaginate: true });

    reveal('$a');
    expect(paginateOpenThread).toHaveBeenCalledTimes(1);

    loadingOlderThread.set(true);
    settle();
    expect(paginateOpenThread).toHaveBeenCalledTimes(1);

    loadingOlderThread.set(false);
    settle();
    expect(paginateOpenThread).toHaveBeenCalledTimes(2);

    threadMessages.set([a, b]);
    canPaginateThread.set(false);
    settle();

    expect(paginateOpenThread).toHaveBeenCalledTimes(2);
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('pages nothing for a message already there', async () => {
    const { reveal, paginateOpenThread } = await revealing([a, b], {
      canPaginate: true,
    });

    reveal('$a');

    expect(paginateOpenThread).not.toHaveBeenCalled();
  });

  it('says so once when the history runs out without the message', async () => {
    const { fixture, reveal, settle, threadMessages, canPaginateThread } =
      await revealing([b], { canPaginate: true });
    const failed = vi.fn();
    fixture.componentInstance.revealFailed.subscribe(failed);

    reveal('$a');
    expect(failed).not.toHaveBeenCalled();
    canPaginateThread.set(false);
    settle();
    expect(failed).toHaveBeenCalledTimes(1);

    threadMessages.set([b, msg('$c', '@a:hs', 'third')]);
    settle();
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('does not fail a reveal while only the root has loaded', async () => {
    const { fixture, reveal } = await revealing([msg('$root', '@a:hs', 'r')]);
    const failed = vi.fn();
    fixture.componentInstance.revealFailed.subscribe(failed);

    reveal('$a');

    expect(failed).not.toHaveBeenCalled();
  });

  it('stops paging, and says so, when a page is refused', async () => {
    const { fixture, reveal, settle, paginateOpenThread, loadingOlderThread } =
      await revealing([b], { canPaginate: true, pageRefused: true });
    const failed = vi.fn();
    fixture.componentInstance.revealFailed.subscribe(failed);

    reveal('$a');
    loadingOlderThread.set(true);
    settle();
    loadingOlderThread.set(false);
    settle();

    expect(failed).toHaveBeenCalledTimes(1);
    expect(paginateOpenThread).toHaveBeenCalledTimes(1);
  });
});

describe('ThreadViewComponent', () => {
  // A thread closed with a press on its close button left the CDK's input-modality detector
  // holding that button, and through it the whole detached panel (#1361).
  it('lets go of the last pressed element inside it when it closes', async () => {
    const { fixture } = await build();
    const close = (fixture.nativeElement as HTMLElement).querySelector(
      'button[aria-label="Close thread"]',
    ) as HTMLButtonElement;
    const last = () => TestBed.runInInjectionContext(lastInputTarget);
    close.dispatchEvent(
      new MouseEvent('mousedown', { bubbles: true, buttons: 1, detail: 1 }),
    );
    expect(last()).toBe(close);

    fixture.destroy();

    expect(last()).toBeNull();
  });

  it('marks its named close button as the panel focus target', async () => {
    const { container } = await build();

    const targets = container.querySelectorAll('[data-right-panel-focus]');
    expect(targets).toHaveLength(1);
    expect(targets[0].tagName).toBe('BUTTON');
    expect(targets[0].getAttribute('aria-label')).toBe('Close thread');
  });

  it('opens the thread on init with its room and root ids', async () => {
    const { openThread } = await build();

    expect(openThread).toHaveBeenCalledWith('!r:hs', '$root');
  });

  it('shows its loading state, opening nothing, until its root has loaded', async () => {
    const { fixture, container, openThread, releasedRoots } = await build();
    openThread.mockClear();
    fixture.componentRef.setInput('rootEventId', '$cold');
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();

    const loadingState = () =>
      container.querySelector('[data-testid="side-panel-loading"]');
    expect(loadingState()?.getAttribute('aria-label')).toBe('Loading thread');
    expect(container.textContent).not.toContain('No replies yet');
    expect(openThread).not.toHaveBeenCalled();
    expect(releasedRoots).toHaveBeenCalledWith('$root');

    fixture.componentRef.setInput('loading', false);
    fixture.detectChanges();
    expect(loadingState()).toBeNull();
    expect(openThread).toHaveBeenCalledWith('!r:hs', '$cold');
  });

  it('keeps a reply typed while the thread loads, sending nothing until it has', async () => {
    const { fixture, container, sendToThread } = await build();
    fixture.componentRef.setInput('loading', true);
    fixture.detectChanges();
    const field = container.querySelector<HTMLTextAreaElement>(
      '[data-testid="composer-input"]',
    )!;
    field.value = 'early reply';
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    composerOf(fixture).submit();
    fixture.detectChanges();

    expect(sendToThread).not.toHaveBeenCalled();
    expect(field.value).toBe('early reply');
  });

  it('releases and replaces the exact child when the mounted panel changes roots', async () => {
    const { fixture, openThread, releasedRoots, sentRoots } = await build();

    fixture.componentRef.setInput('rootEventId', '$next');
    fixture.detectChanges();

    expect(releasedRoots).toHaveBeenCalledWith('$root');
    expect(openThread).toHaveBeenLastCalledWith('!r:hs', '$next');

    fixture.componentInstance.onSubmit({ text: 'new root', mentions: [] });
    expect(sentRoots).toHaveBeenLastCalledWith('$next');
  });

  it('renders the thread messages as rows', async () => {
    const { container } = await build([
      msg('$root', '@a:hs', 'the root'),
      msg('$r1', '@b:hs', 'a reply'),
    ]);

    expect(container.querySelectorAll('.msg').length).toBe(2);
    expect(container.textContent).toContain('the root');
    expect(container.textContent).toContain('a reply');
  });

  it('keeps the header on a reply that continues the same sender', async () => {
    const { container } = await build([
      msg('$root', '@a:hs', 'the root'),
      {
        // Same sender and timestamp as the prior message → would group as a
        // continuation, but a reply must keep its own author + avatar.
        ...msg('$r1', '@a:hs', 'a reply'),
        replyTo: {
          id: '$root',
          senderName: '@b:hs',
          senderInitial: 'B',
          senderAvatarMxc: null,
          body: 'the root',
          shield: null,
        },
      },
    ]);

    const rows = container.querySelectorAll('.msg');
    expect(rows.length).toBe(2);
    expect(container.querySelectorAll('.msg__avatar').length).toBe(2);
    expect(container.querySelectorAll('.msg--cont').length).toBe(0);
    expect(rows[1].querySelector('.msg__author')).toBeTruthy();
    expect(rows[1].querySelector('.msg__reply')).toBeTruthy();
  });

  it('shows an empty state when the thread has no messages', async () => {
    const { container } = await build([]);

    expect(
      container.querySelector('trn-side-panel-empty h3')?.textContent,
    ).toBe('No replies yet');
  });

  it('announces a dismissal on close', async () => {
    const { fixture, dismissals } = await build();

    fixture.componentInstance.close();
    expect(dismissals()).toBe(1);
  });

  it('closes the thread projection when destroyed', async () => {
    const { fixture, closeThread } = await build();

    fixture.destroy();
    expect(closeThread).toHaveBeenCalled();
  });

  it('sends a new message into the thread when nothing is being edited/replied', async () => {
    const { fixture, sendToThread, editInThread, replyInThread } =
      await build();

    fixture.componentInstance.onSubmit({ text: 'hello thread', mentions: [] });

    expect(sendToThread).toHaveBeenCalledWith('hello thread', []);
    expect(editInThread).not.toHaveBeenCalled();
    expect(replyInThread).not.toHaveBeenCalled();
  });

  it('toasts when the thread rejects a submit', async () => {
    const { fixture, sendToThread, toastShow } = await build();
    sendToThread.mockReturnValueOnce(of({ kind: 'rejected' }));

    fixture.componentInstance.onSubmit({ text: 'hello thread', mentions: [] });

    expect(toastShow).toHaveBeenCalledWith('Could not send the message.', {
      duration: 4000,
      variant: 'danger',
    });
  });

  it('routes a submit to an edit while editing, then leaves edit mode', async () => {
    const { fixture, editInThread, sendToThread } = await build([
      msg('$r1', '@me:hs', 'typo'),
    ]);
    const cmp = fixture.componentInstance;

    listOf(fixture).startEdit(row('$r1', '@me:hs', 'typo'));
    cmp.onSubmit({ text: 'fixed', mentions: [] });

    expect(editInThread).toHaveBeenCalledWith('$r1', 'fixed', []);
    expect(sendToThread).not.toHaveBeenCalled();
    expect(cmp.editingId()).toBeNull();
  });

  it('routes a submit to a reply while replying, then clears the reply target', async () => {
    const { fixture, replyInThread, sendToThread } = await build([
      msg('$r1', '@b:hs', 'a reply'),
    ]);
    const cmp = fixture.componentInstance;

    listOf(fixture).startReply(row('$r1', '@b:hs', 'a reply'));
    cmp.onSubmit({ text: 'replying', mentions: [] });

    expect(replyInThread).toHaveBeenCalledWith('$r1', 'replying', []);
    expect(sendToThread).not.toHaveBeenCalled();
    expect(cmp.replyingToId()).toBeNull();
  });

  it('keeps a thread\u2019s draft when the thread changes mid-edit', async () => {
    const { fixture } = await build([msg('$r1', '@me:hs', 'mine')]);
    const store = TestBed.inject(DraftStoreService);
    composerOf(fixture).text.set('draft A');
    fixture.detectChanges();

    listOf(fixture).startEdit(row('$r1', '@me:hs', 'mine'));
    fixture.detectChanges();
    expect(composerOf(fixture).text()).toBe('mine');

    fixture.componentRef.setInput('rootEventId', '$other');
    fixture.detectChanges();
    expect(store.get('$root')).toBe('draft A');

    fixture.componentRef.setInput('rootEventId', '$root');
    fixture.detectChanges();
    expect(composerOf(fixture).text()).toBe('draft A');
    expect(store.get('$root')).toBe('draft A');
  });

  // A session handover writes unsent thread replies under `threadDraftKey` (#1267).
  it('opens a thread with the draft stored under its thread draft key', async () => {
    const { fixture } = await build();
    const store = TestBed.inject(DraftStoreService);
    fixture.componentRef.setInput('rootEventId', '$other');
    fixture.detectChanges();

    store.set(threadDraftKey('$root'), 'not sent before the handover');
    fixture.componentRef.setInput('rootEventId', '$root');
    fixture.detectChanges();

    expect(composerOf(fixture).text()).toBe('not sent before the handover');
  });

  it('quotes a thread message into the thread’s own composer', async () => {
    const { fixture } = await build([msg('$r1', '@b:hs', 'a reply')]);

    listOf(fixture).onRowAction(row('$r1', '@b:hs', 'a reply'), {
      type: 'quote',
    });

    // The thread panel has its own composer; a quote raised here must not reach the
    // room's.
    expect(composerOf(fixture).text()).toBe('> a reply\n\n');
  });

  it('keeps a thread quote that interrupts an edit', async () => {
    // Same ordering trap as the room list: the composer restores its draft when it leaves
    // edit mode, and that restore would land after a same-tick insert.
    const { fixture } = await build([msg('$r1', '@me:hs', 'mine')]);
    const list = listOf(fixture);

    list.startEdit(row('$r1', '@me:hs', 'mine'));
    fixture.detectChanges();

    list.startQuote(row('$r1', '@me:hs', 'mine'));
    fixture.detectChanges();
    await Promise.resolve();

    expect(composerOf(fixture).text()).toBe('> mine\n\n');
  });

  it('toggles a reaction on a thread message', async () => {
    const { fixture, toggleReactionInThread } = await build([
      msg('$r1', '@b:hs', 'a reply'),
    ]);

    fixture.componentInstance.onReact('$r1', '👍');

    expect(toggleReactionInThread).toHaveBeenCalledWith('$r1', '👍');
  });

  it('retries a failed thread message', async () => {
    const { fixture, retryInThread } = await build();

    fixture.componentInstance.onRetry('$echo');

    expect(retryInThread).toHaveBeenCalledWith('$echo');
  });

  it('copies a matrix.to permalink for a thread message', async () => {
    const { fixture } = await build([msg('$r1', '@b:hs', 'a reply')]);
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });

    listOf(fixture).onRowAction(row('$r1', '@b:hs', 'a reply'), {
      type: 'copy-link',
    });

    // The bare room id: the list resets per thread on its own key, not a widened room id.
    expect(writeText).toHaveBeenCalledWith(
      expect.stringMatching(/^https:\/\/matrix\.to\/#\/(!|%21)r(:|%3A)hs\//),
    );
  });

  it('opens the raw source for a thread message', async () => {
    const { fixture, sourceOpen } = await build([
      msg('$r1', '@b:hs', 'a reply'),
    ]);

    listOf(fixture).onRowAction(row('$r1', '@b:hs', 'a reply'), {
      type: 'view-source',
    });

    expect(sourceOpen).toHaveBeenCalledWith(
      MessageSourceComponent,
      expect.objectContaining({ inputs: { source: expect.any(String) } }),
    );
  });

  it('replaces the thread composer with the notice when posting is unavailable', async () => {
    const { container } = await build([], { canSendMessages: false });

    expect(
      container.querySelector('[data-testid="composer-post-unavailable"]')
        ?.textContent,
    ).toContain("You don't have permission to send messages in this room.");
    expect(
      container.querySelector('[data-testid="composer-input"]'),
    ).toBeNull();
  });

  it('lets a moderator delete another member’s thread message', async () => {
    const { fixture } = await build([msg('$1', '@a:hs', 'hi')], {
      canRedactOthers: true,
    });
    const target = { ...msg('$1', '@a:hs', 'hi'), showHeader: true };

    expect(listOf(fixture).rowCaps(target).deletable).toBe(true);
  });

  it('does not let a regular member delete others’ thread messages', async () => {
    const { fixture } = await build([msg('$1', '@a:hs', 'hi')], {
      canRedactOthers: false,
    });
    const target = { ...msg('$1', '@a:hs', 'hi'), showHeader: true };

    expect(listOf(fixture).rowCaps(target).deletable).toBe(false);
  });

  it('deletes a thread message only after a reactive confirmation', async () => {
    const { fixture, confirm$, redactInThread } = await build([
      msg('$1', '@me:hs', 'mine'),
    ]);
    const target = row('$1', '@me:hs', 'mine');

    confirm$.mockReturnValueOnce(of(false));
    listOf(fixture).onDelete(target);
    expect(redactInThread).not.toHaveBeenCalled();

    confirm$.mockReturnValueOnce(of(true));
    listOf(fixture).onDelete(target);
    expect(redactInThread).toHaveBeenCalledWith('$1');
  });

  it('tells the list while older replies load', async () => {
    const { fixture, loadingOlderThread } = await build([], {
      loadingOlder: true,
    });
    expect(listOf(fixture).loadingOlder()).toBe(true);

    loadingOlderThread.set(false);
    fixture.detectChanges();
    expect(listOf(fixture).loadingOlder()).toBe(false);
  });

  it('tells the list whether older history remains', async () => {
    const { fixture, canPaginateThread } = await build([], {
      canPaginate: false,
    });
    expect(listOf(fixture).canLoadOlder()).toBe(false);

    canPaginateThread.set(true);
    fixture.detectChanges();
    expect(listOf(fixture).canLoadOlder()).toBe(true);
  });

  it('starts a reply preview’s target expanded, and scrolls after it renders', async () => {
    const scrollIntoViewOwn = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView',
    );
    onTestFinished(() => {
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
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const expand = vi.spyOn(ExpandedBodiesStore.prototype, 'expand');
    onTestFinished(() => expand.mockRestore());
    const { fixture, container } = await build(
      [msg('$a', '@a:hs', 'first'), msg('$b', '@a:hs', 'second')],
      {},
      [
        ExpandedBodiesStore,
        MockProvider(RoomShellStore, {
          activeAccountId: signal<string | null>('@me:hs'),
          activeRoomId: signal<string | null>('!r:hs'),
        }),
      ],
    );

    listOf(fixture).onRowAction(row('$b', '@a:hs', 'second'), {
      type: 'jump',
      id: '$a',
    });

    expect(TestBed.inject(ExpandedBodiesStore).isExpanded('$a')).toBe(true);
    // The thread has no re-aim after a measurement, so it must not scroll to the collapsed row.
    expect(scrollIntoView).not.toHaveBeenCalled();
    await fixture.whenStable();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
    expect(scrollIntoView.mock.contexts[0]).toBe(
      container.querySelector('[data-mid="$a"]'),
    );
    expect(expand.mock.invocationCallOrder[0]).toBeLessThan(
      scrollIntoView.mock.invocationCallOrder[0],
    );
  });

  // The list brings a focused control into view when the row holding it grows, as when
  // keyboard focus expands a collapsed reply; its own spec covers the cases it leaves alone.
  describe('keyboard focus in a collapsed reply', () => {
    async function growWithFocus(keyboard: boolean) {
      const { container } = await build([msg('$a', '@a:hs', 'first')]);
      const reply = container.querySelector('[data-mid="$a"]') as HTMLElement;
      const observer = (
        ResizeObserver as unknown as {
          instances: {
            observed: Set<Element>;
            emit(entries: ResizeObserverEntry[]): void;
          }[];
        }
      ).instances.find((o) => o.observed.has(reply));
      if (!observer) throw new Error('reply is not observed');
      const grow = (height: number) =>
        observer.emit([
          {
            target: reply,
            borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
            contentRect: { height },
          } as unknown as ResizeObserverEntry,
        ]);
      grow(100);
      const clamp = document.createElement('div');
      clamp.className = 'msg__clamp msg__clamp--collapsed';
      const link = document.createElement('a');
      link.href = 'https://example.org/';
      clamp.append(link);
      reply.append(clamp);
      link.scrollIntoView = vi.fn();
      // jsdom's own :focus-visible depends on earlier tests' input.
      const matches = link.matches.bind(link);
      vi.spyOn(link, 'matches').mockImplementation((selector) =>
        selector === ':focus-visible' ? keyboard : matches(selector),
      );
      link.focus();
      grow(900);
      return link;
    }

    it('brings the focused control into view once the reply has expanded', async () => {
      const link = await growWithFocus(true);

      expect(link.scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ block: 'nearest' }),
      );
    });

    it('leaves pointer focus in a collapsed reply alone', async () => {
      const link = await growWithFocus(false);

      expect(link.scrollIntoView).not.toHaveBeenCalled();
    });
  });

  describe('aiming at a jump target', () => {
    const scrollIntoViewOwn = Object.getOwnPropertyDescriptor(
      Element.prototype,
      'scrollIntoView',
    );
    afterEach(() => {
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

    /** Jump from `$b` to `$a`, with `$a` laid out `rowHeight` tall in a 600px thread. */
    async function jumpWithRowHeight(rowHeight: number) {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView;
      const { fixture, container } = await build([
        msg('$a', '@a:hs', 'first'),
        msg('$b', '@a:hs', 'second'),
      ]);
      const scroller = container.querySelector('[data-message-scroller]');
      if (!scroller) throw new Error('no message scroller');
      Object.defineProperty(scroller, 'clientHeight', {
        value: 600,
        configurable: true,
      });
      const target = container.querySelector('[data-mid="$a"]');
      if (!target) throw new Error('no target row');
      vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 400,
        bottom: rowHeight,
        width: 400,
        height: rowHeight,
      } as DOMRect);

      listOf(fixture).onRowAction(row('$b', '@a:hs', 'second'), {
        type: 'jump',
        id: '$a',
      });
      return scrollIntoView;
    }

    it('aligns a target taller than the thread by its top', async () => {
      const scrollIntoView = await jumpWithRowHeight(2000);

      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ block: 'start' }),
      );
    });

    it('still centres a target that fits in the thread', async () => {
      const scrollIntoView = await jumpWithRowHeight(120);

      expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ block: 'center' }),
      );
    });
  });
});

describe('ThreadViewComponent members', () => {
  it('hands the composer the room\u2019s own live member list', async () => {
    const { fixture, roster, membersFor } = await build([]);
    const composer = () =>
      fixture.debugElement.query(By.directive(MessageComposerComponent))
        .componentInstance as MessageComposerComponent;

    expect(membersFor).toHaveBeenCalledWith('!r:hs');
    expect(
      composer()
        .members()
        .map((m) => m.userId),
    ).toEqual(['@ada:hs']);

    roster.set([
      {
        userId: '@ada:hs',
        roomDisplayName: 'Ada',
        roomInitial: 'A',
        roomAvatarMxc: null,
        powerLevel: 0,
        isCreator: false,
      },
      {
        userId: '@bo:hs',
        roomDisplayName: 'Bo',
        roomInitial: 'B',
        roomAvatarMxc: null,
        powerLevel: 0,
        isCreator: false,
      },
    ]);
    fixture.detectChanges();

    expect(
      composer()
        .members()
        .map((m) => m.userId),
    ).toEqual(['@ada:hs', '@bo:hs']);
  });

  it('abandons the rest of a batch when the open thread changes under it', () => {
    // Same exposure as the room path: `sendMediaToThread` resolves the open thread on
    // SUBSCRIBE, and a batch subscribes its Nth item long after the press, so opening
    // another thread mid-batch would deliver the remainder into that one instead.
    return build().then(({ fixture, sendMediaToThread }) => {
      const png = () => new File(['x'], 'pic.png', { type: 'image/png' });
      sendMediaToThread
        .mockReturnValueOnce(of({ kind: 'sent', eventId: '$a' }))
        .mockReturnValueOnce(
          of({
            kind: 'rejected',
            failure: 'conversation-unavailable',
            retryable: false,
          }),
        );

      let outcomes: readonly { id: string; failed: boolean }[] = [];
      fixture.componentInstance.onSendMedia({
        items: [
          { id: 'a', file: png(), media: staged('a') },
          { id: 'b', file: png(), media: staged('b') },
        ],
        caption: '',
        onOutcomes: (result) => (outcomes = result),
      });

      expect(sendMediaToThread).toHaveBeenCalledTimes(2);
      expect(outcomes).toEqual([
        { id: 'a', failed: false },
        { id: 'b', failed: true },
      ]);
    });
  });

  it('posts a thread batch caption, on the channel that is not routed', async () => {
    // Emitted from the COMPOSER, not by calling the handler: the defect this pins was a
    // missing `(submitBatchCaption)` binding in the thread's template, which a test that
    // calls `onBatchCaption()` directly cannot see — and the AOT build cannot either, since
    // an unbound output is legal.
    const { fixture, sendToThread } = await build();

    composerOf(fixture).submitBatchCaption.emit({
      text: 'both of these',
      mentions: [],
    });

    expect(sendToThread).toHaveBeenCalledWith('both of these', []);
  });

  it('does not route a thread batch caption into an edit in progress', async () => {
    const { fixture, sendToThread, editInThread } = await build();
    listOf(fixture).startEdit(row('$m1', '@me:hs', 'mine'));

    composerOf(fixture).submitBatchCaption.emit({
      text: 'both of these',
      mentions: [],
    });

    expect(sendToThread).toHaveBeenCalledWith('both of these', []);
    expect(editInThread).not.toHaveBeenCalled();
  });

  it('drives uploadProgress across a thread batch, and clears it at the end', async () => {
    // The room host has this pinned; the thread's identical wiring had nothing, so it could
    // rot away and a slow batch would look like a composer that swallowed the press.
    const { fixture, sendMediaToThread } = await build();
    const cmp = fixture.componentInstance;
    const stream = new Subject<MediaTransferEvent>();
    sendMediaToThread.mockReturnValue(stream.asObservable());
    const png = () => new File(['x'], 'pic.png', { type: 'image/png' });

    cmp.onSendMedia({
      items: [
        { id: 'a', file: png(), media: staged('a') },
        { id: 'b', file: png(), media: staged('b') },
      ],
      caption: '',
      onOutcomes: () => undefined,
    });

    expect(cmp.uploadProgress()).toEqual({ index: 1, total: 2, fraction: 0 });
    stream.next({ kind: 'progress', phase: 'uploading', fraction: 0.5 });
    expect(cmp.uploadProgress()?.fraction).toBe(0.5);

    stream.next({ kind: 'sent', eventId: '$a' });
    stream.complete();
    expect(cmp.uploadProgress()).toBeNull();
  });

  it('ignores stale progress and cleanup from an older thread batch', async () => {
    const { fixture, sendMediaToThread } = await build();
    const cmp = fixture.componentInstance;
    const streams = [
      new Subject<MediaTransferEvent>(),
      new Subject<MediaTransferEvent>(),
    ] as const;
    let streamIndex = 0;
    sendMediaToThread.mockImplementation(
      () =>
        streams[streamIndex++]?.asObservable() ??
        of({ kind: 'sent', eventId: '$fallback' }),
    );
    const png = () => new File(['x'], 'pic.png', { type: 'image/png' });

    cmp.onSendMedia({
      items: [{ id: 'old', file: png(), media: staged('old') }],
      caption: '',
      onOutcomes: () => undefined,
    });
    cmp.onSendMedia({
      items: [{ id: 'new', file: png(), media: staged('new') }],
      caption: '',
      onOutcomes: () => undefined,
    });
    streams[1].next({ kind: 'progress', phase: 'uploading', fraction: 0.6 });
    expect(cmp.uploadProgress()?.fraction).toBe(0.6);

    streams[0].next({ kind: 'progress', phase: 'uploading', fraction: 0.9 });
    expect(cmp.uploadProgress()?.fraction).toBe(0.6);

    streams[0].next({ kind: 'sent', eventId: '$old' });
    streams[0].complete();
    expect(cmp.uploadProgress()?.fraction).toBe(0.6);

    streams[1].next({ kind: 'progress', phase: 'uploading', fraction: 0.75 });
    expect(cmp.uploadProgress()?.fraction).toBe(0.75);
    streams[1].next({ kind: 'sent', eventId: '$new' });
    streams[1].complete();
    expect(cmp.uploadProgress()).toBeNull();

    streams[1].next({ kind: 'progress', phase: 'uploading', fraction: 0.95 });
    expect(cmp.uploadProgress()).toBeNull();
  });

  describe('switching threads under a command', () => {
    const png = () => new File(['x'], 'pic.png', { type: 'image/png' });

    it('drops an edit in progress, so the next submit is a plain send', async () => {
      const { fixture, editInThread, sendToThread } = await build();
      const cmp = fixture.componentInstance;
      listOf(fixture).startEdit(row('$r1', '@me:hs', 'typo'));
      expect(cmp.editingId()).toBe('$r1');

      fixture.componentRef.setInput('rootEventId', '$next');
      fixture.detectChanges();
      cmp.onSubmit({ text: 'fresh', mentions: [] });

      expect(cmp.editingId()).toBeNull();
      expect(editInThread).not.toHaveBeenCalled();
      expect(sendToThread).toHaveBeenCalledWith('fresh', []);
    });

    it('drops a reply in progress', async () => {
      const { fixture, replyInThread } = await build();
      const cmp = fixture.componentInstance;
      listOf(fixture).startReply(row('$r1', '@b:hs', 'hi'));

      fixture.componentRef.setInput('rootEventId', '$next');
      fixture.detectChanges();
      cmp.onSubmit({ text: 'fresh', mentions: [] });

      expect(cmp.replyingToId()).toBeNull();
      expect(replyInThread).not.toHaveBeenCalled();
    });

    it('clears upload progress and ignores the old batch afterwards', async () => {
      const { fixture, sendMediaToThread } = await build();
      const cmp = fixture.componentInstance;
      const stream = new Subject<MediaTransferEvent>();
      sendMediaToThread.mockReturnValue(stream.asObservable());
      cmp.onSendMedia({
        items: [{ id: 'a', file: png(), media: staged('a') }],
        caption: '',
        onOutcomes: () => undefined,
      });
      expect(cmp.uploadProgress()).not.toBeNull();

      fixture.componentRef.setInput('rootEventId', '$next');
      fixture.detectChanges();
      expect(cmp.uploadProgress()).toBeNull();

      stream.next({ kind: 'progress', phase: 'uploading', fraction: 0.9 });
      expect(cmp.uploadProgress()).toBeNull();
    });

    it('retries against the thread that is open now', async () => {
      const { fixture, retryInThread, releasedRoots } = await build();

      fixture.componentRef.setInput('rootEventId', '$next');
      fixture.detectChanges();
      fixture.componentInstance.onRetry('$echo');

      expect(releasedRoots).toHaveBeenCalledWith('$root');
      expect(retryInThread).toHaveBeenCalledTimes(1);
      expect(retryInThread).toHaveBeenCalledWith('$echo');
    });
  });

  it('says what happened when a thread batch fails, and why', async () => {
    const { fixture, sendMediaToThread, toastShow } = await build();
    sendMediaToThread.mockReturnValue(throwError(() => new Error('nope')));
    const png = () => new File(['x'], 'pic.png', { type: 'image/png' });

    fixture.componentInstance.onSendMedia({
      items: [{ id: 'a', file: png(), media: staged('a') }],
      caption: '',
      onOutcomes: () => undefined,
    });

    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('still in the composer'),
      expect.anything(),
    );
  });

  it('says the files were abandoned when the thread changed under them', async () => {
    // A different fate with a different remedy: the panel took the staging with it, so
    // "still in the composer" would send the user looking for files that are not there.
    const { fixture, sendMediaToThread, toastShow } = await build();
    sendMediaToThread
      .mockReturnValueOnce(of({ kind: 'sent', eventId: '$a' }))
      .mockReturnValueOnce(
        of({
          kind: 'rejected',
          failure: 'conversation-unavailable',
          retryable: false,
        }),
      );
    const png = () => new File(['x'], 'pic.png', { type: 'image/png' });

    fixture.componentInstance.onSendMedia({
      items: [
        { id: 'a', file: png(), media: staged('a') },
        { id: 'b', file: png(), media: staged('b') },
      ],
      caption: '',
      onOutcomes: () => undefined,
    });

    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('you left the thread'),
      expect.anything(),
    );
  });

  describe('the sideways swipe', () => {
    beforeEach(() => belowMembers(true));
    afterEach(() => vi.unstubAllGlobals());

    const direction = (fixture: ComponentFixture<ThreadViewComponent>) =>
      listOf(fixture).swipeDirection();

    it('replies to a reply that is not ours', async () => {
      // Through the hosted list's own swipe handler, which now routes to ThreadCommands.
      const { fixture } = await build([msg('$1', '@ada:hs', 'a reply')]);
      const cmp = fixture.componentInstance;
      const list = listOf(fixture);

      list.onRowSwipe(list.rows()[0], 'reply');

      expect(cmp.replyingToId()).toBe('$1');
      expect(cmp.editingId()).toBeNull();
    });

    it('edits a reply that is ours', async () => {
      // The branch that had no coverage in EITHER dispatcher: both tests used somebody
      // else's message, so only the reply path ever ran and deleting the edit branch left
      // the suite green. It is the half the whole design is about — the affordance shows a
      // pencil, and this is what has to happen when the reader lets go.
      const { fixture } = await build([
        { ...msg('$1', '@me:hs', 'mine'), isOwn: true },
      ]);
      const cmp = fixture.componentInstance;
      const list = listOf(fixture);

      list.onRowSwipe(list.rows()[0], 'edit');

      expect(cmp.editingId()).toBe('$1');
      expect(cmp.replyingToId()).toBeNull();
    });

    it('uses the committed edit action after the row leaves the live caps map', async () => {
      const { fixture, threadMessages } = await build([
        { ...msg('$1', '@me:hs', 'mine'), isOwn: true },
      ]);
      const cmp = fixture.componentInstance;
      const list = listOf(fixture);
      const swiped = list.rows()[0];

      threadMessages.set([]);
      fixture.detectChanges();
      expect(list.rows()).toEqual([]);

      list.onRowSwipe(swiped, 'edit');

      expect(cmp.editingId()).toBe('$1');
      expect(cmp.replyingToId()).toBeNull();
    });

    it('takes the direction from the preference when both guards pass', async () => {
      // The positive control. Without one, a computed hard-coded to `() => 'off'` passes
      // every other test in this block.
      const { fixture } = await build([msg('$1', '@ada:hs', 'a reply')]);

      expect(direction(fixture)).toBe('right');
    });

    it('is off above the members breakpoint', async () => {
      // Above `members` the scroller does not claim the horizontal axis and the browser eats
      // the drag after one `pointermove` — so arming there would be a gesture that cannot
      // work. Meaningful only because the control above proves a non-`off` value is reachable.
      belowMembers(false);
      const { fixture } = await build([msg('$1', '@ada:hs', 'a reply')]);

      expect(direction(fixture)).toBe('off');
    });

    it('is off when the platform is not a mobile one', async () => {
      platform.mobile = false;
      const { fixture } = await build([msg('$1', '@ada:hs', 'a reply')]);

      expect(direction(fixture)).toBe('off');
      platform.mobile = true;
    });
  });

  it('keeps the caps object of rows whose capabilities did not change', async () => {
    // Every thread event hands the panel a new messages array. A row that is re-handed a
    // fresh caps object re-renders even though nothing about it changed.
    const { fixture, threadMessages } = await build([
      msg('$1', '@ada:hs', 'first'),
      msg('$2', '@ada:hs', 'second'),
    ]);
    const cmp = listOf(fixture);
    const [first, second] = cmp.rows();
    const firstBefore = cmp.rowCaps(first);
    const secondBefore = cmp.rowCaps(second);

    threadMessages.set([
      msg('$1', '@ada:hs', 'first'),
      { ...msg('$2', '@ada:hs', 'second'), isOwn: true },
    ]);
    fixture.detectChanges();
    const [firstAfter, secondAfter] = cmp.rows();

    expect(cmp.rowCaps(firstAfter)).toBe(firstBefore);
    expect(cmp.rowCaps(secondAfter)).not.toBe(secondBefore);
    expect(cmp.rowCaps(secondAfter).deletable).toBe(true);
  });

  it('closes its own action sheet when the panel is destroyed', async () => {
    // The sheet is a CDK overlay living outside the router outlet, so it outlives the panel.
    // Without this, closing the thread leaves a modal standing whose every row dispatches
    // into a destroyed component. Owned by the hosted list now, so destroying the panel
    // must take the list, and its sheet, with it.
    const { fixture, sheetOpen, sheetClose } = await build([
      msg('$1', '@ada:hs', 'a reply'),
    ]);

    const list = listOf(fixture);
    list.onRowLongPress(list.rows()[0]);
    expect(sheetOpen).toHaveBeenCalledTimes(1);

    fixture.destroy();

    expect(sheetClose).toHaveBeenCalledTimes(1);
  });

  describe('typing', () => {
    it('forwards the composer typing state to the room notification', async () => {
      const { fixture, setTypingCalls } = await build([
        msg('$a', '@ada:hs', 'hi'),
      ]);
      const composer = fixture.debugElement.query(
        By.directive(MessageComposerComponent),
      );

      composer.triggerEventHandler('typing', true);
      composer.triggerEventHandler('typing', false);

      // `setTyping` and not a thread-scoped call: `m.typing` is a room-level EDU, and the
      // service reads the room off its own open context rather than the argument — which
      // matters because this composer is bound to `[roomId]="rootEventId()"`, an EVENT id.
      // Tagged `'thread'`: `m.typing` is one flag per room and both composers feed it, so
      // the service needs to know which one went quiet before it sends a stop.
      expect(setTypingCalls.mock.calls).toEqual([
        [true, 'thread'],
        [false, 'thread'],
      ]);
    });

    it('stops typing when the panel is closed mid-reply', async () => {
      // Without this the server keeps us marked as typing until TYPING_TIMEOUT_MS lapses.
      // The stop is owner-tagged, so the service can still decline to send it when the main
      // composer holds a draft — which is why the naive `setTyping(false)` was wrong.
      const { fixture, setTypingCalls } = await build([
        msg('$a', '@ada:hs', 'hi'),
      ]);
      const composer = fixture.debugElement.query(
        By.directive(MessageComposerComponent),
      );
      composer.triggerEventHandler('typing', true);
      setTypingCalls.mockClear();

      fixture.destroy();

      expect(setTypingCalls.mock.calls).toEqual([[false, 'thread']]);
    });

    it('shows the room typists above the thread composer', async () => {
      const { container } = await build([msg('$a', '@ada:hs', 'hi')], {
        typingNames: ['Alice'],
      });

      const row = container.querySelector('.typing-indicator');
      expect((row?.textContent ?? '').replace(/\s+/g, ' ').trim()).toBe(
        'Alice is typing',
      );
    });

    it('announces the typists when asked to, as a page over an inert room', async () => {
      const { fixture, container } = await build([msg('$a', '@ada:hs', 'hi')], {
        typingNames: ['Alice'],
      });
      fixture.componentRef.setInput('announceTyping', true);
      fixture.detectChanges();

      expect(
        container.querySelector(
          '.thread__footer [data-testid="typing-status"]',
        ),
      ).not.toBeNull();
    });

    it('does not announce the typists a second time', async () => {
      // The list behind this panel carries the same names in its own live region, and
      // `m.typing` is room-scoped, so announcing here would say it twice.
      const { container } = await build([msg('$a', '@ada:hs', 'hi')], {
        typingNames: ['Alice'],
      });

      expect(
        container.querySelector(
          '.thread__footer [data-testid="typing-status"]',
        ),
      ).toBeNull();
      // Nor does the hosted list, which has no typing row of its own here.
      expect(
        container.querySelector('trn-message-list trn-typing-indicator'),
      ).toBeNull();
    });
  });
});

describe('ThreadViewComponent heading and replies line', () => {
  it('names the thread by its root and counts the replies under it', async () => {
    const { container } = await build([
      messageView({ id: '$root', body: 'Onboarding copy changes' }),
      messageView({ id: '$r1', body: 'one' }),
      messageView({ id: '$r2', body: 'two' }),
    ]);

    expect(
      container.querySelector('.side-panel-header__title')?.textContent,
    ).toContain('Onboarding copy changes');
    expect(
      container
        .querySelector('[data-testid="thread-replies-divider"]')
        ?.getAttribute('aria-label'),
    ).toBe('2 replies');
  });

  it('says so under a root with no replies yet', async () => {
    const { container } = await build([
      messageView({ id: '$root', body: 'Lonely root' }),
    ]);

    expect(
      container.querySelector('[data-testid="thread-replies-divider"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="thread-no-replies"] h3')
        ?.textContent,
    ).toBe('No replies yet');
  });
});
