import { signal } from '@angular/core';
import { type ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TrnDialogRef, TrnToastService } from '@trinity/components/overlay';
import { render } from '@trinity/testing';
import {
  ThreadsService,
  TimelineActionsService,
  TimelineService,
} from '@trinity/data-access/timeline';
import { RoomsService, type MemberSummary } from '@trinity/data-access/rooms';
import { type MessageView } from '@trinity/util/matrix';
import { MockProvider } from 'ng-mocks';
import { Subject, of, throwError } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ThreadViewComponent } from './thread-view.component';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import { MessageSourceService } from '../message-source/message-source.service';
import type { MessageRow } from '../message-row/message-row.component';

function msg(id: string, senderId: string, body: string): MessageView {
  return {
    id,
    senderId,
    senderName: senderId,
    senderInitial: senderId[1]?.toUpperCase() ?? '?',
    senderAvatarMxc: null,
    body,
    html: null,
    timestamp: 1000,
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

/** The composer this panel renders, for asserting what a quote put into it. */
function composerOf(
  fixture: ComponentFixture<ThreadViewComponent>,
): MessageComposerComponent {
  return fixture.debugElement.query(By.directive(MessageComposerComponent))
    .componentInstance as MessageComposerComponent;
}

function row(id: string, senderId: string, body: string): MessageRow {
  return { ...msg(id, senderId, body), showHeader: true };
}

async function build(
  messages: MessageView[] = [],
  state: {
    canPaginate?: boolean;
    loadingOlder?: boolean;
    canRedactOthers?: boolean;
  } = {},
) {
  const threadMessages = signal<MessageView[]>(messages);
  const canPaginateThread = signal(state.canPaginate ?? false);
  const loadingOlderThread = signal(state.loadingOlder ?? false);
  const openThread = vi.fn();
  const closeThread = vi.fn();
  const paginateOpenThread = vi.fn().mockReturnValue(of(void 0));
  const sendToThread = vi.fn().mockReturnValue(of(void 0));
  const editInThread = vi.fn().mockReturnValue(of(void 0));
  const replyInThread = vi.fn().mockReturnValue(of(void 0));
  const toggleReactionInThread = vi.fn().mockReturnValue(of(void 0));
  const retryInThread = vi.fn();
  const sendMediaToThread = vi.fn().mockReturnValue(of(void 0));
  const toastShow = vi.fn();
  const openThreadRootIdSignal = signal<string | null>('$root');
  const openThreadRootId = openThreadRootIdSignal.asReadonly();
  const sourceOpen = vi.fn();
  const dismiss = vi.fn().mockResolvedValue(true);
  // The thread composer's @-mention list comes from the room's member projection. The spec
  // supplied no RoomsService at all, so `return []` in the component went unnoticed — only
  // a `throw` failed, and that was the template crashing rather than an assertion.
  const roster = signal<readonly MemberSummary[]>([
    {
      userId: '@ada:hs',
      name: 'Ada',
      initial: 'A',
      avatarMxc: null,
      powerLevel: 0,
      isCreator: false,
    },
  ]);
  const membersFor = vi.fn((roomId: string | null) =>
    roomId === '!r:hs'
      ? roster.asReadonly()
      : signal<readonly MemberSummary[]>([]).asReadonly(),
  );
  const { fixture, container } = await render(ThreadViewComponent, {
    inputs: { roomId: '!r:hs', rootEventId: '$root' },
    providers: [
      MockProvider(ThreadsService, {
        threadMessages,
        canPaginateThread,
        loadingOlderThread,
        openThread,
        closeThread,
        paginateOpenThread,
        sendToThread,
        editInThread,
        replyInThread,
        toggleReactionInThread,
        retryInThread,
        sendMediaToThread,
        openThreadRootId,
      }),
      MockProvider(TimelineService, {
        canRedactOthers: signal(state.canRedactOthers ?? false).asReadonly(),
      }),
      MockProvider(TimelineActionsService),
      MockProvider(RoomsService, { membersFor }),
      MockProvider(MessageSourceService, { open: sourceOpen }),
      MockProvider(TrnDialogRef, { close: dismiss }),
      MockProvider(TrnToastService, { show: toastShow }),
    ],
  });
  return {
    fixture,
    container,
    roster,
    membersFor,
    canPaginateThread,
    loadingOlderThread,
    openThread,
    closeThread,
    paginateOpenThread,
    sendToThread,
    editInThread,
    replyInThread,
    toggleReactionInThread,
    retryInThread,
    sendMediaToThread,
    openThreadRootIdSignal,
    toastShow,
    sourceOpen,
    dismiss,
  };
}

describe('ThreadViewComponent', () => {
  it('opens the thread on init with its room and root ids', async () => {
    const { openThread } = await build();

    expect(openThread).toHaveBeenCalledWith('!r:hs', '$root');
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

    expect(container.querySelector('.thread__empty')).toBeTruthy();
  });

  it('closes the host dialog on close', async () => {
    const { fixture, dismiss } = await build();

    fixture.componentInstance.close();
    expect(dismiss).toHaveBeenCalled();
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

  it('routes a submit to an edit while editing, then leaves edit mode', async () => {
    const { fixture, editInThread, sendToThread } = await build([
      msg('$r1', '@me:hs', 'typo'),
    ]);
    const cmp = fixture.componentInstance;

    cmp.startEdit(row('$r1', '@me:hs', 'typo'));
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

    cmp.startReply(row('$r1', '@b:hs', 'a reply'));
    cmp.onSubmit({ text: 'replying', mentions: [] });

    expect(replyInThread).toHaveBeenCalledWith('$r1', 'replying', []);
    expect(sendToThread).not.toHaveBeenCalled();
    expect(cmp.replyingToId()).toBeNull();
  });

  it('quotes a thread message into the thread’s own composer', async () => {
    const { fixture } = await build([msg('$r1', '@b:hs', 'a reply')]);
    const cmp = fixture.componentInstance;

    cmp.onRowAction(row('$r1', '@b:hs', 'a reply'), { type: 'quote' });

    // The thread panel has its own composer; a quote raised here must not reach the
    // room's.
    expect(composerOf(fixture).text()).toBe('> a reply\n\n');
  });

  it('keeps a thread quote that interrupts an edit', async () => {
    // Same ordering trap as the room list: the composer restores its draft when it leaves
    // edit mode, and that restore would land after a same-tick insert.
    const { fixture } = await build([msg('$r1', '@me:hs', 'mine')]);
    const cmp = fixture.componentInstance;

    cmp.startEdit(row('$r1', '@me:hs', 'mine'));
    fixture.detectChanges();

    cmp.startQuote(row('$r1', '@me:hs', 'mine'));
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
    const writeText = vi.fn();
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const { fixture } = await build([msg('$r1', '@b:hs', 'a reply')]);

    fixture.componentInstance.onRowAction(row('$r1', '@b:hs', 'a reply'), {
      type: 'copy-link',
    });

    expect(writeText).toHaveBeenCalledWith(
      expect.stringContaining('https://matrix.to/#/'),
    );
    vi.unstubAllGlobals();
  });

  it('opens the raw source for a thread message', async () => {
    const { fixture, sourceOpen } = await build([
      msg('$r1', '@b:hs', 'a reply'),
    ]);

    fixture.componentInstance.onRowAction(row('$r1', '@b:hs', 'a reply'), {
      type: 'view-source',
    });

    expect(sourceOpen).toHaveBeenCalledWith('!r:hs', '$r1');
  });

  it('lets a moderator delete another member’s thread message', async () => {
    const { fixture } = await build([msg('$1', '@a:hs', 'hi')], {
      canRedactOthers: true,
    });
    const target = { ...msg('$1', '@a:hs', 'hi'), showHeader: true };

    expect(fixture.componentInstance.rowCaps(target).deletable).toBe(true);
  });

  it('does not let a regular member delete others’ thread messages', async () => {
    const { fixture } = await build([msg('$1', '@a:hs', 'hi')], {
      canRedactOthers: false,
    });
    const target = { ...msg('$1', '@a:hs', 'hi'), showHeader: true };

    expect(fixture.componentInstance.rowCaps(target).deletable).toBe(false);
  });

  it('shows a "Load older" affordance and paginates when it can load older', async () => {
    const { container, paginateOpenThread } = await build([], {
      canPaginate: true,
    });

    const btn = container.querySelector<HTMLElement>('.thread__load-older');
    expect(btn).toBeTruthy();
    expect(btn?.textContent).toContain('Load older');

    btn?.click();
    expect(paginateOpenThread).toHaveBeenCalled();
  });

  it('shows a loading note (not the button) while older replies load', async () => {
    const { container } = await build([], { loadingOlder: true });

    const el = container.querySelector('.thread__load-older');
    expect(el?.textContent).toContain('Loading older');
    expect(el?.tagName).not.toBe('BUTTON');
  });

  it('omits the load-older affordance when there is no older history', async () => {
    const { container } = await build([], { canPaginate: false });

    expect(container.querySelector('.thread__load-older')).toBeNull();
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
        name: 'Ada',
        initial: 'A',
        avatarMxc: null,
        powerLevel: 0,
        isCreator: false,
      },
      {
        userId: '@bo:hs',
        name: 'Bo',
        initial: 'B',
        avatarMxc: null,
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
    return build().then(
      ({ fixture, sendMediaToThread, openThreadRootIdSignal }) => {
        const png = () => new File(['x'], 'pic.png', { type: 'image/png' });
        sendMediaToThread.mockImplementation(() => {
          openThreadRootIdSignal.set('$other'); // the user opens another thread
          return of(void 0);
        });

        let outcomes: readonly { id: string; failed: boolean }[] = [];
        fixture.componentInstance.onSendMedia({
          items: [
            { id: 'a', file: png() },
            { id: 'b', file: png() },
          ],
          caption: '',
          onOutcomes: (result) => (outcomes = result),
        });

        expect(sendMediaToThread).toHaveBeenCalledTimes(1);
        expect(outcomes).toEqual([
          { id: 'a', failed: false },
          { id: 'b', failed: true },
        ]);
      },
    );
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
    fixture.componentInstance.editingId.set('$m1');

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
    let report: ((fraction: number) => void) | undefined;
    const stream = new Subject<void>();
    sendMediaToThread.mockImplementation(
      (_f: File, _c: string, cb?: (fraction: number) => void) => {
        report = cb;
        return stream.asObservable();
      },
    );
    const png = () => new File(['x'], 'pic.png', { type: 'image/png' });

    cmp.onSendMedia({
      items: [
        { id: 'a', file: png() },
        { id: 'b', file: png() },
      ],
      caption: '',
      onOutcomes: () => undefined,
    });

    expect(cmp.uploadProgress()).toEqual({ index: 1, total: 2, fraction: 0 });
    report?.(0.5);
    expect(cmp.uploadProgress()?.fraction).toBe(0.5);

    stream.next();
    stream.complete();
    expect(cmp.uploadProgress()).toBeNull();
  });

  it('says what happened when a thread batch fails, and why', async () => {
    const { fixture, sendMediaToThread, toastShow } = await build();
    sendMediaToThread.mockReturnValue(throwError(() => new Error('nope')));
    const png = () => new File(['x'], 'pic.png', { type: 'image/png' });

    fixture.componentInstance.onSendMedia({
      items: [{ id: 'a', file: png() }],
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
    const { fixture, sendMediaToThread, openThreadRootIdSignal, toastShow } =
      await build();
    sendMediaToThread.mockImplementation(() => {
      openThreadRootIdSignal.set('$other');
      return of(void 0);
    });
    const png = () => new File(['x'], 'pic.png', { type: 'image/png' });

    fixture.componentInstance.onSendMedia({
      items: [
        { id: 'a', file: png() },
        { id: 'b', file: png() },
      ],
      caption: '',
      onOutcomes: () => undefined,
    });

    expect(toastShow).toHaveBeenCalledWith(
      expect.stringContaining('you left the thread'),
      expect.anything(),
    );
  });
});
