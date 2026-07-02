import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { DialogRef } from '@angular/cdk/dialog';
import { ThreadsService, type MessageView } from '@trinity/core';
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
  };
}

function row(id: string, senderId: string, body: string): MessageRow {
  return { ...msg(id, senderId, body), showHeader: true };
}

function build(
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
  TestBed.configureTestingModule({
    imports: [ThreadViewComponent],
    providers: [
      {
        provide: ThreadsService,
        useValue: {
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
        },
      },
      { provide: DialogRef, useValue: { close: dismiss } },
    ],
  });
  const fixture = TestBed.createComponent(ThreadViewComponent);
  fixture.componentRef.setInput('roomId', '!r:hs');
  fixture.componentRef.setInput('rootEventId', '$root');
  return {
    fixture,
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
  it('opens the thread on init with its room and root ids', () => {
    const { fixture, openThread } = build();
    fixture.detectChanges(); // runs ngOnInit

    expect(openThread).toHaveBeenCalledWith('!r:hs', '$root');
  });

  it('renders the thread messages as rows', () => {
    const { fixture } = build([
      msg('$root', '@a:hs', 'the root'),
      msg('$r1', '@b:hs', 'a reply'),
    ]);
    fixture.detectChanges();

    const el = fixture.nativeElement;
    expect(el.querySelectorAll('.msg').length).toBe(2);
    expect(el.textContent).toContain('the root');
    expect(el.textContent).toContain('a reply');
  });

  it('keeps the header on a reply that continues the same sender', () => {
    const { fixture } = build([
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
    fixture.detectChanges();

    const el = fixture.nativeElement;
    const rows = el.querySelectorAll('.msg');
    expect(rows.length).toBe(2);
    expect(el.querySelectorAll('.msg__avatar').length).toBe(2);
    expect(el.querySelectorAll('.msg--cont').length).toBe(0);
    expect(rows[1].querySelector('.msg__author')).toBeTruthy();
    expect(rows[1].querySelector('.msg__reply')).toBeTruthy();
  });

  it('shows an empty state when the thread has no messages', () => {
    const { fixture } = build([]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.thread__empty')).toBeTruthy();
  });

  it('closes the host dialog on close', () => {
    const { fixture, dismiss } = build();
    fixture.detectChanges();

    fixture.componentInstance.close();
    expect(dismiss).toHaveBeenCalled();
  });

  it('closes the thread projection when destroyed', () => {
    const { fixture, closeThread } = build();
    fixture.detectChanges();

    fixture.destroy();
    expect(closeThread).toHaveBeenCalled();
  });

  it('sends a new message into the thread when nothing is being edited/replied', () => {
    const { fixture, sendToThread, editInThread, replyInThread } = build();
    fixture.detectChanges();

    fixture.componentInstance.onSubmit('hello thread');

    expect(sendToThread).toHaveBeenCalledWith('hello thread');
    expect(editInThread).not.toHaveBeenCalled();
    expect(replyInThread).not.toHaveBeenCalled();
  });

  it('routes a submit to an edit while editing, then leaves edit mode', () => {
    const { fixture, editInThread, sendToThread } = build([
      msg('$r1', '@me:hs', 'typo'),
    ]);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    cmp.startEdit(row('$r1', '@me:hs', 'typo'));
    cmp.onSubmit('fixed');

    expect(editInThread).toHaveBeenCalledWith('$r1', 'fixed');
    expect(sendToThread).not.toHaveBeenCalled();
    expect(cmp.editingId()).toBeNull();
  });

  it('routes a submit to a reply while replying, then clears the reply target', () => {
    const { fixture, replyInThread, sendToThread } = build([
      msg('$r1', '@b:hs', 'a reply'),
    ]);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    cmp.startReply(row('$r1', '@b:hs', 'a reply'));
    cmp.onSubmit('replying');

    expect(replyInThread).toHaveBeenCalledWith('$r1', 'replying');
    expect(sendToThread).not.toHaveBeenCalled();
    expect(cmp.replyingToId()).toBeNull();
  });

  it('toggles a reaction on a thread message', () => {
    const { fixture, toggleReactionInThread } = build([
      msg('$r1', '@b:hs', 'a reply'),
    ]);
    fixture.detectChanges();

    fixture.componentInstance.onReact('$r1', '👍');

    expect(toggleReactionInThread).toHaveBeenCalledWith('$r1', '👍');
  });

  it('retries a failed thread message', () => {
    const { fixture, retryInThread } = build();
    fixture.detectChanges();

    fixture.componentInstance.onRetry('$echo');

    expect(retryInThread).toHaveBeenCalledWith('$echo');
  });

  it('shows a "Load older" affordance and paginates when it can load older', () => {
    const { fixture, paginateOpenThread } = build([], { canPaginate: true });
    fixture.detectChanges();

    const btn = fixture.nativeElement.querySelector('.thread__load-older');
    expect(btn).toBeTruthy();
    expect(btn.textContent).toContain('Load older');

    btn.click();
    expect(paginateOpenThread).toHaveBeenCalled();
  });

  it('shows a loading note (not the button) while older replies load', () => {
    const { fixture } = build([], { loadingOlder: true });
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector('.thread__load-older');
    expect(el.textContent).toContain('Loading older');
    expect(el.tagName).not.toBe('BUTTON');
  });

  it('omits the load-older affordance when there is no older history', () => {
    const { fixture } = build([], { canPaginate: false });
    fixture.detectChanges();

    expect(
      fixture.nativeElement.querySelector('.thread__load-older'),
    ).toBeNull();
  });
});
