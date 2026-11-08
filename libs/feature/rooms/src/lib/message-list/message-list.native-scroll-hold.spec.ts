import { TestBed } from '@angular/core/testing';
import { MockComponent } from 'ng-mocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ConversationRuntime,
  type MessageView,
} from '@trinity/data-access/timeline';
import { MessageComposerComponent } from '../message-composer/message-composer.component';
import {
  ConversationComposeStub,
  ConversationMessagesStub,
} from '../testing/conversation-timeline.stub';
import { messageView } from '../testing/message-view.fixture';
import { setScrollGeometry } from '../testing/scroll-geometry.stub';
import { MessageListComponent } from './message-list.component';
import { provideRoomMessageListCommands } from './message-list-commands';
import { compileMessageListBeforeTests } from '../testing/test-bed';

const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
const IDLE_MS = 150;
const ROW = 64;
const PAGE = 5 * 40;

const rect = (top: number, bottom = top): DOMRect =>
  ({ top, bottom }) as unknown as DOMRect;
const msg = (id: string, ts: number): MessageView =>
  messageView({
    id,
    senderId: '@a:hs',
    senderName: 'A',
    senderInitial: 'A',
    body: `body ${id}`,
    timestamp: ts,
  });
const many = (n: number) =>
  Array.from({ length: n }, (_, i) => msg(`$${i}`, 1000 + i * 10_000));
const page = () =>
  ['$p0', '$p1', '$p2', '$p3', '$p4'].map((id, i) => msg(id, 1 + i));

/**
 * What jsdom can show of a correction made while iOS's native scroll view owns the position: that
 * it is held rather than written, and written once the gesture ends. That a write made then really
 * is overwritten, and that the hold really keeps the row still, only WebKit can show: Simulator
 * measurements in the pull request, and `timeline-older-touch.spec.mts` for the layout in Chromium.
 */
describe('message list on iOS: older history under a finger', () => {
  compileMessageListBeforeTests();

  beforeEach(() => {
    const compose = new ConversationComposeStub();
    TestBed.overrideProvider(ConversationRuntime, {
      useValue: { compose, messages: new ConversationMessagesStub(compose) },
    });
    TestBed.configureTestingModule({
      providers: [provideRoomMessageListCommands()],
    });
    (ResizeObserver as unknown as { instances: unknown[] }).instances.length =
      0;
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  const ownScrollIntoView = Element.prototype.scrollIntoView;

  afterEach(() => {
    Element.prototype.scrollIntoView = ownScrollIntoView;
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function list(userAgent = IPHONE) {
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
    TestBed.overrideComponent(MessageListComponent, {
      remove: { imports: [MessageComposerComponent] },
      add: { imports: [MockComponent(MessageComposerComponent)] },
    });
    const fixture = TestBed.createComponent(MessageListComponent);
    fixture.componentRef.setInput('canLoadOlder', true);
    fixture.componentRef.setInput('messages', many(30));
    // `settled` needs a load state; without one the list treats the room as ready.
    fixture.detectChanges();
    TestBed.tick();
    const scroll = (fixture.nativeElement as HTMLElement).querySelector(
      '.scroll',
    ) as HTMLElement;
    const view = { st: 100, prepended: 0, writes: [] as number[] };
    setScrollGeometry(scroll, {
      scrollTop: {
        get: () => view.st,
        set: (value: number) => {
          view.writes.push(value);
          view.st = value;
        },
      },
      clientHeight: 600,
      scrollHeight: () => 30 * ROW + view.prepended + held(scroll),
    });
    scroll.getBoundingClientRect = () => rect(0);
    (scroll.querySelector('.vpad') as HTMLElement).getBoundingClientRect = () =>
      rect(-view.st);
    for (const id of ['$0', '$1', '$2', '$3', '$4']) {
      (
        scroll.querySelector(`[data-mid="${id}"]`) as HTMLElement
      ).getBoundingClientRect = () => rect(-100, -50);
    }
    // The row under the reader: where it is on screen follows the scroll position and the page
    // above it, less whatever the margin holds back.
    const anchorTop = () =>
      40 + view.prepended + held(scroll) - (view.st - 100);
    (
      scroll.querySelector('[data-mid="$5"]') as HTMLElement
    ).getBoundingClientRect = () => rect(anchorTop(), anchorTop() + ROW);
    const emitted = vi.fn();
    fixture.componentInstance.loadOlder.subscribe(emitted);
    return {
      fixture,
      cmp: fixture.componentInstance,
      scroll,
      view,
      emitted,
      anchorTop,
    };
  }

  /** The margin in force, as the negative pixels the stylesheet is handed. */
  const held = (scroll: HTMLElement) =>
    Number.parseFloat(scroll.style.getPropertyValue('--scroll-hold') || '0');

  const touch = (target: Element, type: string, count: number) => {
    const event = new Event(type, { bubbles: true });
    Object.defineProperty(event, 'touches', { value: { length: count } });
    target.dispatchEvent(event);
  };

  /** Fire the shared row observer: these rows have just measured at this height. */
  function measureRows(scroll: HTMLElement, ids: string[], height: number) {
    const observer = (
      ResizeObserver as unknown as {
        instances: {
          observed: Set<Element>;
          emit(entries: ResizeObserverEntry[]): void;
        }[];
      }
    ).instances.find((o) => [...o.observed].some((el) => el.matches?.('.msg')));
    observer?.emit(
      ids.map((id) => {
        const target = scroll.querySelector(`[data-mid="${id}"]`) as Element;
        return {
          target,
          contentRect: { height },
          borderBoxSize: [{ blockSize: height }],
        } as unknown as ResizeObserverEntry;
      }),
    );
  }

  function landPage(ctx: ReturnType<typeof list>) {
    ctx.fixture.componentRef.setInput('loadingOlder', false);
    ctx.view.prepended = PAGE;
    ctx.fixture.componentRef.setInput('messages', [...page(), ...many(30)]);
    ctx.fixture.detectChanges();
    TestBed.tick();
  }

  function askForPage(ctx: ReturnType<typeof list>) {
    ctx.cmp.onScroll();
    expect(ctx.emitted).toHaveBeenCalledTimes(1);
    ctx.fixture.componentRef.setInput('loadingOlder', true);
    ctx.fixture.detectChanges();
    TestBed.tick();
  }

  it('holds the correction while a finger is down, leaving the row and the position alone', () => {
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    const before = ctx.anchorTop();

    landPage(ctx);

    expect(ctx.view.writes.filter((top) => top !== 100)).toEqual([]);
    expect(ctx.view.st).toBe(100);
    expect(ctx.anchorTop()).toBe(before);
  });

  it('asks for one page per approach while the page is held', () => {
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    landPage(ctx);

    // The reader is still in the load zone as the content goes on moving under the finger.
    ctx.view.st = 90;
    ctx.cmp.onScroll();

    expect(ctx.emitted).toHaveBeenCalledTimes(1);
  });

  it('writes the correction once the finger has lifted and nothing has moved', () => {
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    const before = ctx.anchorTop();
    landPage(ctx);

    touch(row, 'touchend', 0);
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(ctx.view.st).toBe(100);

    vi.advanceTimersByTime(1);

    expect(ctx.view.st).toBe(100 + PAGE);
    expect(held(ctx.scroll)).toBe(0);
    expect(ctx.anchorTop()).toBe(before);
  });

  it('holds on through momentum, which sends no touch events, until the scroll goes quiet', () => {
    const ctx = list();
    askForPage(ctx); // the scroll event that asked also marks the list as scrolling
    const before = ctx.anchorTop();
    landPage(ctx);
    expect(ctx.view.st).toBe(100);

    vi.advanceTimersByTime(IDLE_MS / 2);
    ctx.view.st = 95; // still decelerating
    ctx.cmp.onScroll();
    vi.advanceTimersByTime(IDLE_MS - 1);
    expect(ctx.view.st).toBe(95);

    vi.advanceTimersByTime(1);

    expect(ctx.view.st).toBe(95 + PAGE);
    expect(ctx.anchorTop()).toBe(before + 5);
  });

  it("holds nothing more for the page's first measurements while the reader moves", () => {
    // Rows that drew at their real height: measuring them moves nothing on screen, however far
    // their heights are from the estimate, so the only change is the finger's.
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    landPage(ctx);
    expect(held(ctx.scroll)).toBe(-PAGE);

    ctx.view.st = 95;
    ctx.cmp.onScroll();
    measureRows(ctx.scroll, ['$p0', '$p1', '$p2', '$p3', '$p4'], 40);

    expect(held(ctx.scroll)).toBe(-PAGE);
    expect(ctx.view.st).toBe(95);
  });

  it('counts a move once when the page lands before its scroll event', () => {
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    // The landing effect reads the rows before they render, so the page counts only once it has.
    Object.defineProperty(ctx.view, 'prepended', {
      get: () => (ctx.scroll.querySelector('[data-mid="$p0"]') ? PAGE : 0),
      set: () => undefined,
    });

    ctx.view.st = 52; // the list has moved; its scroll event is still to come
    const before = ctx.anchorTop();
    landPage(ctx);
    ctx.cmp.onScroll();
    measureRows(ctx.scroll, ['$p0', '$p1', '$p2', '$p3', '$p4'], 40);

    expect(ctx.anchorTop()).toBe(before);
    expect(held(ctx.scroll)).toBe(-PAGE);
  });

  it('follows a row that grows above the anchor in the frame it grows', () => {
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    landPage(ctx);
    ctx.view.st = 95;
    ctx.cmp.onScroll();
    const frames = vi.fn();
    vi.stubGlobal('requestAnimationFrame', frames);

    ctx.view.prepended += 167; // an image above the reader decodes at its real height
    measureRows(ctx.scroll, ['$p0'], 207);

    expect(held(ctx.scroll)).toBe(-(PAGE + 167));
    expect(ctx.view.st).toBe(95);
  });

  it('holds until a touch that outlasts the idle window ends', () => {
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    landPage(ctx);

    vi.advanceTimersByTime(60_000);

    expect(ctx.view.st).toBe(100);
    expect(held(ctx.scroll)).toBe(-PAGE);
  });

  it('hears a touch end when windowing has removed the row it began on', () => {
    // A touch's events go to the element it began on; detached, they no longer reach the scroller.
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    landPage(ctx);

    row.remove();
    touch(row, 'touchend', 0);
    vi.advanceTimersByTime(IDLE_MS);

    expect(ctx.view.st).toBe(100 + PAGE);
  });

  it('holds again if the scroll view undoes the write under a finger it never reported', () => {
    const ctx = list();
    askForPage(ctx);
    landPage(ctx);
    vi.advanceTimersByTime(IDLE_MS);
    expect(ctx.view.st).toBe(100 + PAGE);

    ctx.cmp.onScroll(); // the write's own event
    ctx.view.st = 100; // a few frames later the scroll view puts its old position back
    ctx.cmp.onScroll();
    TestBed.tick();

    expect(held(ctx.scroll)).toBe(-PAGE);
    vi.advanceTimersByTime(60_000);
    expect(ctx.view.st).toBe(100);
  });

  it('settles a positive margin from the position before the content shrinks', () => {
    // Rows above the reader came out shorter, so the margin pushes down. Taking it off shortens
    // the content, and a reader near the bottom is clamped before the shift is added.
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    let clamps = false; // only once the scroller holds its real height, past the set-up's jumps
    setScrollGeometry(ctx.scroll, {
      scrollTop: {
        get: () => {
          if (clamps) {
            const end = ctx.scroll.scrollHeight - ctx.scroll.clientHeight;
            ctx.view.st = Math.min(ctx.view.st, end);
          }
          return ctx.view.st;
        },
        set: (value: number) => (ctx.view.st = value),
      },
    });
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    landPage(ctx);

    ctx.view.st = 1120; // 200 px off the bottom
    ctx.cmp.onScroll();
    ctx.view.prepended -= 440;
    measureRows(ctx.scroll, ['$p0'], 40);
    expect(held(ctx.scroll)).toBe(240);
    const before = ctx.anchorTop();
    clamps = true;

    touch(row, 'touchend', 0);
    vi.advanceTimersByTime(IDLE_MS);

    expect(held(ctx.scroll)).toBe(0);
    expect(ctx.view.st).toBe(880);
    expect(ctx.anchorTop()).toBe(before);
  });

  it('gives up the hold for a jump to a message, and does not read the jump as an undo', () => {
    const scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    landPage(ctx);
    expect(held(ctx.scroll)).toBe(-PAGE);

    ctx.cmp.jumpTo('$5');

    expect(held(ctx.scroll)).toBe(0);
    expect(ctx.view.st).toBe(100 + PAGE);
    expect(scrollIntoView).toHaveBeenCalled();

    // A target near the top of history puts the list back about where the hold began.
    ctx.view.st = 100;
    ctx.cmp.onScroll();
    TestBed.tick();

    expect(held(ctx.scroll)).toBe(0);
  });

  it('drops the hold when the list moves to another room', () => {
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    landPage(ctx);
    expect(held(ctx.scroll)).toBe(-PAGE);

    ctx.fixture.componentRef.setInput('roomId', '!other:hs');
    ctx.fixture.detectChanges();
    TestBed.tick();

    expect(held(ctx.scroll)).toBe(0);
    expect(ctx.view.st).toBe(100);
  });

  it('settles when the system cancels the touch', () => {
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    landPage(ctx);

    touch(row, 'touchcancel', 0);
    vi.advanceTimersByTime(IDLE_MS);

    expect(ctx.view.st).toBe(100 + PAGE);
    expect(held(ctx.scroll)).toBe(0);
  });

  it('arms no timer for a touch that ends after the list has gone', () => {
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    ctx.fixture.destroy();
    vi.clearAllTimers();

    touch(row, 'touchend', 0);

    expect(vi.getTimerCount()).toBe(0);
  });

  it('corrects from a bounce above the top without counting the bounce as a correction', () => {
    // WebKit reports the rubber band as a negative scrollTop. The hold can express that position,
    // so clamping the target to 0 would pull the rows up by the bounce.
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    landPage(ctx);
    expect(held(ctx.scroll)).toBe(-PAGE);

    ctx.view.st = -84;
    ctx.cmp.onScroll();
    measureRows(ctx.scroll, ['$p0'], 40);

    expect(held(ctx.scroll)).toBe(-PAGE);
  });

  it('gives up the hold for a jump to the latest message', () => {
    const ctx = list();
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);
    landPage(ctx);

    ctx.cmp.scrollToLatest();

    expect(held(ctx.scroll)).toBe(0);
    expect(ctx.view.writes.at(-1)).toBe(30 * ROW + PAGE);
  });

  it('writes straight away off iOS, finger or not', () => {
    const ctx = list('Mozilla/5.0 (Linux; Android 14) Chrome/124 Mobile');
    const row = ctx.scroll.querySelector('[data-mid="$5"]') as Element;
    touch(row, 'touchstart', 1);
    askForPage(ctx);

    landPage(ctx);

    expect(ctx.view.st).toBe(100 + PAGE);
    expect(held(ctx.scroll)).toBe(0);
  });
});
