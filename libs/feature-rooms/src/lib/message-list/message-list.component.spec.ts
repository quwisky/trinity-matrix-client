import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
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
    reactions: [],
    replyTo: null,
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
        reactions: [],
        replyTo: null,
        status: null,
        kind: 'text' as const,
      },
    ]);
    fixture.detectChanges();

    const el = fixture.nativeElement.querySelector('.msg__text--html');
    expect(el).toBeTruthy();
    expect(el.querySelector('strong')?.textContent).toBe('bold');
  });

  it('renders a reply preview above a reply message', () => {
    const fixture = TestBed.createComponent(MessageListComponent);
    fixture.componentRef.setInput('messages', [
      {
        ...msg('$1', '@a:hs', 'Alice', 1000),
        replyTo: {
          id: '$orig',
          senderName: 'Bob',
          senderInitial: 'B',
          senderAvatarUrl: null,
          body: 'original message',
        },
      },
    ]);
    fixture.detectChanges();

    const reply = fixture.nativeElement.querySelector('.msg__reply');
    expect(reply).toBeTruthy();
    expect(reply.textContent).toContain('Bob');
    expect(reply.textContent).toContain('original message');
  });

  it('editLastOwn selects the most recent editable own message', () => {
    const fixture = TestBed.createComponent(MessageListComponent);
    fixture.componentRef.setInput('messages', [
      { ...msg('$1', '@me:hs', 'Me', 1000), isOwn: true },
      { ...msg('$2', '@b:hs', 'Bob', 2000) }, // not own → skip
      { ...msg('$3', '@me:hs', 'Me', 3000), isOwn: true }, // latest editable own
      {
        ...msg('$4', '@me:hs', 'Me', 4000),
        isOwn: true,
        kind: 'redacted' as const,
      },
    ]);
    fixture.detectChanges();

    const cmp = fixture.componentInstance;
    cmp.editLastOwn();
    expect(cmp.editingId()).toBe('$3');
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

  it('announces a new incoming message, but not the first load or own messages', () => {
    const fixture = TestBed.createComponent(MessageListComponent);
    fixture.detectChanges(); // resolve the scroll viewchild
    const cmp = fixture.componentInstance;

    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
    ]);
    fixture.detectChanges();
    expect(cmp.announcement()).toBe(''); // first load → silent

    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
      msg('$2', '@b:hs', 'Bob', 2000),
    ]);
    fixture.detectChanges();
    expect(cmp.announcement()).toContain('Bob'); // new incoming → announced

    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
      msg('$2', '@b:hs', 'Bob', 2000),
      { ...msg('$3', '@me:hs', 'Me', 3000), isOwn: true },
    ]);
    fixture.detectChanges();
    expect(cmp.announcement()).toContain('Bob'); // own message → not announced
  });

  describe('backfill stall guard', () => {
    // jsdom has no layout (scrollHeight/clientHeight are 0), so the viewport
    // always reads as "not full" and the backfill effect engages. Run rAF
    // synchronously so the effect's deferred work happens within detectChanges.
    beforeEach(() =>
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      }),
    );
    afterEach(() => vi.unstubAllGlobals());

    it('keeps backfilling while older history arrives, even if the count stays equal, then stops', () => {
      const fixture = TestBed.createComponent(MessageListComponent);
      fixture.componentRef.setInput('canLoadOlder', true);
      fixture.detectChanges(); // resolve the scroll viewchild

      let emits = 0;
      fixture.componentInstance.loadOlder.subscribe(() => emits++);

      // Round 1: a short, unscrollable timeline → request older history.
      fixture.componentRef.setInput('messages', [
        msg('$b', '@a:hs', 'A', 2000),
        msg('$c', '@a:hs', 'A', 3000),
      ]);
      fixture.detectChanges();
      expect(emits).toBe(1);

      // The load prepended $a but a redaction dropped $b — SAME length (2),
      // newest unchanged ($c). The old count-based guard would stop here; the
      // id-based guard sees the oldest move $b→$a and keeps going.
      fixture.componentRef.setInput('messages', [
        msg('$a', '@a:hs', 'A', 1000),
        msg('$c', '@a:hs', 'A', 3000),
      ]);
      fixture.detectChanges();
      expect(emits).toBe(2);

      // A live message arrives ($d) but no older history was prepended (oldest
      // stays $a) → backfill stops instead of spinning.
      fixture.componentRef.setInput('messages', [
        msg('$a', '@a:hs', 'A', 1000),
        msg('$c', '@a:hs', 'A', 3000),
        msg('$d', '@a:hs', 'A', 4000),
      ]);
      fixture.detectChanges();
      expect(emits).toBe(2);
    });
  });
});
