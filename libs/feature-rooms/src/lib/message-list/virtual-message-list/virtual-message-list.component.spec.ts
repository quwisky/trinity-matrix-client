import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualMessageListComponent } from './virtual-message-list.component';

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

// Row height defaults to the 64px estimate here — the ResizeObserver stub in
// test-setup measures nothing, so every row is estimated. With ~800px overscan and
// jsdom's 0-height viewport, the window is a handful of rows regardless.
const EST = 64;

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
    TestBed.configureTestingModule({
      imports: [VirtualMessageListComponent],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

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

  it('renders rows and groups consecutive senders (shared base logic)', () => {
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
      msg('$2', '@a:hs', 'Alice', 2000), // same sender → continuation
      msg('$3', '@b:hs', 'Bob', 3000),
    ]);
    fixture.detectChanges();

    const el = fixture.nativeElement;
    expect(el.querySelectorAll('.msg').length).toBe(3);
    expect(el.querySelectorAll('.msg--cont').length).toBe(1);
  });

  it('renders the whole list (no spacers) for a short room', () => {
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('messages', many(10));
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    expect(cmp.windowedRows().length).toBe(10);
    expect(cmp.topPad()).toBe(0);
    expect(cmp.bottomPad()).toBe(0);
    expect(fixture.nativeElement.querySelectorAll('.msg').length).toBe(10);
  });

  it('renders only a window of a long room, pinned to the newest', () => {
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('messages', many(200));
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    expect(cmp.rows().length).toBe(200);
    expect(cmp.windowedRows().length).toBeGreaterThan(0);
    expect(cmp.windowedRows().length).toBeLessThan(200);
    // Opens pinned to the bottom: newest rows rendered (no bottom spacer), the top
    // spacer stands in for the older history.
    expect(cmp.bottomPad()).toBe(0);
    expect(cmp.topPad()).toBeGreaterThan(0);
    expect(cmp.windowedRows().at(-1)?.id).toBe('$199');
    expect(fixture.nativeElement.querySelectorAll('.msg').length).toBe(
      cmp.windowedRows().length,
    );
  });

  it('keeps topPad + visible + bottomPad equal to the full height when scrolled up', () => {
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('messages', many(200));
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    const scroll = fixture.nativeElement.querySelector(
      '.scroll',
    ) as HTMLElement;
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

  it('brings a windowed-out row into the DOM when jumped to', () => {
    Element.prototype.scrollIntoView = vi.fn();
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('messages', many(200));
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    const scroll = fixture.nativeElement.querySelector(
      '.scroll',
    ) as HTMLElement;
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

  it('does not re-jump when the timeline changes after a jump', () => {
    // jumpTo reads ids()/prefix(); the jump effect must run it untracked so a later
    // messages() change does not re-invoke jumpTo and yank the viewport back.
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;

    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
      msg('$2', '@b:hs', 'Bob', 2000),
    ]);
    fixture.detectChanges();

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

  it('resets the edit/reply target on room change (shared base reset)', () => {
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('roomId', '!a:hs');
    fixture.componentRef.setInput('messages', [
      msg('$1', '@a:hs', 'Alice', 1000),
    ]);
    fixture.detectChanges();
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

  it('handles an empty timeline', () => {
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('messages', []);
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    expect(cmp.windowedRows()).toEqual([]);
    expect(cmp.topPad()).toBe(0);
    expect(cmp.bottomPad()).toBe(0);
    expect(fixture.nativeElement.querySelector('.empty')).not.toBeNull();
  });

  it('jumps synchronously to an already-rendered row', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('messages', many(10)); // short → all rendered
    fixture.detectChanges();

    fixture.componentInstance.jumpTo('$5');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it('re-jumps to the same id when jumpToNonce is bumped', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('messages', many(10)); // short → all rendered
    fixture.componentRef.setInput('jumpToId', '$5');
    fixture.componentRef.setInput('jumpToNonce', 1);
    fixture.detectChanges();
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    // Repeat request to the same id (next nonce) must re-fire the jump effect.
    fixture.componentRef.setInput('jumpToNonce', 2);
    fixture.detectChanges();
    expect(scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it('flashes an already-rendered row on jump (in-window path)', () => {
    Element.prototype.scrollIntoView = vi.fn();
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('messages', many(10)); // short → all rendered
    fixture.detectChanges();

    fixture.componentInstance.jumpTo('$5');

    const row = fixture.nativeElement.querySelector('[data-mid="$5"]');
    expect(row.classList.contains('msg--flash')).toBe(true);
  });

  it('is a no-op when jumping to an unloaded event', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('messages', many(10));
    fixture.detectChanges();

    fixture.componentInstance.jumpTo('$nope');
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('re-pins to the newest message after a room switch', () => {
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('roomId', '!a:hs');
    fixture.componentRef.setInput('messages', many(200));
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    // Scroll up in room A → not pinned (bottom spacer appears).
    const scroll = fixture.nativeElement.querySelector(
      '.scroll',
    ) as HTMLElement;
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

  it('tracks at-bottom vs scrolled-up from the scroll position', () => {
    const fixture = TestBed.createComponent(VirtualMessageListComponent);
    fixture.componentRef.setInput('messages', many(200));
    fixture.detectChanges();
    const cmp = fixture.componentInstance;

    const scroll = fixture.nativeElement.querySelector(
      '.scroll',
    ) as HTMLElement;
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
    it('measures a row and re-sticks to the bottom while pinned', () => {
      const fixture = TestBed.createComponent(VirtualMessageListComponent);
      fixture.componentRef.setInput('messages', many(200));
      fixture.detectChanges();

      const scroll = fixture.nativeElement.querySelector(
        '.scroll',
      ) as HTMLElement;
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

    it('compensates scroll when an above-the-fold row grows (scrolled up)', () => {
      const fixture = TestBed.createComponent(VirtualMessageListComponent);
      fixture.componentRef.setInput('messages', many(200));
      fixture.detectChanges();
      const cmp = fixture.componentInstance;

      const scroll = fixture.nativeElement.querySelector(
        '.scroll',
      ) as HTMLElement;
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
      const fixture = TestBed.createComponent(VirtualMessageListComponent);
      fixture.componentRef.setInput('canLoadOlder', true);
      fixture.detectChanges();

      let emits = 0;
      fixture.componentInstance.loadOlder.subscribe(() => emits++);

      // jsdom has no layout → the viewport always reads "not full" → backfill engages.
      fixture.componentRef.setInput('messages', [
        msg('$b', '@a:hs', 'A', 2000),
        msg('$c', '@a:hs', 'A', 3000),
      ]);
      fixture.detectChanges();
      expect(emits).toBe(1);

      // Older $a prepended, $b dropped (same length) → oldest moved → keep going.
      fixture.componentRef.setInput('messages', [
        msg('$a', '@a:hs', 'A', 1000),
        msg('$c', '@a:hs', 'A', 3000),
      ]);
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

    it('restores scroll to the anchor row after older history prepends', () => {
      const fixture = TestBed.createComponent(VirtualMessageListComponent);
      fixture.componentRef.setInput('canLoadOlder', true);
      fixture.componentRef.setInput('messages', many(30)); // short → all rendered
      fixture.detectChanges();
      const cmp = fixture.componentInstance;

      const scroll = fixture.nativeElement.querySelector(
        '.scroll',
      ) as HTMLElement;
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
      (
        scroll.querySelector('[data-mid="$5"]') as HTMLElement
      ).getBoundingClientRect = () => rect(40, 40 + EST); // first reaching into view

      cmp.onScroll(); // captures anchor $5 (offset 40), sets pendingPrepend, emits

      // Prepend 5 older rows → $5 shifts from index 5 to index 10.
      fixture.componentRef.setInput('messages', [
        ...['$p0', '$p1', '$p2', '$p3', '$p4'].map((id, i) =>
          msg(id, '@a:hs', 'A', 1 + i),
        ),
        ...many(30),
      ]);
      fixture.detectChanges(); // prepend branch → rAF (sync) → offset-anchor restore

      // scrollTop = regionTop(0) + offsetOf($5 @ idx 10)=640 - anchorOffset(40) = 600.
      expect(st).toBe(600);
    });
  });
});
