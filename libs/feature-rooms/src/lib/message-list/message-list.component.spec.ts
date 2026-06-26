import { TestBed } from '@angular/core/testing';
import { describe, expect, it, beforeEach } from 'vitest';
import { MessageListComponent } from './message-list.component';

function msg(id: string, senderId: string, senderName: string, ts: number) {
  return {
    id,
    senderId,
    senderName,
    senderInitial: senderName[0],
    senderAvatarUrl: null,
    body: `body ${id}`,
    html: null,
    timestamp: ts,
    isOwn: false,
    decryptionFailed: false,
    edited: false,
    status: null,
    kind: 'text' as const,
  };
}

describe('MessageListComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [MessageListComponent] }),
  );

  it('renders a row per message and groups consecutive senders', () => {
    const fixture = TestBed.createComponent(MessageListComponent);
    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
      msg('$2', '@a:hs', 'Alice', 2000), // same sender → continuation
      msg('$3', '@b:hs', 'Bob', 3000),
    ]);
    fixture.detectChanges();

    const el = fixture.nativeElement;
    expect(el.querySelectorAll('.msg').length).toBe(3);
    expect(el.querySelectorAll('.msg__avatar').length).toBe(2); // Alice + Bob headers
    expect(el.querySelectorAll('.msg--cont').length).toBe(1); // Alice's second line
    expect(el.textContent).toContain('body $2');
  });

  it('renders formatted markdown via innerHTML', () => {
    const fixture = TestBed.createComponent(MessageListComponent);
    fixture.componentRef.setInput('messages', [
      {
        id: '$1',
        senderId: '@a:hs',
        senderName: 'Alice',
        senderInitial: 'A',
        senderAvatarUrl: null,
        body: '**bold**',
        html: '<strong>bold</strong>',
        timestamp: 1,
        isOwn: false,
        decryptionFailed: false,
        edited: false,
        status: null,
        kind: 'text' as const,
      },
    ]);
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector('.msg__text--html');
    expect(el).toBeTruthy();
    expect(el.querySelector('strong')?.textContent).toBe('bold');
  });

  it('emits loadOlder when scrolled near the top (and history remains)', () => {
    const fixture = TestBed.createComponent(MessageListComponent);
    fixture.componentRef.setInput('canLoadOlder', true);
    fixture.detectChanges();

    let fired = false;
    fixture.componentInstance.loadOlder.subscribe(() => (fired = true));
    // jsdom has no layout, so scrollTop defaults to 0 (within the threshold).
    fixture.nativeElement
      .querySelector('.scroll')
      .dispatchEvent(new Event('scroll'));

    expect(fired).toBe(true);
  });

  it('does not auto-load when there is no more history', () => {
    const fixture = TestBed.createComponent(MessageListComponent);
    fixture.componentRef.setInput('canLoadOlder', false);
    fixture.detectChanges();

    let fired = false;
    fixture.componentInstance.loadOlder.subscribe(() => (fired = true));
    fixture.nativeElement
      .querySelector('.scroll')
      .dispatchEvent(new Event('scroll'));

    expect(fired).toBe(false);
  });
});
