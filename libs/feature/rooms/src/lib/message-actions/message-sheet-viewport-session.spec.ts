import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageSheetViewportSession } from './message-sheet-viewport-session';

const rect = (top: number, height: number): DOMRect =>
  ({
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 300,
    width: 300,
    x: 0,
    y: top,
    toJSON: () => ({}),
  }) as DOMRect;

describe('MessageSheetViewportSession', () => {
  let frames: Map<number, FrameRequestCallback>;
  let nextFrame: number;

  beforeEach(() => {
    frames = new Map();
    nextFrame = 1;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.unstubAllGlobals();
  });

  const flushFrame = () => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) {
      callback(0);
    }
  };

  function build(options: {
    rowTop: number;
    rowHeight: number;
    pressY: number;
    sheetTop: number;
    sheetHeight: number;
  }) {
    const scroller = document.createElement('div');
    scroller.setAttribute('data-message-scroller', '');
    const anchor = document.createElement('div');
    const surface = document.createElement('div');
    scroller.append(anchor);
    document.body.append(scroller, surface);

    let scrollTop = 100;
    Object.defineProperty(scroller, 'scrollTop', {
      get: () => scrollTop,
      set: (value: number) => (scrollTop = value),
      configurable: true,
    });
    scroller.getBoundingClientRect = () => rect(0, 600);
    const documentTop = options.rowTop + scrollTop;
    anchor.getBoundingClientRect = () =>
      rect(documentTop - scrollTop, options.rowHeight);
    surface.getBoundingClientRect = () => {
      const inlineMax = Number.parseFloat(surface.style.maxHeight);
      const height = Number.isFinite(inlineMax)
        ? Math.min(options.sheetHeight, inlineMax)
        : options.sheetHeight;
      return rect(options.sheetTop + options.sheetHeight - height, height);
    };

    const session = new MessageSheetViewportSession(
      { anchor, clientY: options.pressY },
      () => surface,
    );
    return { anchor, scroller, session, surface, scrollTop: () => scrollTop };
  }

  it('adds measured tail range, clears the whole row, and restores on release', () => {
    const { anchor, scroller, session, scrollTop } = build({
      rowTop: 500,
      rowHeight: 50,
      pressY: 525,
      sheetTop: 100,
      sheetHeight: 500,
    });

    session.start();
    flushFrame();
    flushFrame();

    const sheetTop = 100;
    expect(anchor.getBoundingClientRect().bottom + 8).toBeLessThanOrEqual(
      sheetTop,
    );
    expect(anchor.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(
      scroller.querySelector<HTMLElement>('[data-message-sheet-clearance]')
        ?.style.height,
    ).toBe('508px');

    session.release();

    expect(scrollTop()).toBe(100);
    expect(scroller.querySelector('[data-message-sheet-clearance]')).toBeNull();
  });

  /** Put the sheet mid-entrance; the returned function moves it, and 0 lands it. */
  function slideIn(surface: HTMLElement, slide: number) {
    vi.stubGlobal(
      'DOMMatrixReadOnly',
      class {
        readonly m42: number;
        constructor(value: string) {
          this.m42 = Number(value.split(',')[5]?.replace(')', ''));
        }
      },
    );
    let current = 0;
    const slideTo = (next: number) => {
      current = next;
      surface.style.transform = next
        ? `matrix(1, 0, 0, 1, 0, ${next})`
        : 'none';
    };
    const atRest = surface.getBoundingClientRect.bind(surface);
    surface.getBoundingClientRect = () => {
      const box = atRest();
      return rect(box.top + current, box.height);
    };
    slideTo(slide);
    return slideTo;
  }

  it('lets the sliding edge push the row up, sized for where the sheet will rest', () => {
    const { anchor, scroller, session, surface, scrollTop } = build({
      rowTop: 500,
      rowHeight: 50,
      pressY: 525,
      sheetTop: 100,
      sheetHeight: 500,
    });
    const slideTo = slideIn(surface, 500);

    session.start();
    flushFrame();
    flushFrame();

    // The edge is still below the row, so the timeline has not moved, and it has its range.
    expect(scrollTop()).toBe(100);
    expect(surface.style.maxHeight).toBe('');
    expect(
      scroller.querySelector<HTMLElement>('[data-message-sheet-clearance]')
        ?.style.height,
    ).toBe('508px');

    slideTo(200);
    flushFrame();
    expect(anchor.getBoundingClientRect().bottom).toBe(292);

    slideTo(0);
    flushFrame();
    expect(anchor.getBoundingClientRect().bottom).toBe(92);
    flushFrame();
    expect(frames.size).toBe(0);
  });

  it('takes the timeline from a finger still down for as long as the sheet is open', () => {
    const { scroller, session } = build({
      rowTop: 500,
      rowHeight: 50,
      pressY: 525,
      sheetTop: 100,
      sheetHeight: 500,
    });
    scroller.style.overflowY = 'scroll';

    session.start();
    expect(scroller.style.overflowY).toBe('hidden');

    session.release();
    expect(scroller.style.overflowY).toBe('scroll');
  });

  it('re-measures once after the write that lands the row, and only once', () => {
    const { anchor, session } = build({
      rowTop: 500,
      rowHeight: 50,
      pressY: 525,
      sheetTop: 100,
      sheetHeight: 500,
    });
    // The write that lands the row can flip the list's window, moving the row again.
    let drift = 0;
    const placed = anchor.getBoundingClientRect.bind(anchor);
    anchor.getBoundingClientRect = () => {
      const box = placed();
      return rect(box.top + drift, box.height);
    };

    session.start();
    flushFrame();
    flushFrame();
    expect(anchor.getBoundingClientRect().bottom).toBe(92);

    drift = 30;
    flushFrame();
    expect(anchor.getBoundingClientRect().bottom).toBe(92);
    expect(frames.size).toBe(0);
  });

  it('leaves a row the composer clips alone until the sliding edge reaches it', () => {
    const { session, surface, scrollTop } = build({
      rowTop: 580,
      rowHeight: 50,
      pressY: 590,
      sheetTop: 100,
      sheetHeight: 500,
    });
    const slideTo = slideIn(surface, 600);

    session.start();
    flushFrame();
    flushFrame();
    expect(scrollTop()).toBe(100);

    slideTo(530);
    flushFrame();
    expect(scrollTop()).toBe(108);
  });

  it('never moves a row taller than the resting band down during a slide', () => {
    const { anchor, session, surface, scrollTop } = build({
      rowTop: -20,
      rowHeight: 540,
      pressY: 300,
      sheetTop: 100,
      sheetHeight: 500,
    });
    const slideTo = slideIn(surface, 600);

    session.start();
    flushFrame();
    flushFrame();
    for (const slide of [300, 100, 0]) {
      slideTo(slide);
      flushFrame();
      expect(scrollTop()).toBe(100);
    }
    flushFrame();

    expect(surface.style.maxHeight).toBe('88px');
    expect(anchor.getBoundingClientRect().top).toBe(-20);
    expect(scrollTop()).toBe(100);
  });

  it('pushes a tall row only until its pressed point clears the resting edge', () => {
    const { session, surface, scrollTop } = build({
      rowTop: 0,
      rowHeight: 540,
      pressY: 520,
      sheetTop: 100,
      sheetHeight: 500,
    });
    const slideTo = slideIn(surface, 600);

    session.start();
    flushFrame();
    flushFrame();
    const seen = [scrollTop()];
    for (const slide of [88, 60, 30, 0]) {
      slideTo(slide);
      flushFrame();
      seen.push(scrollTop());
    }
    flushFrame();

    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(scrollTop()).toBe(116);
  });

  it('keeps a row whole when a sliding sheet shrunk to fit it reads a fraction short', () => {
    const { anchor, session, surface } = build({
      rowTop: 400,
      rowHeight: 150,
      pressY: 475,
      sheetTop: 100,
      sheetHeight: 500,
    });
    const slideTo = slideIn(surface, 400);
    // The computed transform and the box disagree by a fraction while the sheet slides.
    vi.stubGlobal('getComputedStyle', () => ({
      transform: surface.style.maxHeight
        ? surface.style.transform
        : 'matrix(1, 0, 0, 1, 0, 399.9)',
    }));

    session.start();
    flushFrame();
    slideTo(0);
    flushFrame();

    expect(anchor.getBoundingClientRect().bottom).toBeLessThanOrEqual(150);
  });

  it('shrinks the scrollable sheet enough to keep a normal tall row whole', () => {
    const { anchor, session, surface } = build({
      rowTop: 400,
      rowHeight: 150,
      pressY: 475,
      sheetTop: 100,
      sheetHeight: 500,
    });

    session.start();
    flushFrame();
    flushFrame();

    expect(surface.style.maxHeight).toBe('442px');
    expect(anchor.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(anchor.getBoundingClientRect().bottom + 8).toBeLessThanOrEqual(
      surface.getBoundingClientRect().top,
    );

    session.release();
    expect(surface.style.maxHeight).toBe('');
  });

  it('keeps the pressed slice visible when the whole message cannot fit', () => {
    const { anchor, session, surface } = build({
      rowTop: 100,
      rowHeight: 560,
      pressY: 600,
      sheetTop: 100,
      sheetHeight: 500,
    });

    session.start();
    flushFrame();
    flushFrame();

    const anchorBox = anchor.getBoundingClientRect();
    const preservedPressY = anchorBox.top + 500;
    expect(surface.style.maxHeight).toBe('88px');
    expect(preservedPressY + 8).toBeLessThanOrEqual(
      surface.getBoundingClientRect().top,
    );
    expect(anchorBox.bottom).toBeGreaterThan(
      surface.getBoundingClientRect().top,
    );
  });

  it('keeps half the screen for a sheet when the root text is scaled', () => {
    const { session, surface } = build({
      rowTop: 100,
      rowHeight: 560,
      pressY: 600,
      sheetTop: 100,
      sheetHeight: 500,
    });

    surface.style.fontSize = '40px';
    session.start();
    flushFrame();
    flushFrame();

    expect(surface.style.maxHeight).toBe(`${window.innerHeight / 2}px`);
  });

  it('cancels safely when the exact anchor has disconnected', () => {
    const { anchor, scroller, session, scrollTop } = build({
      rowTop: 500,
      rowHeight: 50,
      pressY: 525,
      sheetTop: 100,
      sheetHeight: 500,
    });

    session.start();
    anchor.remove();
    flushFrame();

    expect(scrollTop()).toBe(100);
    expect(scroller.querySelector('[data-message-sheet-clearance]')).toBeNull();

    session.release();
    expect(scroller.style.overflowY).toBe('');
  });
});
