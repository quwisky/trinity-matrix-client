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
    // the scrollTop signal set via onScroll, not the real rAF.
    vi.stubGlobal('requestAnimationFrame', () => 0);
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
    expect(scroll.querySelector(`[data-mid="${target}"]`)).not.toBeNull();
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
});
