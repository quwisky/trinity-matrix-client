import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { MockProvider } from 'ng-mocks';
import { afterEach, describe, expect, it, beforeEach, vi } from 'vitest';
import { type MessageView } from '@trinity/util/matrix';
import { TrnAlertService } from '@trinity/components/overlay';
import { By } from '@angular/platform-browser';
import { SimpleMessageListComponent } from './simple-message-list.component';
import { MessageComposerComponent } from '../../message-composer/message-composer.component';
import { DayBoundaryService } from '../day-boundary.service';
import { ReactionPickerService } from '../../reaction-picker/reaction-picker.service';
import { MessageSourceService } from '../../message-source/message-source.service';

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
    readReceipts: [],
    poll: null,
  };
}

/** The composer this list renders, for asserting what a quote put into it. */
function composerOf(
  fixture: ComponentFixture<SimpleMessageListComponent>,
): MessageComposerComponent {
  return fixture.debugElement.query(By.directive(MessageComposerComponent))
    .componentInstance as MessageComposerComponent;
}

function eventRow(id: string, summary: string, ts: number): MessageView {
  return {
    ...msg(id, '@a:hs', 'Alice', ts),
    kind: 'event',
    summary,
    body: summary,
  };
}

/** `notAtBottom` drives the jump pill and is protected (template-only); read it
 * through a narrow view rather than widening the component's API for a test. */
const notAtBottom = (cmp: SimpleMessageListComponent): boolean =>
  (cmp as unknown as { notAtBottom: () => boolean }).notAtBottom();

/**
 * An element's text with runs of whitespace collapsed.
 *
 * The typing row interleaves its sentence with empty dot spans, so `textContent` carries
 * interior newlines that a bare `.trim()` only happens to survive.
 */
const text = (el: Element | null | undefined): string =>
  (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

/**
 * The element that follows a divider in the timeline.
 *
 * Dividers are a component now, so the `.day-divider` / `.new-divider` element the tests
 * query sits inside a `<trn-timeline-divider>` host. The host is `display: contents`, so
 * nothing moves on screen — but it IS in the DOM, and the row after the divider is the
 * host's sibling rather than the div's. Walking out to the host keeps these assertions
 * about timeline order rather than about which element happens to wrap what.
 */
const afterDivider = (el: Element | null | undefined): Element | null => {
  const next =
    (el?.closest('trn-timeline-divider') ?? el)?.nextElementSibling ?? null;
  // Unwrap the next divider too, so a caller reading `data-testid` sees the divider itself
  // rather than the host that carries it. A message row is returned untouched.
  return next?.matches('trn-timeline-divider')
    ? (next.firstElementChild ?? next)
    : next;
};

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

  it('renders state events as system lines that break sender grouping', async () => {
    const { container } = await render(SimpleMessageListComponent, {
      inputs: {
        messages: [
          msg('$1', '@a:hs', 'Alice', 1000),
          eventRow('$e', 'Alice changed the room name to "General"', 2000),
          // Same sender as $1, but the event line between them breaks the group.
          msg('$2', '@a:hs', 'Alice', 3000),
        ],
      },
    });

    const line = container.querySelector('[data-testid=timeline-event]');
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain(
      'Alice changed the room name to "General"',
    );
    expect(container.querySelectorAll('.msg--event').length).toBe(1);
    // The message after the event shows its own header, not a continuation.
    expect(container.querySelectorAll('.msg--cont').length).toBe(0);
    expect(container.querySelectorAll('.msg__avatar').length).toBe(2);
  });

  it('marks others’ messages deletable only when canRedactOthers (moderator)', async () => {
    const { fixture } = await render(SimpleMessageListComponent, {
      inputs: {
        messages: [msg('$1', '@a:hs', 'Alice', 1000)], // not own
        canRedactOthers: false,
      },
    });
    const cmp = fixture.componentInstance;
    const row = { ...msg('$1', '@a:hs', 'Alice', 1000), showHeader: true };

    // A regular member can't delete someone else's message.
    expect(cmp.rowCaps(row).deletable).toBe(false);

    // A moderator (canRedactOthers) can.
    fixture.componentRef.setInput('canRedactOthers', true);
    expect(cmp.rowCaps(row).deletable).toBe(true);
  });

  it('offers quoting for text but not for media, and re-issues caps when it changes', async () => {
    const text = msg('$1', '@a:hs', 'Alice', 1000);
    const media: MessageView = {
      ...msg('$2', '@a:hs', 'Alice', 2000),
      kind: 'image',
      body: 'IMG_1234.jpg',
    };
    const { fixture } = await render(SimpleMessageListComponent, {
      providers: [MockProvider(TrnAlertService)],
      inputs: { messages: [text, media] },
    });
    const cmp = fixture.componentInstance;

    expect(cmp.rowCaps({ ...text, showHeader: true }).canQuote).toBe(true);
    // A media body is the filename; quoting it helps nobody.
    expect(cmp.rowCaps({ ...media, showHeader: true }).canQuote).toBe(false);

    // Caps objects are reused by identity unless something changed, so `canQuote` has to
    // be part of that comparison or a message becoming quotable would never reach the row.
    const before = cmp.rowCaps({ ...media, showHeader: true });
    fixture.componentRef.setInput('messages', [
      text,
      { ...media, kind: 'text', body: 'now quotable' },
    ]);
    expect(cmp.rowCaps({ ...media, showHeader: true })).not.toBe(before);
    expect(cmp.rowCaps({ ...media, showHeader: true }).canQuote).toBe(true);
  });

  it('withholds threading and pinning from a message that is still unsent', async () => {
    // A local echo is keyed by the SDK's `~roomId:txnId` placeholder. Threading off it
    // would make that placeholder the thread root — `ThreadsService` then can't fetch
    // the root and every reply is dropped — and pinning it would write the placeholder
    // into `m.room.pinned_events`. Both only make sense once the echo is confirmed.
    const sending: MessageView = {
      ...msg('~!r:hs:m1.0', '@me:hs', 'Me', 1000),
      isOwn: true,
      status: 'sending',
    };
    const { fixture } = await render(SimpleMessageListComponent, {
      inputs: { messages: [sending], canPin: true },
    });
    const cmp = fixture.componentInstance;

    const pending = cmp.rowCaps({ ...sending, showHeader: true });
    expect(pending.canThread).toBe(false);
    expect(pending.canPin).toBe(false);

    // The remote echo swaps in the server's event id and clears the status.
    const confirmed: MessageView = { ...sending, id: '$1', status: null };
    fixture.componentRef.setInput('messages', [confirmed]);
    const caps = cmp.rowCaps({ ...confirmed, showHeader: true });
    expect(caps.canThread).toBe(true);
    expect(caps.canPin).toBe(true);
  });

  it('keeps each row’s caps object identical when nothing about them changed', async () => {
    // `caps` is an input<MessageRowCaps> on the OnPush MessageRowComponent, so it is
    // compared by Object.is. TimelineService mints a NEW messages array on every
    // timeline event, so minting fresh caps objects per rebuild would re-render EVERY
    // rendered row (each pulling ~12 child components) on every incoming message —
    // defeating the rowCache right next to this, which exists to preserve row identity.
    const first = msg('$1', '@a:hs', 'Alice', 1000);
    const { fixture } = await render(SimpleMessageListComponent, {
      inputs: { messages: [first], canRedactOthers: false },
    });
    const cmp = fixture.componentInstance;
    const row = { ...first, showHeader: true };
    const before = cmp.rowCaps(row);

    // A new message arrives: a new array (new identity), same caps for the old row.
    fixture.componentRef.setInput('messages', [
      first,
      msg('$2', '@b:hs', 'Bob', 2000),
    ]);

    expect(cmp.rowCaps(row)).toBe(before); // same object, not merely equal

    // But a real capability change must still produce a new object.
    fixture.componentRef.setInput('canRedactOthers', true);
    expect(cmp.rowCaps(row)).not.toBe(before);
    expect(cmp.rowCaps(row).deletable).toBe(true);
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
            readReceipts: [],
            poll: null,
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
      // Capturing `this` IS the assertion: a regular (non-arrow) fn binds the element
      // scrollIntoView was invoked on, which is the only way to learn WHICH row was
      // scrolled to. The directive must sit immediately above the reported line.
      // eslint-disable-next-line @typescript-eslint/no-this-alias
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

  it('shows the jump-to-latest pill when scrolled up and returns to the bottom', async () => {
    const scrollToSpy = vi.fn();
    Element.prototype.scrollTo =
      scrollToSpy as unknown as typeof Element.prototype.scrollTo;

    const { fixture, container } = await render(SimpleMessageListComponent, {
      inputs: {
        messages: [
          msg('$1', '@a:hs', 'Alice', 1000),
          msg('$2', '@b:hs', 'Bob', 2000),
        ],
      },
    });
    const cmp = fixture.componentInstance;
    const scroll = container.querySelector('.scroll') as HTMLElement;

    // jsdom has no layout, so fake a scrolled-up viewport: not near the bottom
    // (>120px away) and past the auto-load threshold (>150px from the top).
    Object.defineProperty(scroll, 'scrollHeight', {
      value: 1000,
      configurable: true,
    });
    Object.defineProperty(scroll, 'clientHeight', {
      value: 400,
      configurable: true,
    });
    Object.defineProperty(scroll, 'scrollTop', {
      value: 200,
      writable: true,
      configurable: true,
    });
    scroll.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();

    expect(notAtBottom(cmp)).toBe(true);
    const pill = container.querySelector<HTMLButtonElement>(
      '[data-testid=jump-to-latest]',
    );
    expect(pill).not.toBeNull();

    // Jumping scrolls to the newest message and hides the pill.
    pill!.click();
    fixture.detectChanges();

    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: 'smooth' });
    expect(notAtBottom(cmp)).toBe(false);
    expect(container.querySelector('[data-testid=jump-to-latest]')).toBeNull();
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

    // A window that projects to NOTHING (every row hidden by a timeline filter) must still
    // pull history: there are no rows, so there is no scrollbar and onScroll can never fire
    // — without this the room is stuck showing "No messages yet." forever.
    it('backfills an empty projection that still has history behind it', () => {
      const fixture = TestBed.createComponent(SimpleMessageListComponent);
      fixture.componentRef.setInput('canLoadOlder', true);
      fixture.detectChanges();

      let emits = 0;
      fixture.componentInstance.loadOlder.subscribe(() => emits++);

      // Zero rendered rows, but the raw window has events behind them.
      fixture.componentRef.setInput('messages', []);
      fixture.componentRef.setInput('oldestEventId', '$join');
      fixture.detectChanges();
      expect(emits).toBe(1);

      // The next page is also entirely hidden — still no rows, but the raw oldest moved,
      // so the loop keeps going rather than concluding "nothing was prepended".
      fixture.componentRef.setInput('oldestEventId', '$older-join');
      fixture.detectChanges();
      expect(emits).toBe(2);
    });

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

      // Round 1: a short, unscrollable timeline → request older history. The guard reads
      // the oldest RAW event (what the page binds from TimelineService), not the oldest
      // rendered row — rows can be filtered out of the projection entirely.
      fixture.componentRef.setInput('messages', [
        msg('$b', '@a:hs', 'A', 2000),
        msg('$c', '@a:hs', 'A', 3000),
      ]);
      fixture.componentRef.setInput('oldestEventId', '$b');
      fixture.detectChanges();
      expect(emits).toBe(1);

      // The load prepended $a but a redaction dropped $b — SAME length (2),
      // newest unchanged ($c). The old count-based guard would stop here; the
      // id-based guard sees the oldest move $b→$a and keeps going.
      fixture.componentRef.setInput('messages', [
        msg('$a', '@a:hs', 'A', 1000),
        msg('$c', '@a:hs', 'A', 3000),
      ]);
      fixture.componentRef.setInput('oldestEventId', '$a');
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

    it('reacts with the emoji chosen from the full picker on react-more', async () => {
      const { fixture } = await render(SimpleMessageListComponent, {
        providers: [
          MockProvider(TrnAlertService),
          MockProvider(ReactionPickerService, {
            pick: () => Promise.resolve('🚀'),
          }),
        ],
      });
      const cmp = fixture.componentInstance;
      let reacted: { id: string; key: string } | null = null;
      cmp.react.subscribe((r) => (reacted = r));

      cmp.onRowAction(row('$7'), { type: 'react-more' });
      await Promise.resolve(); // let the picker promise settle

      expect(reacted).toEqual({ id: '$7', key: '🚀' });
    });

    it('sends no reaction when the picker is dismissed', async () => {
      const { fixture } = await render(SimpleMessageListComponent, {
        providers: [
          MockProvider(TrnAlertService),
          MockProvider(ReactionPickerService, {
            pick: () => Promise.resolve(null),
          }),
        ],
      });
      const cmp = fixture.componentInstance;
      let reacted = false;
      cmp.react.subscribe(() => (reacted = true));

      cmp.onRowAction(row('$7'), { type: 'react-more' });
      await Promise.resolve();

      expect(reacted).toBe(false);
    });

    // The detail lives in `typing-indicator.component.spec.ts`; what the list owes is the
    // wiring — its own typingNames input reaching the child that renders them.
    it('feeds the typing names to the indicator', async () => {
      const { fixture, container } = await render(SimpleMessageListComponent, {
        inputs: { typingNames: ['Alice', 'Bob'] },
        providers: [MockProvider(TrnAlertService)],
      });
      expect(text(container.querySelector('.typing-indicator'))).toBe(
        'Alice and Bob are typing',
      );

      fixture.componentRef.setInput('typingNames', []);
      fixture.detectChanges();
      expect(container.querySelector('.typing-indicator')).toBeNull();
      // The slot stays: it is what keeps the scroll region from resizing.
      expect(container.querySelector('.typing-slot')).not.toBeNull();
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

    it('quotes a message into the composer as a > block', async () => {
      const { fixture } = await render(SimpleMessageListComponent, {
        providers: [MockProvider(TrnAlertService)],
        inputs: { messages: [msg('$1', '@a:hs', 'Alice', 1000)] },
      });
      const cmp = fixture.componentInstance;

      cmp.onRowAction(
        { ...msg('$1', '@a:hs', 'Alice', 1000), showHeader: true },
        {
          type: 'quote',
        },
      );

      expect(composerOf(fixture).text()).toBe('> body $1\n\n');
    });

    it('cancels an edit when quoting, but keeps the reply target', async () => {
      const { fixture } = await render(SimpleMessageListComponent, {
        providers: [MockProvider(TrnAlertService)],
        inputs: { messages: [msg('$1', '@a:hs', 'Alice', 1000)] },
      });
      const cmp = fixture.componentInstance;
      cmp.editingId.set('$9');
      cmp.replyingToId.set('$7');

      cmp.startQuote({
        ...msg('$1', '@a:hs', 'Alice', 1000),
        showHeader: true,
      });

      // Editing holds the original's body in the composer — inserting a quote there would
      // rewrite that message rather than answer it. A reply is a send target, not composer
      // content, so quoting while replying composes rather than conflicts.
      expect(cmp.editingId()).toBeNull();
      expect(cmp.replyingToId()).toBe('$7');
    });

    it('keeps the quote when it interrupts an edit', async () => {
      // The composer restores the compose draft when it LEAVES edit mode, and that
      // restore is an unconditional `text.set(...)`. startQuote clears editingId and
      // inserts in the same tick, so the input only flips on the next change detection —
      // after the insert. Without ordering the two, the restore lands last and the quote
      // is silently discarded.
      const { fixture } = await render(SimpleMessageListComponent, {
        providers: [MockProvider(TrnAlertService)],
        inputs: {
          roomId: '!r:hs',
          messages: [msg('$1', '@a:hs', 'Alice', 1000)],
        },
      });
      const cmp = fixture.componentInstance;

      cmp.startEdit({ ...msg('$1', '@a:hs', 'Alice', 1000), showHeader: true });
      fixture.detectChanges();
      expect(composerOf(fixture).text()).toBe('body $1');

      cmp.startQuote({
        ...msg('$1', '@a:hs', 'Alice', 1000),
        showHeader: true,
      });
      fixture.detectChanges();
      await Promise.resolve();

      expect(composerOf(fixture).text()).toBe('> body $1\n\n');
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

    it('copies a matrix.to permalink for copy-link', async () => {
      const { fixture } = await render(SimpleMessageListComponent, {
        inputs: { roomId: '!a:hs' },
        providers: [MockProvider(TrnAlertService)],
      });
      const writeText = vi.fn();
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText },
        configurable: true,
      });

      fixture.componentInstance.onRowAction(row('$1'), { type: 'copy-link' });

      // A room-ID permalink carries a `?via=` routing hint (the room's origin server).
      expect(writeText).toHaveBeenCalledWith(
        'https://matrix.to/#/!a%3Ahs/%241?via=hs',
      );
    });

    it('opens the source dialog for view-source', async () => {
      const open = vi.fn();
      const { fixture } = await render(SimpleMessageListComponent, {
        inputs: { roomId: '!a:hs' },
        providers: [
          MockProvider(TrnAlertService),
          MockProvider(MessageSourceService, { open }),
        ],
      });

      fixture.componentInstance.onRowAction(row('$1'), {
        type: 'view-source',
      });

      expect(open).toHaveBeenCalledWith('!a:hs', '$1');
    });
  });

  describe('unread divider', () => {
    const three = [
      msg('$1', '@a:hs', 'Alice', 1000),
      msg('$2', '@a:hs', 'Alice', 2000),
      msg('$3', '@a:hs', 'Alice', 3000),
    ];

    it('renders a "New messages" divider before the first unread row', async () => {
      const { container } = await render(SimpleMessageListComponent, {
        inputs: { messages: three, firstUnreadId: '$2' },
      });

      const divider = container.querySelector(
        '[data-testid=new-messages-divider]',
      );
      expect(divider).not.toBeNull();
      // The divider sits immediately before the $2 row.
      expect(
        afterDivider(divider)
          ?.querySelector('[data-mid]')
          ?.getAttribute('data-mid'),
      ).toBe('$2');
    });

    it('renders no divider when nothing is unread', async () => {
      const { container } = await render(SimpleMessageListComponent, {
        inputs: { messages: three, firstUnreadId: null },
      });
      expect(
        container.querySelector('[data-testid=new-messages-divider]'),
      ).toBeNull();
    });

    it('jumpToUnread scrolls to the first unread message', async () => {
      const { fixture } = await render(SimpleMessageListComponent, {
        inputs: { messages: three, firstUnreadId: '$2' },
      });
      const cmp = fixture.componentInstance;
      const jumpTo = vi.spyOn(cmp, 'jumpTo');

      cmp.jumpToUnread();

      expect(jumpTo).toHaveBeenCalledWith('$2');
    });
  });

  describe('day separators', () => {
    /**
     * "Today" for these tests. Built with the local-time `Date` constructor rather than a
     * literal epoch so every case holds in any timezone, and injected through a stubbed
     * DayBoundaryService — faking the clock instead would swallow the `requestAnimationFrame`
     * the base's constructor effect schedules.
     */
    const TODAY = new Date(2026, 6, 24).getTime();

    /** Local `hh:mm` on a day offset from TODAY, as epoch ms. */
    function at(
      dayOffset: number,
      hour: number,
      minute = 0,
      second = 0,
    ): number {
      return new Date(2026, 6, 24 + dayOffset, hour, minute, second).getTime();
    }

    function renderDays(
      messages: MessageView[],
      inputs: Record<string, unknown> = {},
      todayStart = signal(TODAY),
    ) {
      return render(SimpleMessageListComponent, {
        inputs: { messages, ...inputs },
        providers: [{ provide: DayBoundaryService, useValue: { todayStart } }],
      });
    }

    const separators = (container: Element) =>
      Array.from(container.querySelectorAll('[data-testid=day-separator]'));

    // safeBuildMessageView degrades an unreadable origin_server_ts to 0. Bucketing that as a
    // real day mints a "1 January 1970" separator above it AND a second one on the next real
    // message, which is compared against 1970 rather than against the last real day.
    it('mints no 1970 separator for a message with no usable timestamp', async () => {
      const stranded = { ...msg('$x', '@a:hs', 'Alice', 0), timestamp: 0 };
      const { container } = await renderDays([
        msg('$1', '@a:hs', 'Alice', at(-1, 10)),
        stranded,
        msg('$2', '@b:hs', 'Bob', at(0, 10)),
      ]);

      const found = separators(container);
      expect(found.map((el) => el.textContent?.trim())).toEqual(['Today']);
      // On the day-2 row, not on the stranded one: the malformed row inherits the day
      // around it rather than opening one of its own.
      expect(
        afterDivider(found[0])
          ?.querySelector('[data-mid]')
          ?.getAttribute('data-mid'),
      ).toBe('$2');
    });

    // Two messages from one sender 40 seconds apart are a continuation by the 5-minute
    // grouping rule — but across midnight a separator lands between them, and a headerless,
    // avatar-less row directly under it reads as if the message lost its author.
    it('breaks sender grouping when the day changes mid-conversation', async () => {
      const { container } = await renderDays([
        msg('$1', '@a:hs', 'Alice', at(-1, 23, 59, 40)),
        msg('$2', '@a:hs', 'Alice', at(0, 0, 0, 20)),
      ]);

      expect(separators(container).length).toBe(1);
      expect(container.querySelectorAll('.msg--cont').length).toBe(0);
      expect(container.querySelectorAll('.msg__avatar').length).toBe(2);
    });

    it('separates each day change and leaves the first row alone', async () => {
      const { container } = await renderDays([
        msg('$1', '@a:hs', 'Alice', at(-2, 10)),
        msg('$2', '@a:hs', 'Alice', at(-1, 10)),
        msg('$3', '@b:hs', 'Bob', at(0, 10)),
      ]);

      // Two changes across three days — the loaded window is an arbitrary slice of history,
      // so the row that opens it gets nothing above it.
      const found = separators(container);
      expect(found.map((el) => el.textContent?.trim())).toEqual([
        'Yesterday',
        'Today',
      ]);
      expect(
        found.map((el) =>
          afterDivider(el)
            ?.querySelector('[data-mid]')
            ?.getAttribute('data-mid'),
        ),
      ).toEqual(['$2', '$3']);
    });

    it('renders no separator when the whole window is one day', async () => {
      const { container } = await renderDays([
        msg('$1', '@a:hs', 'Alice', at(0, 9)),
        msg('$2', '@b:hs', 'Bob', at(0, 14)),
        msg('$3', '@a:hs', 'Alice', at(0, 23, 59)),
      ]);

      expect(separators(container).length).toBe(0);
    });

    it('puts the day separator above the unread divider, not below it', async () => {
      const { container } = await renderDays(
        [
          msg('$1', '@a:hs', 'Alice', at(-1, 10)),
          msg('$2', '@b:hs', 'Bob', at(0, 10)),
        ],
        { firstUnreadId: '$2' },
      );

      // "Today / New messages / the row" reads as a sentence; the other order says the day
      // changed after the unread boundary.
      const unread = afterDivider(separators(container)[0]);
      expect(unread?.getAttribute('data-testid')).toBe('new-messages-divider');
      expect(
        afterDivider(unread)
          ?.querySelector('[data-mid]')
          ?.getAttribute('data-mid'),
      ).toBe('$2');
    });

    // Separators are derived from the projected list, which TimelineService has already
    // filtered (#24). A day whose every event was a hidden system line therefore leaves no
    // rows — and must leave no separator either, rather than a bare date with nothing under
    // it. Both the run-boundary and mid-run shapes, since only the latter exercises the
    // "compare against the last surviving row" path.
    it.each([
      ['at a run boundary', [-2, 0]],
      ['mid-run', [-2, -2, 0, 0]],
    ])(
      'skips a day whose rows were all filtered out (%s)',
      async (_l, days) => {
        const { container } = await renderDays(
          days.map((offset, i) =>
            msg(`$${i}`, '@a:hs', 'Alice', at(offset, 10 + i)),
          ),
        );

        expect(
          separators(container).map((el) => el.textContent?.trim()),
        ).toEqual(['Today']);
      },
    );

    // The staleness the row cache would otherwise hide: the row itself did not change, only
    // what sits above it did.
    it('re-mints a row when backfill gives it a separator it did not have', async () => {
      const today = [
        msg('$2', '@a:hs', 'Alice', at(0, 10)),
        msg('$3', '@a:hs', 'Alice', at(0, 11)),
      ];
      const { fixture } = await renderDays(today);
      const cmp = fixture.componentInstance;
      const before = cmp.rows()[0];

      expect(before.daySeparator).toBeNull();

      // A page of older history arrives: $2 now opens a day it did not open before.
      fixture.componentRef.setInput('messages', [
        msg('$1', '@a:hs', 'Alice', at(-1, 10)),
        ...today,
      ]);

      const after = cmp.rows()[1];
      expect(after.daySeparator).toBe('Today');
      expect(after).not.toBe(before); // a new object, or OnPush never re-renders it
    });

    it('keeps row identity when a rebuild changes nothing', async () => {
      const messages = [
        msg('$1', '@a:hs', 'Alice', at(-1, 10)),
        msg('$2', '@a:hs', 'Alice', at(0, 10)),
      ];
      const { fixture } = await renderDays(messages);
      const cmp = fixture.componentInstance;
      const before = cmp.rows();

      // TimelineService mints a new array on every timeline event; the views inside it are
      // reused, and so must the rows be.
      fixture.componentRef.setInput('messages', [...messages]);

      expect(cmp.rows()[0]).toBe(before[0]);
      expect(cmp.rows()[1]).toBe(before[1]);
    });

    it('re-labels the separator when the day turns over under an open room', async () => {
      const todayStart = signal(TODAY);
      const { container, fixture } = await renderDays(
        [
          msg('$1', '@a:hs', 'Alice', at(-1, 10)),
          msg('$2', '@a:hs', 'Alice', at(0, 10)),
        ],
        {},
        todayStart,
      );
      expect(separators(container)[0]?.textContent?.trim()).toBe('Today');

      // Midnight: what was "Today" is now "Yesterday". Nothing about the messages changed,
      // so only the label re-deriving can move this.
      todayStart.set(new Date(2026, 6, 25).getTime());
      fixture.detectChanges();

      expect(separators(container)[0]?.textContent?.trim()).toBe('Yesterday');
    });
  });

  it('stages files dropped on the conversation, and shows the target while dragging', async () => {
    // The drop target is the whole room, which this component owns — but staging belongs to
    // the composer, two layers down. This is the wiring between them, and nothing else
    // exercises it: the directive's own spec stops at the output.
    const { fixture, container } = await render(SimpleMessageListComponent, {
      inputs: { messages: [msg('$1', '@a:hs', 'Alice', 1000)] },
    });
    const host = fixture.nativeElement as HTMLElement;
    const fire = (name: string, files: File[] = []) => {
      const event = new Event(name, { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'dataTransfer', {
        value: { types: ['Files'], files, dropEffect: 'none' },
      });
      host.dispatchEvent(event);
      fixture.detectChanges();
    };

    expect(container.querySelector('[data-testid=drop-overlay]')).toBeNull();

    fire('dragenter');
    expect(
      container.querySelector('[data-testid=drop-overlay]'),
    ).not.toBeNull();
    // The frame is what marks out the droppable region. Its geometry and the sheet's tint are
    // measured in Chromium by `pnpm e2e:media` — jsdom evaluates neither `color-mix()` nor
    // layout, which is how a background that resolved to nothing at all once shipped.
    expect(container.querySelector('.drop-overlay__frame')).not.toBeNull();

    fire('drop', [new File(['x'], 'dropped.png', { type: 'image/png' })]);

    expect(container.querySelector('[data-testid=drop-overlay]')).toBeNull();
    expect(
      Array.from(
        container.querySelectorAll('[data-testid=composer-pending]'),
      ).map((row) => row.textContent?.trim()),
    ).toEqual([expect.stringContaining('dropped.png')]);
  });

  it('sends a batch caption plainly, and is actually wired to do so', async () => {
    // Emitted from the COMPOSER so the template binding is what carries it. Calling
    // `onBatchCaption()` directly passes even with the binding deleted — which is exactly how
    // the thread shipped without one, since an unbound output is legal and the AOT build is
    // silent about it.
    const { fixture } = await render(SimpleMessageListComponent, {
      inputs: { messages: [msg('$1', '@a:hs', 'Alice', 1000)] },
    });
    const cmp = fixture.componentInstance;
    const sent: string[] = [];
    const edited: string[] = [];
    cmp.send.subscribe((e) => sent.push(e.body));
    cmp.editMessage.subscribe((e) => edited.push(e.body));
    cmp.editingId.set('$1'); // an edit started while the files were uploading

    fixture.debugElement
      .query(By.directive(MessageComposerComponent))
      .componentInstance.submitBatchCaption.emit({
        text: 'both of these',
        mentions: [],
      });

    expect(sent).toEqual(['both of these']);
    expect(edited).toEqual([]);
  });
});
