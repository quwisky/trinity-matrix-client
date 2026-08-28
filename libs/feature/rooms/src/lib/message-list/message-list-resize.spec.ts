import { type Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { render } from '@trinity/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimpleMessageListComponent } from './simple-message-list/simple-message-list.component';
import { VirtualMessageListComponent } from './virtual-message-list/virtual-message-list.component';
import type { MessageView } from '@trinity/util/matrix';
import type { MessageListBase } from './message-list-base';

/** The minimum a list needs to render a row and know its id. */
function msg(id: string): MessageView {
  return {
    id,
    senderId: '@a:hs',
    senderName: 'Alice',
    senderInitial: 'A',
    senderAvatarMxc: null,
    body: `body ${id}`,
    html: null,
    timestamp: 1000,
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

/**
 * A jump has to survive the scroller changing WIDTH.
 *
 * `jumpTo` ends in a measurement — `scrollIntoView`, or a computed `scrollTop` — and that
 * answer is only correct for the layout at that instant. Change the width and every row
 * re-wraps to a new height, so the position the jump chose now belongs to a different
 * message: the reader is left near, or nowhere near, with only the flash to say anything
 * happened.
 *
 * It is not hypothetical. A right-hand panel shares the row with the timeline, so opening or
 * closing one resizes it, and dragging the pane divider resizes it continuously. This was
 * measured before it was fixed: with the panels in flow, `pin-messages.spec.mts`
 * "re-jumping to the SAME pinned message" failed — the row flashed off screen — and passed
 * again once the re-apply existed. That spec is the real proof, in a real browser with real
 * layout; these are the fast tests that say WHY it passes.
 *
 * jsdom does no layout and has no `ResizeObserver`, so both are stubbed: the observer is
 * captured and fired by hand, and `clientWidth` is whatever the test says it is. That is
 * enough to pin the decision being tested — which is *when* the list re-aims, not what the
 * browser computes.
 */
const LISTS: readonly (readonly [string, Type<MessageListBase>])[] = [
  ['simple', SimpleMessageListComponent],
  ['virtual (the default)', VirtualMessageListComponent],
];

describe.each(LISTS)('message list — jump across a resize (%s)', (_l, List) => {
  /**
   * Every observer callback either list creates, fired together.
   *
   * Not just the width watcher's: the windowed list also observes its rows and its container
   * through the same stubbed constructor, and there is no way to tell those apart by target
   * — the container observer watches the very same `.scroll` element. Firing all of them with
   * an empty entry list is both simpler and closer to what a browser does, since a real
   * resize notifies every observer watching the affected box.
   */
  let observers: ((entries: ResizeObserverEntry[]) => void)[] = [];
  const fireResize = () => {
    for (const cb of observers) {
      cb([]);
    }
  };

  beforeEach(() => {
    vi.useFakeTimers();
    observers = [];
    // jsdom implements neither of these, and both lists' `jumpTo` ends in one of them.
    Element.prototype.scrollIntoView = vi.fn();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(
          private readonly cb: (entries: ResizeObserverEntry[]) => void,
        ) {
          observers.push(this.cb);
        }
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function create() {
    const result = await render(List, {
      inputs: { messages: [msg('$a:hs'), msg('$b:hs')] },
    });
    TestBed.tick();
    return result;
  }

  /** Pretend the scroller is now `width` px wide. */
  function setWidth(container: HTMLElement, width: number): void {
    const scroll = container.querySelector('.scroll') as HTMLElement | null;
    if (scroll) {
      Object.defineProperty(scroll, 'clientWidth', {
        value: width,
        configurable: true,
      });
    }
  }

  function setScrollGeometry(
    container: HTMLElement,
    geometry: {
      readonly clientHeight: number;
      readonly scrollHeight: number;
      readonly scrollTop: number;
    },
  ): HTMLElement {
    const scroll = container.querySelector('.scroll') as HTMLElement;
    Object.defineProperties(scroll, {
      clientHeight: { value: geometry.clientHeight, configurable: true },
      scrollHeight: { value: geometry.scrollHeight, configurable: true },
      scrollTop: {
        value: geometry.scrollTop,
        configurable: true,
        writable: true,
      },
    });
    return scroll;
  }

  it('re-aims a recent jump when the scroller changes width', async () => {
    const { container, fixture } = await create();
    const list = fixture.componentInstance as MessageListBase;
    const jumpTo = vi.spyOn(list, 'jumpTo');

    list.jumpTo('$b:hs');
    jumpTo.mockClear();

    setWidth(container, 640);
    fireResize();

    // The same row, re-aimed against the layout that now exists.
    expect(jumpTo).toHaveBeenCalledWith('$b:hs');
  });

  it('does nothing when the width has not actually changed', async () => {
    // A `ResizeObserver` fires for height too — the keyboard opening, the composer growing.
    // Re-jumping there would fight the reader rather than help them.
    const { container, fixture } = await create();
    const list = fixture.componentInstance as MessageListBase;

    list.jumpTo('$b:hs');
    const jumpTo = vi.spyOn(list, 'jumpTo');

    setWidth(
      container,
      (container.querySelector('.scroll') as HTMLElement)?.clientWidth ?? 0,
    );
    fireResize();

    expect(jumpTo).not.toHaveBeenCalled();
  });

  it('forgets a jump that is no longer recent', async () => {
    // Bounded so resizing the window minutes later does not yank someone back to a message
    // they have long scrolled past.
    const { container, fixture } = await create();
    const list = fixture.componentInstance as MessageListBase;

    list.jumpTo('$b:hs');
    const jumpTo = vi.spyOn(list, 'jumpTo');

    vi.advanceTimersByTime(5_000);
    setWidth(container, 640);
    fireResize();

    expect(jumpTo).not.toHaveBeenCalled();
  });

  it('stays pinned to the newest message when the viewport height changes', async () => {
    const { container } = await create();
    const scroll = setScrollGeometry(container, {
      clientHeight: 500,
      scrollHeight: 1_000,
      scrollTop: 500,
    });
    fireResize();
    vi.advanceTimersByTime(20);

    Object.defineProperty(scroll, 'clientHeight', {
      value: 400,
      configurable: true,
    });
    fireResize();
    vi.advanceTimersByTime(20);

    expect(scroll.scrollTop).toBe(scroll.scrollHeight);
  });

  it('preserves a scrolled-up reading anchor when the viewport height changes', async () => {
    const { container, fixture } = await create();
    const scroll = setScrollGeometry(container, {
      clientHeight: 500,
      scrollHeight: 1_000,
      scrollTop: 500,
    });
    fireResize();
    vi.advanceTimersByTime(20);

    scroll.scrollTop = 100;
    (
      fixture.componentInstance as MessageListBase & { onScroll(): void }
    ).onScroll();
    Object.defineProperty(scroll, 'clientHeight', {
      value: 400,
      configurable: true,
    });
    fireResize();
    vi.advanceTimersByTime(20);

    expect(scroll.scrollTop).toBe(100);
  });
});
