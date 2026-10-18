import { TestBed } from '@angular/core/testing';
import {
  ConversationRuntime,
  type MessageView,
} from '@trinity/data-access/timeline';
import { render } from '@trinity/testing';
import { MockComponent } from 'ng-mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import {
  ConversationComposeStub,
  ConversationMessagesStub,
} from '../testing/conversation-timeline.stub';
import { MessageListComponent } from './message-list.component';
import { TimelineScrollActivity } from '../shared/timeline-scroll-activity';
import { setScrollGeometry } from '../testing/scroll-geometry.stub';

/** The fixed estimate an unmeasured row is counted at with the flag off. */
const EST = 64;

function msg(id: string, ts: number): MessageView {
  return {
    id,
    senderId: '@a:hs',
    senderName: 'A',
    senderInitial: 'A',
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

const many = (n: number, prefix = '$') =>
  Array.from({ length: n }, (_, i) => msg(`${prefix}${i}`, 1000 + i * 10_000));

/** `$a`..`$b` inclusive, the ids of a run of rows. */
const range = (a: number, b: number) =>
  Array.from({ length: b - a + 1 }, (_, i) => `$${a + i}`);

interface TestRO {
  observed: Set<Element>;
  emit(entries: ResizeObserverEntry[]): void;
}

function rowObserver(): TestRO {
  const ro = (
    ResizeObserver as unknown as { instances: TestRO[] }
  ).instances.find((o) => [...o.observed].some((el) => el.matches?.('.msg')));
  if (!ro) throw new Error('row ResizeObserver not found');
  return ro;
}

function resizeEntry(target: Element, height: number): ResizeObserverEntry {
  return {
    target,
    borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
    contentRect: { height } as DOMRectReadOnly,
  } as unknown as ResizeObserverEntry;
}

describe('MessageListComponent: blank rows while scrolling fast', () => {
  let clock: number;
  let st: number;
  const ownScrollIntoView = Element.prototype.scrollIntoView;

  beforeEach(() => {
    const compose = new ConversationComposeStub();
    TestBed.overrideProvider(ConversationRuntime, {
      useValue: { compose, messages: new ConversationMessagesStub(compose) },
    });
    vi.stubGlobal('requestAnimationFrame', () => 0);
    (ResizeObserver as unknown as { instances: unknown[] }).instances.length =
      0;
    clock = 0;
    st = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => clock);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach(() => {
    Element.prototype.scrollIntoView = ownScrollIntoView;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function renderList(
    inputs: Partial<{
      messages: MessageView[];
      flingPlaceholders: boolean;
      canLoadOlder: boolean;
    }> = {},
  ) {
    const rendered = await render(MessageListComponent, {
      inputs: { messages: many(200), ...inputs },
      imports: [MockComponent(MessageComposerComponent)],
    });
    const scroll = rendered.container.querySelector('.scroll') as HTMLElement;
    setScrollGeometry(scroll, {
      scrollTop: {
        get: () => st,
        set: (value: number) => (st = Math.max(0, value)),
      },
      clientHeight: 600,
      scrollHeight: () => 200 * EST,
    });
    return { ...rendered, scroll };
  }

  /** The reader moves the list to `top` at `at` ms, and the list renders. */
  function scrollTo(
    fixture: { detectChanges(): void },
    scroll: HTMLElement,
    top: number,
    at: number,
  ): void {
    clock = at;
    st = top;
    scroll.dispatchEvent(new Event('scroll'));
    fixture.detectChanges();
  }

  /**
   * jsdom lays nothing out: put the scroller at the top of the page and the rows' region at
   * the top of its content, so offsets read as they would in a browser.
   */
  function layOutRegion(scroll: HTMLElement): void {
    scroll.getBoundingClientRect = () => ({ top: 0, bottom: 600 }) as DOMRect;
    const vpad = scroll.querySelector('.vpad') as HTMLElement;
    vpad.getBoundingClientRect = () => ({ top: -st, bottom: -st }) as DOMRect;
  }

  const realIds = (root: Element) =>
    Array.from(root.querySelectorAll('.msg[data-mid]')).map((el) =>
      el.getAttribute('data-mid'),
    );
  const placeholderIds = (root: Element) =>
    Array.from(root.querySelectorAll('[data-placeholder-mid]')).map((el) =>
      el.getAttribute('data-placeholder-mid'),
    );

  it('renders every row in full however fast the list moves, with the flag off', async () => {
    const { fixture, container, scroll } = await renderList();
    scrollTo(fixture, scroll, 5000, 0);

    scrollTo(fixture, scroll, 5640, 100); // 6,400 px/s

    expect(placeholderIds(container)).toEqual([]);
    expect(realIds(container)).toEqual(range(75, 100));
  });

  it('leaves the scroll activity alone across jumps, with the flag off', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { fixture, scroll } = await renderList();
    const activity = fixture.debugElement.injector.get(TimelineScrollActivity);
    scrollTo(fixture, scroll, 5000, 0);
    vi.advanceTimersByTime(150);
    fixture.detectChanges();
    expect(activity.active).toBe(false);
    layOutRegion(scroll);

    // A jump to a row on screen scrolls nothing; one off screen writes the position itself;
    // neither is the reader scrolling, so hover work (the row toolbar) is not held back.
    fixture.componentInstance.jumpTo('$80');
    fixture.componentInstance.jumpTo('$150');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.componentInstance.scrollToLatest();

    expect(activity.active).toBe(false);
  });

  describe('with the flag on', () => {
    async function flingFrom5000() {
      const rendered = await renderList({ flingPlaceholders: true });
      // At rest at 5000: rows $65–$90 are in the window (±800 px overscan).
      scrollTo(rendered.fixture, rendered.scroll, 5000, 0);
      expect(realIds(rendered.container)).toEqual(range(65, 90));
      return rendered;
    }

    it('shows rows entering the window during a fling as blank placeholders, and keeps the rows already there', async () => {
      const { fixture, container, scroll } = await flingFrom5000();

      scrollTo(fixture, scroll, 5640, 100); // 6,400 px/s

      expect(realIds(container)).toEqual(range(75, 90));
      expect(placeholderIds(container)).toEqual(range(91, 100));
      const placeholder = container.querySelector(
        '[data-placeholder-mid="$91"]',
      ) as HTMLElement;
      expect(placeholder.getAttribute('aria-hidden')).toBe('true');
      expect(placeholder.style.height).toBe(`${EST}px`);
    });

    it('does not start below 3,000 px/s', async () => {
      const { fixture, container, scroll } = await flingFrom5000();

      scrollTo(fixture, scroll, 5280, 100); // 2,800 px/s

      expect(placeholderIds(container)).toEqual([]);
    });

    it('stands a placeholder in at the row’s measured height', async () => {
      const { fixture, container, scroll } = await flingFrom5000();
      const row = container.querySelector('[data-mid="$70"]') as Element;
      rowObserver().emit([resizeEntry(row, 100)]);
      fixture.detectChanges();
      const top = st;

      scrollTo(fixture, scroll, top + 1280, 100); // away: $70 leaves
      scrollTo(fixture, scroll, top, 200); // and back, still flinging

      const placeholder = container.querySelector(
        '[data-placeholder-mid="$70"]',
      ) as HTMLElement;
      expect(placeholder.style.height).toBe('100px');
    });

    it('mounts the real rows once the scroll settles', async () => {
      const { fixture, container, scroll } = await flingFrom5000();
      scrollTo(fixture, scroll, 5640, 100);

      vi.advanceTimersByTime(150);
      fixture.detectChanges();

      expect(placeholderIds(container)).toEqual([]);
      expect(realIds(container)).toEqual(range(75, 100));
    });

    it('mounts the real rows as soon as the scroll slows to reading speed', async () => {
      const { fixture, container, scroll } = await flingFrom5000();
      scrollTo(fixture, scroll, 5640, 100);

      scrollTo(fixture, scroll, 5780, 200); // 1,400 px/s

      expect(placeholderIds(container)).toEqual([]);
    });

    it('keeps a row on screen as the same element, focus and all, through the fling', async () => {
      const { fixture, container, scroll } = await flingFrom5000();
      const row = container.querySelector('[data-mid="$85"]') as HTMLElement;
      row.focus();
      const focused = document.activeElement;

      scrollTo(fixture, scroll, 5640, 100);
      vi.advanceTimersByTime(150);
      fixture.detectChanges();

      expect(container.querySelector('[data-mid="$85"]')).toBe(row);
      expect(document.activeElement).toBe(focused);
    });

    it('ends the fling for a jump and reveals the real row', async () => {
      Element.prototype.scrollIntoView = vi.fn();
      const { fixture, container, scroll } = await flingFrom5000();
      scrollTo(fixture, scroll, 5640, 100);
      expect(placeholderIds(container)).toContain('$95');

      layOutRegion(scroll);
      fixture.componentInstance.jumpTo('$95');
      scroll.dispatchEvent(new Event('scroll')); // the browser's event for the jump
      fixture.detectChanges();
      await fixture.whenStable();

      expect(placeholderIds(container)).toEqual([]);
      const target = container.querySelector('[data-mid="$95"]');
      expect(target?.classList.contains('msg')).toBe(true);
      expect(target?.classList.contains('msg--flash')).toBe(true);
    });

    it('does not take a jump made mid-scroll for a fling', async () => {
      Element.prototype.scrollIntoView = vi.fn();
      const { fixture, container, scroll } = await flingFrom5000();
      scrollTo(fixture, scroll, 5100, 50); // 2,000 px/s: reading

      layOutRegion(scroll);
      clock = 60;
      fixture.componentInstance.jumpTo('$150');
      scroll.dispatchEvent(new Event('scroll'));
      fixture.detectChanges();
      await fixture.whenStable();

      expect(placeholderIds(container)).toEqual([]);
      expect(container.querySelector('.msg[data-mid="$150"]')).not.toBeNull();
    });

    it('never takes a smooth jump for a fling', async () => {
      Element.prototype.scrollIntoView = vi.fn();
      const { fixture, container, scroll } = await flingFrom5000();
      layOutRegion(scroll);

      fixture.componentInstance.jumpTo('$88');
      // The browser animates the jump: about 12,000 px/s at its fastest.
      scrollTo(fixture, scroll, 5200, 16);
      scrollTo(fixture, scroll, 5400, 32);
      scrollTo(fixture, scroll, 5600, 48);

      expect(placeholderIds(container)).toEqual([]);
    });

    it('lets a fling start again once a jump has settled', async () => {
      Element.prototype.scrollIntoView = vi.fn();
      const { fixture, container, scroll } = await flingFrom5000();
      layOutRegion(scroll);
      scrollTo(fixture, scroll, 5640, 100);
      fixture.componentInstance.jumpTo('$88');
      scrollTo(fixture, scroll, 5840, 116); // the jump's animation
      expect(placeholderIds(container)).toEqual([]);

      vi.advanceTimersByTime(150);
      scrollTo(fixture, scroll, 5840, 1_000);
      scrollTo(fixture, scroll, 6480, 1_100); // the reader flings again

      expect(placeholderIds(container).length).toBeGreaterThan(0);
    });

    it('does not take a height correction under steady reading for a fling', async () => {
      const { fixture, container, scroll } = await flingFrom5000();
      layOutRegion(scroll);
      scrollTo(fixture, scroll, 5120, 100); // 1,200 px/s

      // A row above the reader is measured 236 px taller; the list corrects, and the browser
      // reports that together with the reader's next 120 px.
      const row = container.querySelector('[data-mid="$70"]') as Element;
      rowObserver().emit([resizeEntry(row, 300)]);
      expect(st).toBe(5120 + 236);
      scrollTo(fixture, scroll, 5120 + 236 + 120, 200);

      expect(placeholderIds(container)).toEqual([]);
    });

    it('ends the fling when the reader jumps to the newest message', async () => {
      const { fixture, container, scroll } = await flingFrom5000();
      scrollTo(fixture, scroll, 5640, 100);

      fixture.componentInstance.scrollToLatest();
      fixture.detectChanges();

      expect(placeholderIds(container)).toEqual([]);
    });

    it('mounts the real rows when the flag is turned off mid-fling', async () => {
      const { fixture, container, scroll } = await flingFrom5000();
      scrollTo(fixture, scroll, 5640, 100);

      fixture.componentRef.setInput('flingPlaceholders', false);
      fixture.detectChanges();

      expect(placeholderIds(container)).toEqual([]);
      expect(realIds(container)).toEqual(range(75, 100));
    });

    it('keeps the reader’s place when history lands under placeholders', async () => {
      const { fixture, scroll } = await renderList({
        flingPlaceholders: true,
        canLoadOlder: true,
      });
      // A layout of uniform rows: each row's box from its place in the list.
      const cmp = fixture.componentInstance;
      const own = Element.prototype.getBoundingClientRect;
      vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(
        function (this: Element) {
          const id =
            this.getAttribute('data-mid') ??
            this.getAttribute('data-placeholder-mid');
          if (this === scroll) return { top: 0, bottom: 600 } as DOMRect;
          if (this === scroll.querySelector('.vpad')) {
            return { top: -st, bottom: -st } as DOMRect;
          }
          if (!id) return own.call(this);
          const top = cmp.rows().findIndex((r) => r.id === id) * EST - st;
          return { top, bottom: top + EST } as DOMRect;
        },
      );
      // From far down, so every row near the top entered during the fling: none is real.
      scrollTo(fixture, scroll, 5000, 0);
      for (let step = 1; step <= 7; step++) {
        scrollTo(fixture, scroll, 5000 - 700 * step, step * 100); // 7,000 px/s
      }
      // At 100, near the top: it asked for history mid-fling.
      expect(scroll.querySelectorAll('.msg').length).toBe(0);

      fixture.componentRef.setInput('messages', [
        ...many(30, '$older'),
        ...many(200),
      ]);
      fixture.detectChanges();
      await fixture.whenStable();

      // $1 was 36 px above the top; 30 rows of 64 px landed above it.
      expect(st).toBe(100 + 30 * EST);
    });

    describe('the height of a row not yet measured', () => {
      /** Measure $65–$84 at 100 px each, at rest at 5000, with a real-looking layout. */
      async function measureTwenty(flingPlaceholders: boolean) {
        const rendered = await renderList({ flingPlaceholders });
        scrollTo(rendered.fixture, rendered.scroll, 5000, 0);
        layOutRegion(rendered.scroll);
        const rows = range(65, 84).map(
          (id) =>
            rendered.container.querySelector(`[data-mid="${id}"]`) as Element,
        );
        rowObserver().emit(rows.map((row) => resizeEntry(row, 100)));
        rendered.fixture.detectChanges();
        return rendered;
      }

      it('follows the room’s average row once twenty rows are measured, keeping the reader in place', async () => {
        const { fixture, container, scroll } = await measureTwenty(true);

        // The reader was 8 px into $78. $65–$77 grew to 100 px, and the 65 rows above them,
        // still unmeasured, are now counted at the 100 px average too: $78 starts at 7800.
        expect(st).toBe(7808);

        // A row never measured stands in at that average during a fling.
        scrollTo(fixture, scroll, 7808, 1000);
        scrollTo(fixture, scroll, 7808 + 1280, 1100);
        const placeholder = container.querySelector(
          '[data-placeholder-mid="$90"]',
        ) as HTMLElement;
        expect(placeholder.style.height).toBe('100px');
      });

      it('keeps the reader in place near the bottom, where the browser would clamp an early correction', async () => {
        const rendered = await renderList({ flingPlaceholders: true });
        const { fixture, container, scroll } = rendered;
        const measuredAt100 = new Set(range(173, 192));
        // A browser-like scroller: its height is what is rendered (spacers, rows at their
        // real heights), and the position is clamped to it.
        const px = (el: Element | null) =>
          parseFloat((el as HTMLElement | null)?.style.height ?? '') || 0;
        const scrollHeight = () => {
          const [top, bottom] = Array.from(scroll.querySelectorAll('.vpad'));
          let rows = 0;
          for (const row of Array.from(
            scroll.querySelectorAll('.msg[data-mid]'),
          )) {
            rows += measuredAt100.has(row.getAttribute('data-mid') ?? '')
              ? 100
              : EST;
          }
          for (const ph of Array.from(
            scroll.querySelectorAll('[data-placeholder-mid]'),
          )) {
            rows += px(ph);
          }
          return px(top) + rows + px(bottom);
        };
        setScrollGeometry(scroll, {
          scrollTop: {
            get: () => st,
            set: (value: number) =>
              (st = Math.max(0, Math.min(value, scrollHeight() - 600))),
          },
          scrollHeight,
        });
        // 300 px above the bottom: rows $173–$199 in the window.
        scrollTo(fixture, scroll, 200 * EST - 600 - 300, 0);
        layOutRegion(scroll);

        rowObserver().emit(
          [...measuredAt100].map((id) =>
            resizeEntry(
              container.querySelector(`[data-mid="${id}"]`) as Element,
              100,
            ),
          ),
        );
        fixture.detectChanges();
        await fixture.whenStable();

        // $173–$184 grew above the reader (12 × 36 px), then the 173 unmeasured rows above
        // them came to count at the 100 px average (173 × 36 px): 11900 + 432 + 6228.
        expect(st).toBe(18_560);
      });

      it('leaves a reader who reached the bottom before the render where they are', async () => {
        const { fixture, container, scroll } = await renderList({
          flingPlaceholders: true,
        });
        scrollTo(fixture, scroll, 5000, 0);
        layOutRegion(scroll);
        rowObserver().emit(
          range(65, 84).map((id) =>
            resizeEntry(
              container.querySelector(`[data-mid="${id}"]`) as Element,
              100,
            ),
          ),
        );
        // Before the render applies the correction, the reader reaches the newest message.
        clock = 50;
        st = 200 * EST - 600;
        scroll.dispatchEvent(new Event('scroll'));
        fixture.detectChanges();
        await fixture.whenStable();

        expect(st).toBe(200 * EST - 600);
      });

      it('stays at the fixed estimate with the flag off', async () => {
        await measureTwenty(false);

        // Only $65–$77, above the reader, grew: 13 × 36 px.
        expect(st).toBe(5468);
      });
    });
  });
});
