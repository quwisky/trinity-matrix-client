import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { render } from '@trinity/testing';
import { MockComponent } from 'ng-mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type MessageView } from '@trinity/util/matrix';
import { MessageComposerComponent } from '../../message-composer/message-composer.component';
import { DayBoundaryService } from '../day-boundary.service';
import { VirtualMessageListComponent } from './virtual-message-list.component';

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

// Row height defaults to the 64px estimate here — the ResizeObserver stub in
// test-setup measures nothing, so every row is estimated. With ~800px overscan and
// jsdom's 0-height viewport, the window is a handful of rows regardless.
const EST = 64;

/** `notAtBottom` drives the jump pill and is protected (template-only); read it
 * through a narrow view rather than widening the component's API for a test. */
const notAtBottom = (cmp: VirtualMessageListComponent): boolean =>
  (cmp as unknown as { notAtBottom: () => boolean }).notAtBottom();

describe('VirtualMessageListComponent', () => {
  beforeEach(() => {
    // Suppress the anchoring effect's async scroll writes (they'd assign
    // el.scrollTop, fighting the geometry these tests define); windowing is driven by
    // the scrollTop signal set via onScroll, not the real rAF. The rAF-deferred paths
    // get their own describe below that runs rAF synchronously.
    vi.stubGlobal('requestAnimationFrame', () => 0);
    // Fresh ResizeObserver registry per test (the controllable stub is cumulative).
    (ResizeObserver as unknown as { instances: unknown[] }).instances.length =
      0;
  });

  afterEach(() => vi.unstubAllGlobals());

  // Render the windowed list with the heavy composer child mocked away; the
  // MessageRowComponent stays real because the tests assert its rendered DOM
  // (`.msg`, `data-mid`, the flash class).
  function renderList(
    inputs: Partial<{
      messages: MessageView[];
      roomId: string;
      jumpToId: string;
      jumpToNonce: number;
      canLoadOlder: boolean;
    }> = {},
  ) {
    return render(VirtualMessageListComponent, {
      inputs,
      imports: [MockComponent(MessageComposerComponent)],
    });
  }

  function many(n: number) {
    return Array.from({ length: n }, (_, i) =>
      msg(`$${i}`, '@a:hs', 'A', 1000 + i * 10_000),
    );
  }

  // Reach the controllable ResizeObserver from test-setup so tests can fire resizes.
  interface TestRO {
    observed: Set<Element>;
    emit(entries: ResizeObserverEntry[]): void;
  }
  function rowObserver(): TestRO {
    const ro = (
      ResizeObserver as unknown as { instances: TestRO[] }
    ).instances.find((o) => [...o.observed].some((el) => el.matches?.('.msg')));
    if (!ro) {
      throw new Error('row ResizeObserver not found');
    }
    return ro;
  }
  function resizeEntry(target: Element, height: number): ResizeObserverEntry {
    return {
      target,
      borderBoxSize: [{ blockSize: height, inlineSize: 0 }],
      contentRect: { height } as DOMRectReadOnly,
    } as unknown as ResizeObserverEntry;
  }
  const rect = (top: number, bottom = top): DOMRect =>
    ({ top, bottom }) as unknown as DOMRect;

  describe('day separators', () => {
    const TODAY = new Date(2026, 6, 24).getTime();
    const PER_DAY = 40;

    /** 120 rows over three local days — past SMALL_LIST_ROWS, so windowing really engages. */
    function acrossThreeDays(): MessageView[] {
      return [-2, -1, 0].flatMap((dayOffset, day) =>
        Array.from({ length: PER_DAY }, (_, i) =>
          msg(
            `$${day}-${i}`,
            '@a:hs',
            'A',
            new Date(2026, 6, 24 + dayOffset, 9, i).getTime(),
          ),
        ),
      );
    }

    function renderDays() {
      return render(VirtualMessageListComponent, {
        inputs: { messages: acrossThreeDays() },
        imports: [MockComponent(MessageComposerComponent)],
        providers: [
          {
            provide: DayBoundaryService,
            useValue: { todayStart: signal(TODAY) },
          },
        ],
      });
    }

    /** Scroll geometry that lands the window's top edge mid-day, not on a day boundary. */
    function scrollTo(container: Element, scrollTop: number): HTMLElement {
      const scroll = container.querySelector('.scroll') as HTMLElement;
      let st = scrollTop;
      Object.defineProperty(scroll, 'scrollTop', {
        get: () => st,
        set: (v: number) => (st = v),
        configurable: true,
      });
      Object.defineProperty(scroll, 'clientHeight', {
        value: 600,
        configurable: true,
      });
      Object.defineProperty(scroll, 'scrollHeight', {
        value: 3 * PER_DAY * EST,
        configurable: true,
      });
      return scroll;
    }

    // The reason the derivation lives on the full list rather than the template: the answer
    // must not depend on which slice happens to be rendered.
    it('marks the same rows whatever the scroll position', async () => {
      const { fixture, container } = await renderDays();
      const cmp = fixture.componentInstance;
      const marked = () =>
        cmp
          .rows()
          .filter((r) => r.daySeparator)
          .map((r) => `${r.id}:${r.daySeparator}`);

      expect(marked()).toEqual(['$1-0:Yesterday', '$2-0:Today']);

      scrollTo(container, 4320);
      cmp.onScroll();
      fixture.detectChanges();
      expect(marked()).toEqual(['$1-0:Yesterday', '$2-0:Today']);

      scrollTo(container, 0);
      cmp.onScroll();
      fixture.detectChanges();
      expect(marked()).toEqual(['$1-0:Yesterday', '$2-0:Today']);
    });

    // Deriving from "the previous rendered row" would put a separator on the first row of
    // every window — a date appearing out of nowhere mid-conversation each time you scroll.
    it('renders no separator at the top edge of a window that opens mid-day', async () => {
      const { fixture, container } = await renderDays();
      const cmp = fixture.componentInstance;

      scrollTo(container, 4320);
      cmp.onScroll();
      fixture.detectChanges();

      const window = cmp.windowedRows();
      // Guard against a vacuous pass: the window has to be a real slice that opens partway
      // into one day and runs past a boundary into the next.
      expect(window.length).toBeLessThan(cmp.rows().length);
      expect(window[0].id).not.toBe('$0-0');
      expect(window.filter((r) => r.daySeparator).length).toBeGreaterThan(0);

      expect(window[0].daySeparator).toBeNull();
      expect(
        container.querySelectorAll('[data-testid=day-separator]').length,
      ).toBe(window.filter((r) => r.daySeparator).length);
    });

    // Documents an accepted limitation rather than asserting a goal: separators sit outside
    // the prefix-sum height model (as the unread divider already does), so the window maths
    // must stay internally consistent even though the rendered content is slightly taller.
    it('leaves the window height model undisturbed', async () => {
      const { fixture, container } = await renderDays();
      const cmp = fixture.componentInstance;

      scrollTo(container, 4320);
      cmp.onScroll();
      fixture.detectChanges();

      const visible = cmp.windowedRows().length * EST;
      expect(cmp.topPad() + visible + cmp.bottomPad()).toBe(3 * PER_DAY * EST);
    });
  });

  it('renders rows and groups consecutive senders (shared base logic)', async () => {
    const { container } = await renderList({
      messages: [
        msg('$1', '@a:hs', 'Alice', 1000),
        msg('$2', '@a:hs', 'Alice', 2000), // same sender → continuation
        msg('$3', '@b:hs', 'Bob', 3000),
      ],
    });

    expect(container.querySelectorAll('.msg').length).toBe(3);
    expect(container.querySelectorAll('.msg--cont').length).toBe(1);
  });

  it('renders the whole list (no spacers) for a short room', async () => {
    const { fixture, container } = await renderList({ messages: many(10) });
    const cmp = fixture.componentInstance;

    expect(cmp.windowedRows().length).toBe(10);
    expect(cmp.topPad()).toBe(0);
    expect(cmp.bottomPad()).toBe(0);
    expect(container.querySelectorAll('.msg').length).toBe(10);
  });

  it('renders only a window of a long room, pinned to the newest', async () => {
    const { fixture, container } = await renderList({ messages: many(200) });
    const cmp = fixture.componentInstance;

    expect(cmp.rows().length).toBe(200);
    expect(cmp.windowedRows().length).toBeGreaterThan(0);
    expect(cmp.windowedRows().length).toBeLessThan(200);
    // Opens pinned to the bottom: newest rows rendered (no bottom spacer), the top
    // spacer stands in for the older history.
    expect(cmp.bottomPad()).toBe(0);
    expect(cmp.topPad()).toBeGreaterThan(0);
    expect(cmp.windowedRows().at(-1)?.id).toBe('$199');
    expect(container.querySelectorAll('.msg').length).toBe(
      cmp.windowedRows().length,
    );
  });

  it('keeps topPad + visible + bottomPad equal to the full height when scrolled up', async () => {
    const { fixture, container } = await renderList({ messages: many(200) });
    const cmp = fixture.componentInstance;

    const scroll = container.querySelector('.scroll') as HTMLElement;
    let st = 5000;
    Object.defineProperty(scroll, 'scrollTop', {
      get: () => st,
      set: (v: number) => (st = v),
      configurable: true,
    });
    Object.defineProperty(scroll, 'clientHeight', {
      value: 600,
      configurable: true,
    });
    Object.defineProperty(scroll, 'scrollHeight', {
      value: 200 * EST,
      configurable: true,
    });
    cmp.onScroll();
    fixture.detectChanges();

    expect(cmp.topPad()).toBeGreaterThan(0);
    expect(cmp.bottomPad()).toBeGreaterThan(0);
    const visible = cmp.windowedRows().length * EST;
    expect(cmp.topPad() + visible + cmp.bottomPad()).toBe(200 * EST);
  });

  it('shows the jump-to-latest pill when scrolled up and returns to the bottom', async () => {
    const { fixture, container } = await renderList({ messages: many(200) });
    const cmp = fixture.componentInstance;

    const scroll = container.querySelector('.scroll') as HTMLElement;
    let st = 5000;
    Object.defineProperty(scroll, 'scrollTop', {
      get: () => st,
      set: (v: number) => (st = v),
      configurable: true,
    });
    Object.defineProperty(scroll, 'clientHeight', {
      value: 600,
      configurable: true,
    });
    Object.defineProperty(scroll, 'scrollHeight', {
      value: 200 * EST,
      configurable: true,
    });

    // Scrolled far from the bottom: the list offers the jump pill.
    cmp.onScroll();
    fixture.detectChanges();
    expect(notAtBottom(cmp)).toBe(true);
    const pill = container.querySelector<HTMLButtonElement>(
      '[data-testid=jump-to-latest]',
    );
    expect(pill).not.toBeNull();

    // Jumping re-pins to the bottom and hides the pill.
    pill!.click();
    fixture.detectChanges();
    expect(notAtBottom(cmp)).toBe(false);
    expect(container.querySelector('[data-testid=jump-to-latest]')).toBeNull();
  });

  it('scrollToLatest re-pins the physical scroll to the newest message', async () => {
    const { fixture, container } = await renderList({ messages: many(200) });
    const cmp = fixture.componentInstance;
    const scroll = container.querySelector('.scroll') as HTMLElement;

    let st = 5000;
    Object.defineProperty(scroll, 'scrollTop', {
      get: () => st,
      set: (v: number) => (st = v),
      configurable: true,
    });
    Object.defineProperty(scroll, 'scrollHeight', {
      value: 200 * EST,
      configurable: true,
    });
    Object.defineProperty(scroll, 'clientHeight', {
      value: 600,
      configurable: true,
    });

    // scrollToLatest defers its scroll write to rAF (a no-op stub in beforeEach); run
    // it synchronously so the write executes, and assert it landed on the bottom.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    cmp.scrollToLatest();

    expect(scroll.scrollTop).toBe(200 * EST);
  });

  it('brings a windowed-out row into the DOM when jumped to', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { fixture, container } = await renderList({ messages: many(200) });
    const cmp = fixture.componentInstance;

    const scroll = container.querySelector('.scroll') as HTMLElement;
    let st = 0;
    Object.defineProperty(scroll, 'scrollTop', {
      get: () => st,
      set: (v: number) => (st = v),
      configurable: true,
    });

    const target = '$150';
    expect(scroll.querySelector(`[data-mid="${target}"]`)).toBeNull(); // windowed out

    cmp.jumpTo(target);
    fixture.detectChanges();

    expect(cmp.windowedRows().some((r) => r.id === target)).toBe(true);
    const row = scroll.querySelector(`[data-mid="${target}"]`);
    expect(row).not.toBeNull();
    // Flashed by the deferred afterNextRender path, once the row is on-screen.
    expect(row?.classList.contains('msg--flash')).toBe(true);
  });

  it('does not re-jump when the timeline changes after a jump', async () => {
    // jumpTo reads ids()/prefix(); the jump effect must run it untracked so a later
    // messages() change does not re-invoke jumpTo and yank the viewport back.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const { fixture } = await renderList({
      messages: [
        msg('$1', '@a:hs', 'Alice', 1000),
        msg('$2', '@b:hs', 'Bob', 2000),
      ],
    });

    fixture.componentRef.setInput('jumpToId', '$2');
    fixture.detectChanges();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
      msg('$2', '@b:hs', 'Bob', 2000),
      msg('$3', '@a:hs', 'Alice', 3000),
    ]);
    fixture.detectChanges();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('resets the edit/reply target on room change (shared base reset)', async () => {
    const { fixture } = await renderList({
      roomId: '!a:hs',
      messages: [msg('$1', '@a:hs', 'Alice', 1000)],
    });
    const cmp = fixture.componentInstance;

    cmp.replyingToId.set('$1');
    expect(cmp.replyingToId()).toBe('$1');

    fixture.componentRef.setInput('roomId', '!b:hs');
    fixture.componentRef.setInput('messages', [
      msg('$9', '@b:hs', 'Bob', 5000),
    ]);
    fixture.detectChanges();

    expect(cmp.replyingToId()).toBeNull();
    expect(cmp.announcement()).toBe('');
  });

  it('handles an empty timeline', async () => {
    const { fixture, container } = await renderList({ messages: [] });
    const cmp = fixture.componentInstance;

    expect(cmp.windowedRows()).toEqual([]);
    expect(cmp.topPad()).toBe(0);
    expect(cmp.bottomPad()).toBe(0);
    expect(container.textContent).toContain('No messages yet.');
  });

  it('jumps synchronously to an already-rendered row', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { fixture } = await renderList({ messages: many(10) }); // short → all rendered

    fixture.componentInstance.jumpTo('$5');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('re-jumps to the same id when jumpToNonce is bumped', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { fixture } = await renderList({
      messages: many(10), // short → all rendered
      jumpToId: '$5',
      jumpToNonce: 1,
    });
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // Repeat request to the same id (next nonce) must re-fire the jump effect.
    fixture.componentRef.setInput('jumpToNonce', 2);
    fixture.detectChanges();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('flashes an already-rendered row on jump (in-window path)', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const { fixture, container } = await renderList({ messages: many(10) }); // short → all rendered

    fixture.componentInstance.jumpTo('$5');

    const row = container.querySelector('[data-mid="$5"]');
    expect(row?.classList.contains('msg--flash')).toBe(true);
  });

  it('is a no-op when jumping to an unloaded event', async () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const { fixture } = await renderList({ messages: many(10) });

    fixture.componentInstance.jumpTo('$nope');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('re-pins to the newest message after a room switch', async () => {
    const { fixture, container } = await renderList({
      roomId: '!a:hs',
      messages: many(200),
    });
    const cmp = fixture.componentInstance;

    // Scroll up in room A → not pinned (bottom spacer appears).
    const scroll = container.querySelector('.scroll') as HTMLElement;
    let st = 2000;
    Object.defineProperty(scroll, 'scrollTop', {
      get: () => st,
      set: (v: number) => (st = v),
      configurable: true,
    });
    Object.defineProperty(scroll, 'clientHeight', {
      value: 600,
      configurable: true,
    });
    Object.defineProperty(scroll, 'scrollHeight', {
      value: 200 * EST,
      configurable: true,
    });
    cmp.onScroll();
    fixture.detectChanges();
    expect(cmp.bottomPad()).toBeGreaterThan(0);

    // Switch rooms → the reset re-pins to the bottom.
    fixture.componentRef.setInput('roomId', '!b:hs');
    fixture.componentRef.setInput('messages', many(200));
    fixture.detectChanges();
    expect(cmp.bottomPad()).toBe(0);
    expect(cmp.windowedRows().at(-1)?.id).toBe('$199');
  });

  it('tracks at-bottom vs scrolled-up from the scroll position', async () => {
    const { fixture, container } = await renderList({ messages: many(200) });
    const cmp = fixture.componentInstance;

    const scroll = container.querySelector('.scroll') as HTMLElement;
    let st = 0;
    Object.defineProperty(scroll, 'scrollTop', {
      get: () => st,
      set: (v: number) => (st = v),
      configurable: true,
    });
    Object.defineProperty(scroll, 'clientHeight', {
      value: 600,
      configurable: true,
    });
    Object.defineProperty(scroll, 'scrollHeight', {
      value: 200 * EST,
      configurable: true,
    });

    // Scrolled up → not pinned → a bottom spacer stands in for the rest.
    st = 1000;
    cmp.onScroll();
    fixture.detectChanges();
    expect(cmp.bottomPad()).toBeGreaterThan(0);

    // Near the bottom → pinned → no bottom spacer.
    st = 200 * EST - 600;
    cmp.onScroll();
    fixture.detectChanges();
    expect(cmp.bottomPad()).toBe(0);
  });

  // Fire the (controllable) ResizeObserver so onRowsResized actually runs.
  describe('height measurement (ResizeObserver fires)', () => {
    it('measures a row and re-sticks to the bottom while pinned', async () => {
      const { container } = await renderList({ messages: many(200) });

      const scroll = container.querySelector('.scroll') as HTMLElement;
      let st = 0;
      Object.defineProperty(scroll, 'scrollTop', {
        get: () => st,
        set: (v: number) => (st = v),
        configurable: true,
      });
      Object.defineProperty(scroll, 'scrollHeight', {
        value: 12_800,
        configurable: true,
      });
      const row = scroll.querySelector('[data-mid]') as Element;

      // Pinned by default → a measurement re-sticks to the bottom (scrollHeight).
      rowObserver().emit([resizeEntry(row, 120)]);
      expect(st).toBe(12_800);
    });

    it('compensates scroll when an above-the-fold row grows (scrolled up)', async () => {
      const { fixture, container } = await renderList({ messages: many(200) });
      const cmp = fixture.componentInstance;

      const scroll = container.querySelector('.scroll') as HTMLElement;
      let st = 5000;
      Object.defineProperty(scroll, 'scrollTop', {
        get: () => st,
        set: (v: number) => (st = v),
        configurable: true,
      });
      Object.defineProperty(scroll, 'clientHeight', {
        value: 600,
        configurable: true,
      });
      Object.defineProperty(scroll, 'scrollHeight', {
        value: 200 * EST,
        configurable: true,
      });
      // Make rowsRegionTop resolve to 0 (jsdom has no layout): container top 0 and the
      // first .vpad tracks -scrollTop, so (-st) - 0 + st === 0.
      scroll.getBoundingClientRect = () => rect(0);
      cmp.onScroll(); // not pinned; window shifts to the middle
      fixture.detectChanges();
      (scroll.querySelector('.vpad') as HTMLElement).getBoundingClientRect =
        () => rect(-st);

      const row = scroll.querySelector('[data-mid]') as Element; // first rendered
      const idx = Number((row.getAttribute('data-mid') ?? '$0').slice(1));
      expect((idx + 1) * EST).toBeLessThanOrEqual(5000); // sanity: above the fold

      rowObserver().emit([resizeEntry(row, EST + 100)]); // grow by 100
      expect(st).toBe(5100); // read position held
    });
  });

  // Anchoring / backfill / prepend-restore are deferred into requestAnimationFrame;
  // run it synchronously (like the plain component's backfill test) to exercise them.
  describe('anchoring (rAF synchronous)', () => {
    beforeEach(() =>
      vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
        cb(0);
        return 0;
      }),
    );

    it('backfills a short room until it fills, then stops (id-based guard)', () => {
      // A detached TestBed fixture (not ATL render()) is deliberate: render()
      // attaches the component to ApplicationRef, so the signal write from the
      // synchronous-rAF backfill re-enters the zoneless scheduler ("cannot
      // synchronously execute watches while scheduling"). A detached fixture only
      // ticks on our explicit fixture.detectChanges().
      const fixture = TestBed.createComponent(VirtualMessageListComponent);
      fixture.componentRef.setInput('canLoadOlder', true);
      fixture.detectChanges();

      let emits = 0;
      fixture.componentInstance.loadOlder.subscribe(() => emits++);

      // jsdom has no layout → the viewport always reads "not full" → backfill engages.
      // The guard tracks the oldest RAW event (bound from TimelineService), not the oldest
      // rendered row, so a page of events the projection drops still counts as progress.
      fixture.componentRef.setInput('messages', [
        msg('$b', '@a:hs', 'A', 2000),
        msg('$c', '@a:hs', 'A', 3000),
      ]);
      fixture.componentRef.setInput('oldestEventId', '$b');
      fixture.detectChanges();
      expect(emits).toBe(1);

      // Older $a prepended, $b dropped (same length) → oldest moved → keep going.
      fixture.componentRef.setInput('messages', [
        msg('$a', '@a:hs', 'A', 1000),
        msg('$c', '@a:hs', 'A', 3000),
      ]);
      fixture.componentRef.setInput('oldestEventId', '$a');
      fixture.detectChanges();
      expect(emits).toBe(2);

      // A live message but no prepend (oldest unchanged) → backfill stops.
      fixture.componentRef.setInput('messages', [
        msg('$a', '@a:hs', 'A', 1000),
        msg('$c', '@a:hs', 'A', 3000),
        msg('$d', '@a:hs', 'A', 4000),
      ]);
      fixture.detectChanges();
      expect(emits).toBe(2);
    });

    it('restores from the rendered anchor instead of fresh row-height estimates', () => {
      // Detached fixture (not renderList/render()), like the backfill test above:
      // render() attaches the component to ApplicationRef, so the synchronous-rAF
      // anchor restore re-enters the zoneless scheduler ("cannot synchronously
      // execute watches while scheduling"). A detached fixture only ticks on our
      // explicit fixture.detectChanges().
      TestBed.overrideComponent(VirtualMessageListComponent, {
        remove: { imports: [MessageComposerComponent] },
        add: { imports: [MockComponent(MessageComposerComponent)] },
      });
      const fixture = TestBed.createComponent(VirtualMessageListComponent);
      fixture.componentRef.setInput('canLoadOlder', true);
      fixture.componentRef.setInput('messages', many(30)); // short → all rendered
      fixture.detectChanges();
      const container = fixture.nativeElement as HTMLElement;
      const cmp = fixture.componentInstance;

      const scroll = container.querySelector('.scroll') as HTMLElement;
      let st = 100; // < AUTO_LOAD_THRESHOLD_PX (150) → triggers load-older
      Object.defineProperty(scroll, 'scrollTop', {
        get: () => st,
        set: (v: number) => (st = v),
        configurable: true,
      });
      Object.defineProperty(scroll, 'clientHeight', {
        value: 600,
        configurable: true,
      });
      Object.defineProperty(scroll, 'scrollHeight', {
        value: 30 * EST,
        configurable: true,
      });
      // getBoundingClientRect drives anchor capture + region offset. Container top 0;
      // first .vpad tracks -scrollTop so rowsRegionTop resolves to 0.
      scroll.getBoundingClientRect = () => rect(0);
      (scroll.querySelector('.vpad') as HTMLElement).getBoundingClientRect =
        () => rect(-st);
      for (const id of ['$0', '$1', '$2', '$3', '$4']) {
        (
          scroll.querySelector(`[data-mid="${id}"]`) as HTMLElement
        ).getBoundingClientRect = () => rect(-100, -50); // above the viewport top
      }
      let prependedHeight = 0;
      (
        scroll.querySelector('[data-mid="$5"]') as HTMLElement
      ).getBoundingClientRect = () =>
        rect(40 + prependedHeight, 40 + prependedHeight + EST); // first reaching into view

      cmp.onScroll(); // captures anchor $5 (offset 40), sets pendingPrepend, emits

      // Prepend five short rows. Their real 22px DOM heights are available immediately,
      // while the prefix still treats each unmeasured row as EST (64px). Restoring from
      // that prefix would jump to 600; the rendered anchor moved by only 110px.
      prependedHeight = 5 * 22;
      fixture.componentRef.setInput('messages', [
        ...['$p0', '$p1', '$p2', '$p3', '$p4'].map((id, i) =>
          msg(id, '@a:hs', 'A', 1 + i),
        ),
        ...many(30),
      ]);
      fixture.detectChanges(); // prepend branch → rAF (sync) → offset-anchor restore

      // Preserve the 40px viewport offset: previous 100 + real prepend height 110.
      expect(st).toBe(210);
    });
  });

  it('is a drop target too — this is the list that ships', async () => {
    // `DEFAULT_VIRTUAL_TIMELINE` is true, so this is the list users get. The drop wiring was
    // covered only on the simple list, which means removing `hostDirectives` HERE would have
    // shipped green. The composer is mocked, so `stageFiles` is the seam: proving it is
    // called proves the directive, the subscription in the base and the viewChild together.
    const { fixture, container } = await renderList({
      messages: [msg('$1', '@a:hs', 'Alice', 1000)],
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
    const composer = fixture.debugElement.query(
      By.directive(MessageComposerComponent),
    ).componentInstance as MessageComposerComponent;
    const staged: readonly File[][] = [];
    composer.stageFiles = (files: readonly File[]) => {
      (staged as File[][]).push([...files]);
    };

    expect(container.querySelector('[data-testid=drop-overlay]')).toBeNull();
    fire('dragenter');
    expect(
      container.querySelector('[data-testid=drop-overlay]'),
    ).not.toBeNull();

    const dropped = new File(['x'], 'dropped.png', { type: 'image/png' });
    fire('drop', [dropped]);

    expect(staged).toEqual([[dropped]]);
    expect(container.querySelector('[data-testid=drop-overlay]')).toBeNull();
  });

  it('sends a batch caption plainly, and is actually wired to do so', async () => {
    // Emitted from the COMPOSER so the template binding is what carries it. Calling
    // `onBatchCaption()` directly passes even with the binding deleted — which is exactly how
    // the thread shipped without one, since an unbound output is legal and the AOT build is
    // silent about it.
    const { fixture } = await renderList({
      messages: [msg('$1', '@a:hs', 'Alice', 1000)],
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
  // What this list owes is the wiring — the detail lives in the indicator's own spec.
  // Before the extraction the markup was copy-pasted here and asserted only in the simple
  // list, so the windowed copy could drift silently.
  it('feeds the typing names to the indicator', async () => {
    const { fixture, container } = await render(VirtualMessageListComponent, {
      inputs: { typingNames: ['Alice', 'Bob'] },
      imports: [MockComponent(MessageComposerComponent)],
    });
    const text = (el: Element | null | undefined): string =>
      (el?.textContent ?? '').replace(/\s+/g, ' ').trim();

    expect(text(container.querySelector('.typing-indicator'))).toBe(
      'Alice and Bob are typing',
    );

    fixture.componentRef.setInput('typingNames', []);
    fixture.detectChanges();
    expect(container.querySelector('.typing-indicator')).toBeNull();
    expect(container.querySelector('.typing-slot')).not.toBeNull();
  });
});
