import { TestBed } from '@angular/core/testing';
import { render } from '@testing-library/angular';
import { MockProvider } from 'ng-mocks';
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import { type MessageView } from '@trinity/util-matrix';
import { TrnAlertService } from '@trinity/helm/overlay';
import { SimpleMessageListComponent } from './simple-message-list.component';

function msg(
  id: string,
  senderId: string,
  senderName: string,
  ts: number,
): MessageView {
  return {
    id,
    senderId,
    senderName,
    senderInitial: senderName[0],
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
  };
}

describe('SimpleMessageListComponent', () => {
  it('renders a row per message and groups consecutive senders', async () => {
    const { container } = await render(SimpleMessageListComponent, {
      inputs: {
        messages: [
          msg('$1', '@a:hs', 'Alice', 1000),
          msg('$2', '@a:hs', 'Alice', 2000), // same sender → continuation
          msg('$3', '@b:hs', 'Bob', 3000),
        ],
      },
    });

    expect(container.querySelectorAll('.msg').length).toBe(3);
    expect(container.querySelectorAll('.msg__avatar').length).toBe(2); // Alice + Bob headers
    expect(container.querySelectorAll('.msg--cont').length).toBe(1); // Alice's second line
    expect(container.textContent).toContain('body $2');
  });

  it('resets the edit/reply target and suppresses announcements on room change', async () => {
    const { fixture } = await render(SimpleMessageListComponent, {
      inputs: {
        roomId: '!a:hs',
        messages: [msg('$1', '@a:hs', 'Alice', 1000)],
      },
    });
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

  it('renders formatted markdown via innerHTML', async () => {
    const { container } = await render(SimpleMessageListComponent, {
      inputs: {
        messages: [
          {
            id: '$1',
            senderId: '@a:hs',
            senderName: 'Alice',
            senderInitial: 'A',
            senderAvatarMxc: null,
            body: '**bold**',
            html: '<strong>bold</strong>',
            timestamp: 1,
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
          },
        ],
      },
    });

    const el = container.querySelector('.msg__text--html');
    expect(el).toBeTruthy();
    expect(el?.querySelector('strong')?.textContent).toBe('bold');
  });

  it('renders a reply preview above a reply message', async () => {
    const { container } = await render(SimpleMessageListComponent, {
      inputs: {
        messages: [
          {
            ...msg('$1', '@a:hs', 'Alice', 1000),
            replyTo: {
              id: '$orig',
              senderName: 'Bob',
              senderInitial: 'B',
              senderAvatarMxc: null,
              body: 'original message',
            },
          },
        ],
      },
    });

    const reply = container.querySelector('.msg__reply');
    expect(reply).toBeTruthy();
    expect(reply?.textContent).toContain('Bob');
    expect(reply?.textContent).toContain('original message');
  });

  it('shows the header on a reply even when it continues the same sender', async () => {
    const { container } = await render(SimpleMessageListComponent, {
      inputs: {
        messages: [
          msg('$1', '@a:hs', 'Alice', 1000),
          {
            // Same sender, well within the 5-min gap → would normally group as a
            // continuation, but a reply must keep its own author + avatar.
            ...msg('$2', '@a:hs', 'Alice', 2000),
            replyTo: {
              id: '$orig',
              senderName: 'Bob',
              senderInitial: 'B',
              senderAvatarMxc: null,
              body: 'original message',
            },
          },
        ],
      },
    });

    const rows = container.querySelectorAll('.msg');
    expect(rows.length).toBe(2);
    // Both rows carry a header (avatar + author); the reply is not a continuation.
    expect(container.querySelectorAll('.msg__avatar').length).toBe(2);
    expect(container.querySelectorAll('.msg--cont').length).toBe(0);
    expect(rows[1].querySelector('.msg__author')?.textContent).toContain(
      'Alice',
    );
    expect(rows[1].querySelector('.msg__reply')?.textContent).toContain('Bob');
  });

  it('editLastOwn selects the most recent editable own message', async () => {
    const { fixture } = await render(SimpleMessageListComponent, {
      inputs: {
        messages: [
          { ...msg('$1', '@me:hs', 'Me', 1000), isOwn: true },
          { ...msg('$2', '@b:hs', 'Bob', 2000) }, // not own → skip
          { ...msg('$3', '@me:hs', 'Me', 3000), isOwn: true }, // latest editable own
          {
            ...msg('$4', '@me:hs', 'Me', 4000),
            isOwn: true,
            kind: 'redacted' as const,
          },
        ],
      },
    });

    const cmp = fixture.componentInstance;
    cmp.editLastOwn();
    expect(cmp.editingId()).toBe('$3');
  });

  it('scrolls the matching row into view when jumpToId is set', async () => {
    let jumped: Element | null = null;
    // jsdom doesn't implement scrollIntoView; stub it on the prototype and
    // capture the element it was invoked on (a regular fn binds `this`).
    Element.prototype.scrollIntoView = vi.fn(function (this: Element) {
      jumped = this;
    });

    const { fixture } = await render(SimpleMessageListComponent, {
      inputs: {
        messages: [
          msg('$1', '@a:hs', 'Alice', 1000),
          msg('$2', '@b:hs', 'Bob', 2000),
        ],
      },
    });

    fixture.componentRef.setInput('jumpToId', '$2');
    fixture.detectChanges();

    expect(jumped).not.toBeNull();
    expect((jumped as unknown as Element).getAttribute('data-mid')).toBe('$2');
  });

  it('re-jumps to the same id when jumpToNonce is bumped', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    // render() paints the rows first (the jump reads the DOM).
    const { fixture } = await render(SimpleMessageListComponent, {
      inputs: {
        messages: [
          msg('$1', '@a:hs', 'Alice', 1000),
          msg('$2', '@b:hs', 'Bob', 2000),
        ],
      },
    });

    fixture.componentRef.setInput('jumpToId', '$2');
    fixture.componentRef.setInput('jumpToNonce', 1);
    fixture.detectChanges();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // Same id, next nonce (as a repeat pinned/search selection does) must re-fire —
    // an unchanged jumpToId alone would be an Object.is no-op and never re-run.
    fixture.componentRef.setInput('jumpToNonce', 2);
    fixture.detectChanges();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('flashes the jumped-to row', async () => {
    Element.prototype.scrollIntoView = vi.fn();

    const { fixture, container } = await render(SimpleMessageListComponent, {
      inputs: {
        messages: [
          msg('$1', '@a:hs', 'Alice', 1000),
          msg('$2', '@b:hs', 'Bob', 2000),
        ],
      },
    });

    fixture.componentInstance.jumpTo('$2');

    const row = container.querySelector('[data-mid="$2"]')!;
    expect(row.classList.contains('msg--flash')).toBe(true);
  });

  it('re-applies the flash class on a repeat jump to the same row', async () => {
    Element.prototype.scrollIntoView = vi.fn();

    const { fixture, container } = await render(SimpleMessageListComponent, {
      inputs: {
        messages: [
          msg('$1', '@a:hs', 'Alice', 1000),
          msg('$2', '@b:hs', 'Bob', 2000),
        ],
      },
    });

    const row = container.querySelector('[data-mid="$2"]')!;

    fixture.componentInstance.jumpTo('$2');
    expect(row.classList.contains('msg--flash')).toBe(true);

    // jsdom never fires `animationend`, so the class is never auto-removed — a
    // second jump must still leave it present (the reflow-reset resets, then
    // re-adds, the class; it can't be observed mid-toggle in jsdom, but the net
    // effect — still flashing — is).
    fixture.componentInstance.jumpTo('$2');
    expect(row.classList.contains('msg--flash')).toBe(true);
  });

  it('emits loadOlder when scrolled near the top (and history remains)', async () => {
    const { fixture, container } = await render(SimpleMessageListComponent, {
      inputs: { canLoadOlder: true },
    });

    let fired = false;
    fixture.componentInstance.loadOlder.subscribe(() => (fired = true));
    // jsdom has no layout, so scrollTop defaults to 0 (within the threshold).
    container.querySelector('.scroll')!.dispatchEvent(new Event('scroll'));

    expect(fired).toBe(true);
  });

  it('does not auto-load when there is no more history', async () => {
    const { fixture, container } = await render(SimpleMessageListComponent, {
      inputs: { canLoadOlder: false },
    });

    let fired = false;
    fixture.componentInstance.loadOlder.subscribe(() => (fired = true));
    container.querySelector('.scroll')!.dispatchEvent(new Event('scroll'));

    expect(fired).toBe(false);
  });

  it('announces a new incoming message, but not the first load or own messages', async () => {
    const { fixture } = await render(SimpleMessageListComponent); // render resolves the scroll viewchild
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
      // A detached TestBed fixture (not ATL render()) is deliberate here: render()
      // attaches the component to ApplicationRef, so the signal write from the
      // synchronous-rAF backfill re-enters the zoneless scheduler ("cannot
      // synchronously execute watches while scheduling"). A detached fixture only
      // ticks on our explicit fixture.detectChanges(), which is what this timing
      // test needs.
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
    const row = (id: string) => ({
      ...msg(id, '@a:hs', 'A', 1),
      showHeader: true,
    });

    async function make() {
      const { fixture } = await render(SimpleMessageListComponent, {
        providers: [MockProvider(TrnAlertService)],
      });
      return fixture.componentInstance;
    }

    it('routes a plain submit to send', async () => {
      const cmp = await make();
      let sent: string | null = null;
      cmp.send.subscribe((s) => (sent = s.body));
      cmp.onSubmit({ text: 'hello', mentions: [] });
      expect(sent).toBe('hello');
    });

    it('derives the typing label from the typing member names', async () => {
      const { fixture } = await render(SimpleMessageListComponent, {
        inputs: { typingNames: [] },
        providers: [MockProvider(TrnAlertService)],
      });
      const cmp = fixture.componentInstance;
      expect(cmp.typingLabel()).toBe('');

      fixture.componentRef.setInput('typingNames', ['Alice', 'Bob']);
      fixture.detectChanges();
      expect(cmp.typingLabel()).toBe('Alice and Bob are typing…');
    });

    it('shows the typing row only while someone is typing', async () => {
      const { fixture, container } = await render(SimpleMessageListComponent, {
        inputs: { typingNames: ['Alice'] },
        providers: [MockProvider(TrnAlertService)],
      });
      const indicator = () => container.querySelector('.typing-indicator');
      expect(indicator()?.textContent?.trim()).toBe('Alice is typing…');

      fixture.componentRef.setInput('typingNames', []);
      fixture.detectChanges();
      expect(indicator()).toBeNull();
    });

    it('routes a submit to editMessage while editing, then clears the target', async () => {
      const cmp = await make();
      let edited: { id: string; body: string } | null = null;
      cmp.editMessage.subscribe((e) => (edited = e));
      cmp.editingId.set('$7');
      cmp.onSubmit({ text: 'fixed', mentions: [] });
      expect(edited).toEqual({ id: '$7', body: 'fixed', mentions: [] });
      expect(cmp.editingId()).toBeNull();
    });

    it('routes a submit to reply while replying, then clears the target', async () => {
      const cmp = await make();
      let replied: { id: string; body: string } | null = null;
      cmp.reply.subscribe((e) => (replied = e));
      cmp.replyingToId.set('$3');
      cmp.onSubmit({ text: 're', mentions: [] });
      expect(replied).toEqual({ id: '$3', body: 're', mentions: [] });
      expect(cmp.replyingToId()).toBeNull();
    });

    it('makes startEdit and startReply mutually exclusive', async () => {
      const cmp = await make();
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
      const cmp = await make();
      const confirm = TestBed.inject(TrnAlertService).confirm;
      const deleted: string[] = [];
      cmp.deleteMessage.subscribe((id) => deleted.push(id));

      vi.mocked(confirm).mockResolvedValueOnce(false);
      await cmp.onDelete(row('$1'));
      expect(deleted).toEqual([]);

      vi.mocked(confirm).mockResolvedValueOnce(true);
      await cmp.onDelete(row('$2'));
      expect(deleted).toEqual(['$2']);
    });

    it('copies a message body to the clipboard', async () => {
      const cmp = await make();
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
