import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { ModalController } from '@ionic/angular/standalone';
import { ThreadsService, type MessageView } from '@trinity/core';
import { describe, expect, it, vi } from 'vitest';
import { ThreadViewComponent } from './thread-view.component';

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

function build(messages: MessageView[] = []) {
  const threadMessages = signal<MessageView[]>(messages);
  const openThread = vi.fn();
  const closeThread = vi.fn();
  const dismiss = vi.fn().mockResolvedValue(true);
  TestBed.configureTestingModule({
    imports: [ThreadViewComponent],
    providers: [
      {
        provide: ThreadsService,
        useValue: { threadMessages, openThread, closeThread },
      },
      { provide: ModalController, useValue: { dismiss } },
    ],
  });
  const fixture = TestBed.createComponent(ThreadViewComponent);
  fixture.componentRef.setInput('roomId', '!r:hs');
  fixture.componentRef.setInput('rootEventId', '$root');
  return { fixture, openThread, closeThread, dismiss };
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

  it('shows an empty state when the thread has no messages', () => {
    const { fixture } = build([]);
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.thread__empty')).toBeTruthy();
  });

  it('dismisses the modal on close', () => {
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
});
