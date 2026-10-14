import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  BODY_LIMIT_LINES,
  BodyMeasureDirective,
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
 * Report `element` at `height` through `observer`, as a layout would: in the entry's border box,
 * which every supported browser fills in. Reading the element's own layout throws, so a test
 * fails if the measurement goes back to reading it.
 */
function report(
  observer: TestResizeObserver,
  element: HTMLElement,
  height: number,
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
      borderBoxSize: [{ blockSize: height, inlineSize: 600 }],
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

    expect(overflow.overflowing('$a')()).toBe(false);
  });

  it('reports a body taller than 24 lines', () => {
    const element = body();
    overflow.observe(element, '$a');

    report(observerOf(element), element, 25 * LINE_PX);

    expect(overflow.overflowing('$a')()).toBe(true);
  });

  it('follows a body that grows later, as images and maths load', () => {
    const element = body();
    overflow.observe(element, '$a');
    const observer = observerOf(element);

    report(observer, element, 10 * LINE_PX);
    expect(overflow.overflowing('$a')()).toBe(false);

    report(observer, element, 40 * LINE_PX);
    expect(overflow.overflowing('$a')()).toBe(true);
  });

  it('re-measures a replaced body element for the same row', () => {
    const tracked = overflow.overflowing('$a');
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

    expect(overflow.overflowing('$a')()).toBe(false);
  });

  it('measures from the content height where an entry carries no border box', () => {
    const element = body();
    overflow.observe(element, '$a');
    Object.defineProperty(element, 'scrollHeight', {
      configurable: true,
      value: 25 * LINE_PX,
    });

    observerOf(element).emit([
      { target: element } as unknown as ResizeObserverEntry,
    ]);

    expect(overflow.overflowing('$a')()).toBe(true);
  });

  it('forgets a row no longer shown when cleared', () => {
    const element = body();
    overflow.observe(element, '$a');
    report(observerOf(element), element, 40 * LINE_PX);
    const tracked = overflow.overflowing('$a');
    overflow.unobserve(element);

    overflow.clear();

    expect(tracked()).toBe(false);
  });

  it('keeps a row still shown long when cleared, without asking again', () => {
    const element = body();
    overflow.observe(element, '$a');
    const observer = observerOf(element) as TestResizeObserver & ResizeObserver;
    report(observer, element, 40 * LINE_PX);
    const tracked = overflow.overflowing('$a');
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
    expect(overflow.overflowing('$a')()).toBe(true);

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
    expect(overflow.overflowing('$a')()).toBe(false);

    // The reserved box gives way to the loaded image, and the body grows past the limit.
    image.classList.remove('mx-image--loading');
    image.dispatchEvent(new Event('load'));
    report(observerOf(element), element, 10 * LINE_PX + 300);

    expect(overflow.overflowing('$a')()).toBe(true);
  });

  it('turns long when maths renders in place of its source', () => {
    const { element, overflow } = richBody();
    report(observerOf(element), element, 23 * LINE_PX);
    expect(overflow.overflowing('$a')()).toBe(false);

    const rendered = document.createElement('span');
    rendered.className = 'katex-display';
    element.querySelector('.mx-maths-source')?.replaceWith(rendered);
    report(observerOf(element), element, 23 * LINE_PX + 120);

    expect(overflow.overflowing('$a')()).toBe(true);
  });

  it('turns short again when the body shrinks within the limit', () => {
    const { element, overflow } = richBody();
    report(observerOf(element), element, 40 * LINE_PX);
    expect(overflow.overflowing('$a')()).toBe(true);

    // The image failed and fell back to its alt text, so the body is short again.
    element.querySelector('img')?.replaceWith('A chart');
    report(observerOf(element), element, 20 * LINE_PX);

    expect(overflow.overflowing('$a')()).toBe(false);
  });

  it('measures nothing where no list provides an observer', () => {
    const fixture = TestBed.createComponent(UnmeasuredHostComponent);

    fixture.detectChanges();

    expect(observers()).toHaveLength(0);
  });
});
