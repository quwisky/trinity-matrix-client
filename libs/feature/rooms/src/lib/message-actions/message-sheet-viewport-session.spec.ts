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
  });
});
