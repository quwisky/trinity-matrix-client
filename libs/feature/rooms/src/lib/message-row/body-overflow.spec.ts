import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BODY_LIMIT_LINES,
  BodyMeasureDirective,
  REMEMBERED_LONG_ROWS,
  BodyOverflowObserver,
} from './body-overflow';

/** The controllable ResizeObserver from src/test-setup.ts. */
interface TestResizeObserver {
  readonly observed: Set<Element>;
  emit(entries: ResizeObserverEntry[]): void;
}

const observers = (): TestResizeObserver[] =>
  (ResizeObserver as unknown as { instances: TestResizeObserver[] }).instances;

function observerOf(element: Element): TestResizeObserver {
  const found = observers().find((observer) => observer.observed.has(element));
  if (!found) throw new Error('element is not observed');
  return found;
}

/**
 * Report `element` with content `height` through `observer`, as a layout would: in the entry's
 * content box, which every supported browser fills in, with a border box `padding` taller.
 * Reading the element's own layout throws, so a test fails if the measurement goes back to it.
 */
function report(
  observer: TestResizeObserver,
  element: HTMLElement,
  height: number,
  padding = 0,
): void {
  Object.defineProperty(element, 'scrollHeight', {
    configurable: true,
    get: () => {
      throw new Error('scrollHeight read while the entry carries the size');
    },
  });
  observer.emit([
    {
      target: element,
      contentBoxSize: [{ blockSize: height, inlineSize: 600 }],
      contentRect: { height } as DOMRectReadOnly,
      borderBoxSize: [{ blockSize: height + padding, inlineSize: 600 }],
    } as unknown as ResizeObserverEntry,
  ]);
}

const LINE_PX = 20;

beforeEach(() => {
  observers().length = 0;
  const original = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) =>
    (element as Element).classList?.contains('body')
      ? ({
          lineHeight: `${LINE_PX}px`,
          fontSize: '16px',
        } as CSSStyleDeclaration)
      : original(element, pseudo),
  );
});

afterEach(() => vi.restoreAllMocks());

function body(): HTMLElement {
  const element = document.createElement('div');
  element.className = 'body';
  return element;
}

/** How many rows the observer keeps a live measurement for. */
const tracked = (overflow: BodyOverflowObserver): number =>
  overflow['entries'].size;

/** How many rows the observer remembers as long. */
const remembered = (overflow: BodyOverflowObserver): number =>
  overflow['longIds'].size;

/** Row `id`'s measurement, read as a row reads it: while holding it. */
function longOf(overflow: BodyOverflowObserver, id: string): boolean {
  const { long, release } = overflow.hold(id);
  const value = long();
  release();
  return value;
}

describe('BodyOverflowObserver', () => {
  let overflow: BodyOverflowObserver;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [BodyOverflowObserver] });
    overflow = TestBed.inject(BodyOverflowObserver);
  });

  it('shows a body of up to 24 lines whole', () => {
    const element = body();
    overflow.observe(element, '$a');

    report(observerOf(element), element, BODY_LIMIT_LINES * LINE_PX);

    expect(longOf(overflow, '$a')).toBe(false);
  });

  it('reports a body taller than 24 lines', () => {
    const element = body();
    overflow.observe(element, '$a');

    report(observerOf(element), element, 25 * LINE_PX);

    expect(longOf(overflow, '$a')).toBe(true);
  });

  it('follows a body that grows later, as images and maths load', () => {
    const element = body();
    overflow.observe(element, '$a');
    const observer = observerOf(element);

    report(observer, element, 10 * LINE_PX);
    expect(longOf(overflow, '$a')).toBe(false);

    report(observer, element, 40 * LINE_PX);
    expect(longOf(overflow, '$a')).toBe(true);
  });

  it('re-measures a replaced body element for the same row', () => {
    const tracked = overflow.hold('$a').long;
    const plain = body();
    overflow.observe(plain, '$a');
    report(observerOf(plain), plain, 30 * LINE_PX);
    expect(tracked()).toBe(true);

    // An edit swaps the plain body for a formatted one: a new element, the same row.
    overflow.unobserve(plain);
    const formatted = body();
    overflow.observe(formatted, '$a');
    report(observerOf(formatted), formatted, 10 * LINE_PX);

    expect(tracked()).toBe(false);
  });

  it('ignores an element it no longer observes', () => {
    const element = body();
    overflow.observe(element, '$a');
    const observer = observerOf(element);
    overflow.unobserve(element);

    report(observer, element, 40 * LINE_PX);

    expect(longOf(overflow, '$a')).toBe(false);
  });

  // A formatted body pads itself by the focus-ring reach (so an overflow clip keeps rings
  // whole); that padding is not a line of the message.
  it('counts the content, not the focus-ring padding, against the 24 lines', () => {
    const element = body();
    overflow.observe(element, '$a');

    report(observerOf(element), element, 24 * LINE_PX, 8);

    expect(longOf(overflow, '$a')).toBe(false);
  });

  it('measures from the content height where an entry carries no box sizes', () => {
    const element = body();
    overflow.observe(element, '$a');
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      value: 25 * LINE_PX,
    });

    observerOf(element).emit([
      { target: element } as unknown as ResizeObserverEntry,
    ]);

    expect(longOf(overflow, '$a')).toBe(true);
  });

  it('leaves the block padding out where an entry carries no box sizes', () => {
    const element = body();
    overflow.observe(element, '$a');
    const original = window.getComputedStyle;
    vi.mocked(window.getComputedStyle).mockImplementation((target, pseudo) =>
      target === element
        ? ({
            lineHeight: `${LINE_PX}px`,
            fontSize: '16px',
            paddingTop: '4px',
            paddingBottom: '4px',
          } as CSSStyleDeclaration)
        : original(target, pseudo),
    );
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      value: 24 * LINE_PX + 8,
    });

    observerOf(element).emit([
      { target: element } as unknown as ResizeObserverEntry,
    ]);

    expect(longOf(overflow, '$a')).toBe(false);
  });

  it('forgets a row no longer shown when cleared', () => {
    const tracked = overflow.hold('$a').long;
    const element = body();
    overflow.observe(element, '$a');
    report(observerOf(element), element, 40 * LINE_PX);
    overflow.unobserve(element);

    overflow.clear();

    expect(tracked()).toBe(false);
  });

  it('keeps a row still shown long when cleared, without asking again', () => {
    const tracked = overflow.hold('$a').long;
    const element = body();
    overflow.observe(element, '$a');
    const observer = observerOf(element) as TestResizeObserver & ResizeObserver;
    report(observer, element, 40 * LINE_PX);
    const observe = vi.spyOn(observer, 'observe');
    const unobserve = vi.spyOn(observer, 'unobserve');

    overflow.clear();

    // Row ids are event ids, unique across rooms: the measurement is still this row's, and
    // resetting it would show the long body uncollapsed for a frame.
    expect(tracked()).toBe(true);
    expect(observe).not.toHaveBeenCalled();
    expect(unobserve).not.toHaveBeenCalled();

    // The observer goes on updating it.
    report(observer, element, 10 * LINE_PX);
    expect(tracked()).toBe(false);
  });

  // A measurement comes only with a hold, so no reader can create an entry nothing lets go of.
  it('hands a row its measurement with its hold, and forgets it once let go', () => {
    const row = overflow.hold('$a');
    const element = body();
    overflow.observe(element, '$a');
    report(observerOf(element), element, 30 * LINE_PX);
    expect(row.long()).toBe(true);

    overflow.unobserve(element);
    row.release();

    expect(tracked(overflow)).toBe(0);
  });

  it('counts a hold let go once, however often it is released', () => {
    const first = overflow.hold('$a');
    const second = overflow.hold('$a');

    first.release();
    first.release();
    expect(tracked(overflow)).toBe(1);

    second.release();
    expect(tracked(overflow)).toBe(0);
  });

  it('drops the entry of a row once its body is gone and its row no longer reads it', () => {
    const elements = ['$a', '$b', '$c'].map((id) => {
      const element = body();
      const { release } = overflow.hold(id);
      overflow.observe(element, id);
      return { element, release };
    });
    expect(tracked(overflow)).toBe(3);

    for (const { element, release } of elements.slice(0, 2)) {
      overflow.unobserve(element);
      release();
    }

    expect(tracked(overflow)).toBe(1);
  });

  it('keeps the entry a row reads while its body is replaced', () => {
    const tracked = overflow.hold('$a').long;
    const plain = body();
    overflow.observe(plain, '$a');

    overflow.unobserve(plain);
    const formatted = body();
    overflow.observe(formatted, '$a');
    report(observerOf(formatted), formatted, 30 * LINE_PX);

    expect(tracked()).toBe(true);
  });

  it('starts a long row that comes back collapsed, before it is measured again', () => {
    const first = body();
    const held = overflow.hold('$a');
    overflow.observe(first, '$a');
    report(observerOf(first), first, 40 * LINE_PX);
    overflow.unobserve(first);
    held.release();
    expect(tracked(overflow)).toBe(0);

    // The virtual timeline brings the row back: a new row, a new body element.
    const again = overflow.hold('$a');
    expect(again.long()).toBe(true);
    again.release();
  });

  it('starts a short row that comes back whole', () => {
    const first = body();
    const held = overflow.hold('$a');
    overflow.observe(first, '$a');
    report(observerOf(first), first, 40 * LINE_PX);
    report(observerOf(first), first, 10 * LINE_PX);
    overflow.unobserve(first);
    held.release();

    const again = overflow.hold('$a');
    expect(again.long()).toBe(false);
    again.release();
  });

  it('remembers only rows it measured long, and only so many of them', () => {
    const ids = Array.from(
      { length: REMEMBERED_LONG_ROWS + 50 },
      (_, i) => `$${i}`,
    );
    for (const id of ids) {
      const element = body();
      const { release } = overflow.hold(id);
      overflow.observe(element, id);
      report(observerOf(element), element, 40 * LINE_PX);
      overflow.unobserve(element);
      release();
    }
    const short = body();
    const { release } = overflow.hold('$short');
    overflow.observe(short, '$short');
    report(observerOf(short), short, 10 * LINE_PX);
    overflow.unobserve(short);
    release();

    expect(tracked(overflow)).toBe(0);
    expect(remembered(overflow)).toBe(REMEMBERED_LONG_ROWS);
    // The oldest go first.
    expect(longOf(overflow, ids[0])).toBe(false);
    expect(longOf(overflow, ids[ids.length - 1])).toBe(true);
  });

  it('forgets the rows of the room it left, keeping the rows still shown', () => {
    const shown = body();
    overflow.hold('$shown');
    overflow.observe(shown, '$shown');
    report(observerOf(shown), shown, 40 * LINE_PX);
    for (const id of ['$a', '$b']) {
      const element = body();
      const { release } = overflow.hold(id);
      overflow.observe(element, id);
      report(observerOf(element), element, 40 * LINE_PX);
      overflow.unobserve(element);
      release();
    }
    overflow.clear();

    expect(tracked(overflow)).toBe(1);
    expect(remembered(overflow)).toBe(1);
    expect(longOf(overflow, '$shown')).toBe(true);
    expect(longOf(overflow, '$a')).toBe(false);
  });

  it('lets go of every body when the list goes', () => {
    const element = body();
    overflow.observe(element, '$a');
    const observer = observerOf(element);

    overflow.ngOnDestroy();

    expect(observer.observed.size).toBe(0);
  });

  it('uses one ResizeObserver however many bodies it watches', () => {
    for (const id of ['$a', '$b', '$c']) overflow.observe(body(), id);

    expect(observers()).toHaveLength(1);
  });
});

describe('BodyMeasureDirective', () => {
  @Component({
    imports: [BodyMeasureDirective],
    providers: [BodyOverflowObserver],
    template: `@if (shown()) {
      <p class="body" [trnBodyMeasure]="id()">text</p>
    }`,
  })
  class MeasuredHostComponent {
    readonly id = signal('$a');
    readonly shown = signal(true);
  }

  @Component({
    imports: [BodyMeasureDirective],
    template: `<p class="body" trnBodyMeasure="$a">text</p>`,
  })
  class UnmeasuredHostComponent {}

  /** A formatted body as PR 3 and PR 4 render it: an inline image box and a maths source. */
  @Component({
    imports: [BodyMeasureDirective],
    providers: [BodyOverflowObserver],
    template: `<div class="body" trnBodyMeasure="$a">
      <p>text</p>
      <img class="mx-image mx-image--loading" alt="A chart" />
      <code class="mx-maths-source">x^2</code>
    </div>`,
  })
  class RichBodyHostComponent {}

  function richBody(): {
    element: HTMLElement;
    overflow: BodyOverflowObserver;
  } {
    const fixture = TestBed.createComponent(RichBodyHostComponent);
    fixture.detectChanges();
    return {
      element: fixture.nativeElement.querySelector('.body') as HTMLElement,
      overflow: fixture.debugElement.injector.get(BodyOverflowObserver),
    };
  }

  it('observes its body for its row and lets go when the body goes', () => {
    const fixture = TestBed.createComponent(MeasuredHostComponent);
    fixture.detectChanges();
    const element = fixture.nativeElement.querySelector('.body') as HTMLElement;
    const overflow = fixture.debugElement.injector.get(BodyOverflowObserver);

    report(observerOf(element), element, 30 * LINE_PX);
    expect(longOf(overflow, '$a')).toBe(true);

    fixture.componentInstance.shown.set(false);
    fixture.detectChanges();

    expect(observers().some((observer) => observer.observed.has(element))).toBe(
      false,
    );
  });

  it('turns long when an inline image inside the body finishes loading', () => {
    const { element, overflow } = richBody();
    const image = element.querySelector('img') as HTMLImageElement;
    // The body is the one observed element; its image is not watched on its own.
    expect(observers().some((observer) => observer.observed.has(image))).toBe(
      false,
    );
    report(observerOf(element), element, 10 * LINE_PX);
    expect(longOf(overflow, '$a')).toBe(false);

    // The reserved box gives way to the loaded image, and the body grows past the limit.
    image.classList.remove('mx-image--loading');
    image.dispatchEvent(new Event('load'));
    report(observerOf(element), element, 10 * LINE_PX + 300);

    expect(longOf(overflow, '$a')).toBe(true);
  });

  it('turns long when maths renders in place of its source', () => {
    const { element, overflow } = richBody();
    report(observerOf(element), element, 23 * LINE_PX);
    expect(longOf(overflow, '$a')).toBe(false);

    const rendered = document.createElement('span');
    rendered.className = 'katex-display';
    element.querySelector('.mx-maths-source')?.replaceWith(rendered);
    report(observerOf(element), element, 23 * LINE_PX + 120);

    expect(longOf(overflow, '$a')).toBe(true);
  });

  it('turns short again when the body shrinks within the limit', () => {
    const { element, overflow } = richBody();
    report(observerOf(element), element, 40 * LINE_PX);
    expect(longOf(overflow, '$a')).toBe(true);

    // The image failed and fell back to its alt text, so the body is short again.
    element.querySelector('img')?.replaceWith('A chart');
    report(observerOf(element), element, 20 * LINE_PX);

    expect(longOf(overflow, '$a')).toBe(false);
  });

  it('drops the entries of bodies the list no longer renders', () => {
    @Component({
      imports: [BodyMeasureDirective],
      providers: [BodyOverflowObserver],
      template: `@for (id of ids(); track id) {
        <p class="body" [trnBodyMeasure]="id">text</p>
      }`,
    })
    class WindowHostComponent {
      readonly ids = signal(['$a', '$b', '$c', '$d']);
    }
    const fixture = TestBed.createComponent(WindowHostComponent);
    fixture.detectChanges();
    const overflow = fixture.debugElement.injector.get(BodyOverflowObserver);
    expect(tracked(overflow)).toBe(4);

    fixture.componentInstance.ids.set(['$c', '$d', '$e']);
    fixture.detectChanges();

    expect(tracked(overflow)).toBe(3);
  });

  it('measures nothing where no list provides an observer', () => {
    const fixture = TestBed.createComponent(UnmeasuredHostComponent);

    fixture.detectChanges();

    expect(observers()).toHaveLength(0);
  });
});
