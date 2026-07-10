import { signal } from '@angular/core';
import { DialogRef } from '@angular/cdk/dialog';
import { render } from '@testing-library/angular';
import { ThreadsService } from '@trinity/data-access-timeline';
import { type MessageView } from '@trinity/util-matrix';
import { MockProvider } from 'ng-mocks';
import { of } from 'rxjs';
import { describe, expect, it, vi } from 'vitest';
import { ThreadViewComponent } from './thread-view.component';
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
  };
}

function row(id: string, senderId: string, body: string): MessageRow {
  return { ...msg(id, senderId, body), showHeader: true };
}

async function build(
  messages: MessageView[] = [],
  state: { canPaginate?: boolean; loadingOlder?: boolean } = {},
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
  const dismiss = vi.fn().mockResolvedValue(true);
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
      }),
      MockProvider(DialogRef, { close: dismiss }),
    ],
  });
  return {
    fixture,
    container,
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
