import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import { TrnAlertService } from '@trinity/helm/overlay';
import { SimpleMessageListComponent } from './simple-message-list.component';

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

describe('SimpleMessageListComponent', () => {
  beforeEach(() =>
    TestBed.configureTestingModule({ imports: [SimpleMessageListComponent] }),
  );

  it('renders a row per message and groups consecutive senders', () => {
    const fixture = TestBed.createComponent(SimpleMessageListComponent);
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

  it('resets the edit/reply target and suppresses announcements on room change', () => {
    const fixture = TestBed.createComponent(SimpleMessageListComponent);
    fixture.componentRef.setInput('roomId', '!a:hs');
    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
    ]);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    // In-progress reply in room A.
    cmp.replyingToId.set('$1');
    expect(cmp.replyingToId()).toBe('$1');

    // Switch to room B: the stale target must clear (else the next plain send is
    // routed as a cross-room reply), and B's newest must NOT be announced as a
    // live incoming message (lastId was reset, so it reads as a fresh load).
    fixture.componentRef.setInput('roomId', '!b:hs');
    fixture.componentRef.setInput('messages', [
      msg('$9', '@b:hs', 'Bob', 5000),
    ]);
    fixture.detectChanges();

    expect(cmp.replyingToId()).toBeNull();
    expect(cmp.announcement()).toBe('');
  });

  it('renders formatted markdown via innerHTML', () => {
    const fixture = TestBed.createComponent(SimpleMessageListComponent);
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
    const fixture = TestBed.createComponent(SimpleMessageListComponent);
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

  it('shows the header on a reply even when it continues the same sender', () => {
    const fixture = TestBed.createComponent(SimpleMessageListComponent);
    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
      {
        // Same sender, well within the 5-min gap → would normally group as a
        // continuation, but a reply must keep its own author + avatar.
        ...msg('$2', '@a:hs', 'Alice', 2000),
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

    const el = fixture.nativeElement;
    const rows = el.querySelectorAll('.msg');
    expect(rows.length).toBe(2);
    // Both rows carry a header (avatar + author); the reply is not a continuation.
    expect(el.querySelectorAll('.msg__avatar').length).toBe(2);
    expect(el.querySelectorAll('.msg--cont').length).toBe(0);
    expect(rows[1].querySelector('.msg__author')?.textContent).toContain(
      'Alice',
    );
    expect(rows[1].querySelector('.msg__reply')?.textContent).toContain('Bob');
  });

  it('editLastOwn selects the most recent editable own message', () => {
    const fixture = TestBed.createComponent(SimpleMessageListComponent);
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

  it('scrolls the matching row into view when jumpToId is set', () => {
    let jumped: Element | null = null;
    // jsdom doesn't implement scrollIntoView; stub it on the prototype and
    // capture the element it was invoked on (a regular fn binds `this`).
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      jumped = this;
    });

    const fixture = TestBed.createComponent(SimpleMessageListComponent);
    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
      msg('$2', '@b:hs', 'Bob', 2000),
    ]);
    fixture.detectChanges();

    fixture.componentRef.setInput('jumpToId', '$2');
    fixture.detectChanges();

    expect(jumped).not.toBeNull();
    expect((jumped as unknown as Element).getAttribute('data-mid')).toBe('$2');
  });

  it('flashes the jumped-to row', () => {
    Element.prototype.scrollIntoView = vi.fn();

    const fixture = TestBed.createComponent(SimpleMessageListComponent);
    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
      msg('$2', '@b:hs', 'Bob', 2000),
    ]);
    fixture.detectChanges();

    fixture.componentInstance.jumpTo('$2');

    const row = fixture.nativeElement.querySelector('[data-mid="$2"]');
    expect(row.classList.contains('msg--flash')).toBe(true);
  });

  it('re-applies the flash class on a repeat jump to the same row', () => {
    Element.prototype.scrollIntoView = vi.fn();

    const fixture = TestBed.createComponent(SimpleMessageListComponent);
    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
      msg('$2', '@b:hs', 'Bob', 2000),
    ]);
    fixture.detectChanges();

    const row = fixture.nativeElement.querySelector('[data-mid="$2"]');

    fixture.componentInstance.jumpTo('$2');
    expect(row.classList.contains('msg--flash')).toBe(true);

    // jsdom never fires `animationend`, so the class is never auto-removed — a
    // second jump must still leave it present (the reflow-reset resets, then
    // re-adds, the class; it can't be observed mid-toggle in jsdom, but the net
    // effect — still flashing — is).
    fixture.componentInstance.jumpTo('$2');
    expect(row.classList.contains('msg--flash')).toBe(true);
  });

  it('emits loadOlder when scrolled near the top (and history remains)', () => {
    const fixture = TestBed.createComponent(SimpleMessageListComponent);
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
    const fixture = TestBed.createComponent(SimpleMessageListComponent);
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
    const fixture = TestBed.createComponent(SimpleMessageListComponent);
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
      const fixture = TestBed.createComponent(SimpleMessageListComponent);
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

  // Handlers provided by MessageListBase (shared with VirtualMessageListComponent),
  // exercised here through the plain component.
  describe('shared behaviour (base)', () => {
    const confirm = vi.fn();
    const row = (id: string) => ({
      ...msg(id, '@a:hs', 'A', 1),
      showHeader: true,
    });

    beforeEach(() => {
      confirm.mockReset();
      TestBed.configureTestingModule({
        providers: [{ provide: TrnAlertService, useValue: { confirm } }],
      });
    });

    function make() {
      const fixture = TestBed.createComponent(SimpleMessageListComponent);
      fixture.detectChanges();
      return fixture.componentInstance;
    }

    it('routes a plain submit to send', () => {
      const cmp = make();
      let sent: string | null = null;
      cmp.send.subscribe((t) => (sent = t));
      cmp.onSubmit('hello');
      expect(sent).toBe('hello');
    });

    it('routes a submit to editMessage while editing, then clears the target', () => {
      const cmp = make();
      let edited: { id: string; body: string } | null = null;
      cmp.editMessage.subscribe((e) => (edited = e));
      cmp.editingId.set('$7');
      cmp.onSubmit('fixed');
      expect(edited).toEqual({ id: '$7', body: 'fixed' });
      expect(cmp.editingId()).toBeNull();
    });

    it('routes a submit to reply while replying, then clears the target', () => {
      const cmp = make();
      let replied: { id: string; body: string } | null = null;
      cmp.reply.subscribe((e) => (replied = e));
      cmp.replyingToId.set('$3');
      cmp.onSubmit('re');
      expect(replied).toEqual({ id: '$3', body: 're' });
      expect(cmp.replyingToId()).toBeNull();
    });

    it('makes startEdit and startReply mutually exclusive', () => {
      const cmp = make();
      cmp.replyingToId.set('$1');
      cmp.startEdit(row('$2'));
      expect(cmp.editingId()).toBe('$2');
      expect(cmp.replyingToId()).toBeNull();

      cmp.editingId.set('$9');
      cmp.startReply(row('$3'));
      expect(cmp.replyingToId()).toBe('$3');
      expect(cmp.editingId()).toBeNull();
    });

    it('deletes only when the confirm dialog is accepted', async () => {
      const cmp = make();
      const deleted: string[] = [];
      cmp.deleteMessage.subscribe((id) => deleted.push(id));

      confirm.mockResolvedValueOnce(false);
      await cmp.onDelete(row('$1'));
      expect(deleted).toEqual([]);

      confirm.mockResolvedValueOnce(true);
      await cmp.onDelete(row('$2'));
      expect(deleted).toEqual(['$2']);
    });

    it('copies a message body to the clipboard', () => {
      const cmp = make();
      const writeText = vi.fn();
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });
      cmp.onCopy(row('$1'));
      expect(writeText).toHaveBeenCalledWith('body $1');
    });
  });
});
