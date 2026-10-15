import { Component, Injectable, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { sanitizeMatrixHtml } from '@trinity/util/matrix';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SpoilerRevealDirective } from '../spoiler/spoiler-reveal.directive';
import { MathsLoader, type MathsRenderer } from './maths-loader';
import {
  MAX_MATHS_PER_MESSAGE,
  MathsDirective,
  WIDE_MATHS,
} from './maths.directive';

@Component({
  imports: [MathsDirective],
  template: `<div class="body" [innerHTML]="html()" [trnMaths]="html()"></div>`,
})
class HostComponent {
  readonly html = signal('');
}

/** The body as messages compose it: spoilers reveal on the same element. */
@Component({
  imports: [MathsDirective, SpoilerRevealDirective],
  template: `<div
    class="body"
    [innerHTML]="html()"
    trnSpoilerReveal
    [trnMaths]="html()"
  ></div>`,
})
class SpoilerHostComponent {
  readonly html = signal('');
}

/** A chunk that fails to load once (offline), then loads. */
@Injectable()
class FlakyMathsLoader extends MathsLoader {
  attempts = 0;

  protected override importRenderer(): Promise<MathsRenderer> {
    this.attempts += 1;
    return this.attempts === 1
      ? Promise.reject(new Error('offline'))
      : super.importRenderer();
  }
}

/** Angular's dev-mode notice that its sanitizer dropped `data-mx-maths`; it holds no content. */
const ANGULAR_STRIPPED = 'sanitizing HTML stripped some content';

/** Markup a sender might hope KaTeX or the fallback turns into an element. */
const INJECTION = '<img src=x onerror=alert(1)>';

const stylesheet = (): HTMLLinkElement | null =>
  document.head.querySelector('link[data-trinity-katex]');

/** jsdom never fetches stylesheets: answer for the KaTeX `<link>` as the browser would. */
function settleStylesheet(event: 'load' | 'error'): void {
  const link = stylesheet();
  expect(link).not.toBeNull();
  link?.dispatchEvent(new Event(event));
}

/** Let settled promises (the chunk import, the loader's bookkeeping) run. */
const flush = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve));

describe('MathsDirective', () => {
  let console$: unknown[][];

  beforeEach(() => {
    console$ = [];
    // Nothing may reach the console (it feeds the diagnostic log) but Angular's notice.
    for (const method of ['log', 'info', 'debug', 'warn', 'error'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        if (method === 'warn' && String(args[0]).includes(ANGULAR_STRIPPED)) {
          return;
        }
        console$.push(args);
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    // Each test's injector has its own loader, so each adds its own `<link>`.
    for (const link of document.head.querySelectorAll(
      'link[data-trinity-katex]',
    )) {
      link.remove();
    }
    expect(console$).toEqual([]);
  });

  function render(formatted: string) {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.html.set(sanitizeMatrixHtml(formatted));
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('.body') as HTMLElement;
    const edit = (next: string) => {
      fixture.componentInstance.html.set(sanitizeMatrixHtml(next));
      fixture.detectChanges();
    };
    return { fixture, host, edit };
  }

  /** Load the stylesheet, then re-run change detection until `count` matches. */
  async function waitForCount(
    fixture: ComponentFixture<HostComponent>,
    host: HTMLElement,
    selector: string,
    count: number,
  ): Promise<void> {
    stylesheet()?.dispatchEvent(new Event('load'));
    await vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(host.querySelectorAll(selector)).toHaveLength(count);
      },
      { timeout: 5_000 },
    );
  }

  const annotations = (host: HTMLElement): (string | null)[] =>
    [...host.querySelectorAll('annotation')].map((note) => note.textContent);

  it('renders inline and display maths from the sanitized string once KaTeX loads', async () => {
    const { fixture, host } = render(
      '<span data-mx-maths="x^2">x^2</span> and <div data-mx-maths="\\frac{1}{2}">1/2</div>',
    );

    await waitForCount(fixture, host, '.katex', 2);

    expect(host.querySelector('div.mx-maths .katex-display')).not.toBeNull();
    expect(annotations(host)).toEqual(['x^2', '\\frac{1}{2}']);
  });

  /** The test setup's ResizeObserver stub watching `element` (see test-setup.ts). */
  interface StubObserver {
    readonly observed: Set<Element>;
    emit(entries: ResizeObserverEntry[]): void;
  }
  const observerOf = (element: Element): StubObserver | undefined =>
    (
      globalThis.ResizeObserver as unknown as { instances: StubObserver[] }
    ).instances.find((observer) => observer.observed.has(element));

  it('marks inline maths wider than the body, and unmarks it once the body is wide enough', async () => {
    const { fixture, host } = render(
      '<span data-mx-maths="x+y">x+y</span> and <span data-mx-maths="z">z</span>' +
        '<div data-mx-maths="w">w</div>',
    );
    await waitForCount(fixture, host, '.katex', 3);
    const [wide, narrow] = host.querySelectorAll<HTMLElement>('span.mx-maths');
    let width = 200;
    Object.defineProperty(host, 'clientWidth', {
      configurable: true,
      get: () => width,
    });
    const runsOf = (maths: Element, offsetWidth: number) => {
      for (const run of maths.querySelectorAll('.katex-base')) {
        Object.defineProperty(run, 'offsetWidth', {
          configurable: true,
          value: offsetWidth,
        });
      }
    };
    runsOf(wide, 300);
    runsOf(narrow, 20);
    runsOf(host.querySelector('div.mx-maths')!, 300);
    const observer = observerOf(host);
    expect(observer).toBeDefined();

    observer!.emit([]);
    expect(wide.classList.contains(WIDE_MATHS)).toBe(true);
    expect(narrow.classList.contains(WIDE_MATHS)).toBe(false);
    // Display maths scrolls already; only inline maths is marked.
    expect(host.querySelector(`div.${WIDE_MATHS}`)).toBeNull();

    width = 400;
    observer!.emit([]);
    expect(wide.classList.contains(WIDE_MATHS)).toBe(false);

    fixture.destroy();
    expect(observer!.observed.size).toBe(0);
  });

  it('re-checks inline maths when fonts finish loading, until the body goes', async () => {
    // jsdom has no FontFaceSet: stand one in, as an event target with a settled `ready`.
    const fonts = Object.assign(new EventTarget(), {
      ready: Promise.resolve(),
    });
    Object.defineProperty(document, 'fonts', {
      configurable: true,
      value: fonts,
    });
    const removed = vi.spyOn(fonts, 'removeEventListener');
    try {
      const { fixture, host } = render('<span data-mx-maths="x+y">x+y</span>');
      await waitForCount(fixture, host, '.katex', 1);
      const maths = host.querySelector<HTMLElement>('span.mx-maths')!;
      Object.defineProperty(host, 'clientWidth', {
        configurable: true,
        value: 200,
      });
      expect(maths.classList.contains(WIDE_MATHS)).toBe(false);

      // KaTeX's fonts arrive and the formula widens; nothing about the body changed size.
      for (const run of maths.querySelectorAll('.katex-base')) {
        Object.defineProperty(run, 'offsetWidth', {
          configurable: true,
          value: 300,
        });
      }
      fonts.dispatchEvent(new Event('loadingdone'));
      expect(maths.classList.contains(WIDE_MATHS)).toBe(true);

      fixture.destroy();
      expect(removed).toHaveBeenCalledWith('loadingdone', expect.any(Function));
    } finally {
      Reflect.deleteProperty(document, 'fonts');
    }
  });

  it('adds the KaTeX stylesheet once', async () => {
    const { fixture, host } = render(
      '<span data-mx-maths="a">a</span><span data-mx-maths="b">b</span>',
    );

    await waitForCount(fixture, host, '.katex', 2);

    const links = document.head.querySelectorAll('link[data-trinity-katex]');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('katex.css');
  });

  it('shows the sender’s fallback until both the chunk and the stylesheet have loaded', async () => {
    const { fixture, host } = render(
      '<span data-mx-maths="x^2"><code>x^2</code></span>',
    );
    expect(host.querySelector('.mx-maths code')?.textContent).toBe('x^2');

    // The chunk is in; the stylesheet is not.
    await import('./maths-render');
    await flush();
    fixture.detectChanges();

    expect(host.querySelector('.katex')).toBeNull();
    expect(host.querySelector('.mx-maths code')?.textContent).toBe('x^2');

    await waitForCount(fixture, host, '.katex', 1);
  });

  it('removes a stylesheet that fails, keeps the fallback and retries on the next render', async () => {
    const { fixture, host, edit } = render(
      '<span data-mx-maths="x^2">x squared</span>',
    );

    settleStylesheet('error');
    await flush();
    fixture.detectChanges();

    expect(stylesheet()).toBeNull();
    expect(host.querySelector('.katex')).toBeNull();
    expect(host.textContent).toBe('x squared');

    edit('<span data-mx-maths="y^3">y cubed</span>');
    await waitForCount(fixture, host, '.katex', 1);

    expect(annotations(host)).toEqual(['y^3']);
    expect(
      document.head.querySelectorAll('link[data-trinity-katex]'),
    ).toHaveLength(1);
  });

  it('keeps the fallback when the chunk fails to load and retries on the next render', async () => {
    TestBed.configureTestingModule({
      providers: [{ provide: MathsLoader, useClass: FlakyMathsLoader }],
    });
    const { fixture, host, edit } = render(
      '<span data-mx-maths="x^2">x squared</span>',
    );

    settleStylesheet('load');
    await flush();
    fixture.detectChanges();

    expect(host.querySelector('.katex')).toBeNull();
    expect(host.textContent).toBe('x squared');

    edit('<span data-mx-maths="y^3">y cubed</span>');
    await waitForCount(fixture, host, '.katex', 1);

    expect(annotations(host)).toEqual(['y^3']);
    expect((TestBed.inject(MathsLoader) as FlakyMathsLoader).attempts).toBe(2);
    // The stylesheet that loaded is kept, not fetched again.
    expect(
      document.head.querySelectorAll('link[data-trinity-katex]'),
    ).toHaveLength(1);
  });

  it('renders an edited message’s new formula with nothing stale or doubled', async () => {
    const { fixture, host, edit } = render(
      '<span data-mx-maths="x^2">x^2</span>',
    );
    await waitForCount(fixture, host, '.katex', 1);

    edit('<span data-mx-maths="y^3">y^3</span>');

    await vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(annotations(host)).toEqual(['y^3']);
      },
      { timeout: 5_000 },
    );
    expect(host.querySelectorAll('.katex')).toHaveLength(1);
    expect(host.querySelectorAll('.mx-maths')).toHaveLength(1);
  });

  it('shows the source of an expression KaTeX rejects or one past 2,000 characters', async () => {
    const { fixture, host } = render(
      `<span data-mx-maths="\\frac{1}{">bad</span><span data-mx-maths="${'x'.repeat(2_001)}">long</span>`,
    );

    await waitForCount(fixture, host, 'code.mx-maths-source', 2);

    expect(host.querySelector('code.mx-maths-source')?.textContent).toBe(
      '\\frac{1}{',
    );
  });

  it('shows markup in an expression past 2,000 characters as text', async () => {
    const latex = INJECTION + 'x'.repeat(2_001 - INJECTION.length);
    const attribute = latex
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
    const { fixture, host } = render(
      `<span data-mx-maths="${attribute}">long</span>`,
    );

    await waitForCount(fixture, host, 'code.mx-maths-source', 1);

    expect(host.querySelector('code.mx-maths-source')?.textContent).toBe(latex);
    expect(host.querySelector('img')).toBeNull();
  });

  it('renders at most 50 expressions in one message and shows the rest as source', async () => {
    const body = Array.from(
      { length: 52 },
      (_, i) => `<span data-mx-maths="x_{${i}}">x${i}</span>`,
    ).join(' ');
    const { fixture, host } = render(body);

    await waitForCount(fixture, host, '.katex', MAX_MATHS_PER_MESSAGE);

    expect(MAX_MATHS_PER_MESSAGE).toBe(50);
    expect(host.querySelectorAll('code.mx-maths-source')).toHaveLength(2);
  });

  it('shows markup in an expression past the per-message cap as text', async () => {
    const body = Array.from(
      { length: MAX_MATHS_PER_MESSAGE },
      (_, i) => `<span data-mx-maths="x_{${i}}">x${i}</span>`,
    ).join(' ');
    const { fixture, host } = render(
      `${body}<span data-mx-maths="&lt;img src=x onerror=alert(1)&gt;">over</span>`,
    );

    await waitForCount(fixture, host, 'code.mx-maths-source', 1);

    expect(host.querySelector('code.mx-maths-source')?.textContent).toBe(
      INJECTION,
    );
    expect(host.querySelector('img')).toBeNull();
  });

  it('pairs nested maths with the right source', async () => {
    const { fixture, host } = render(
      '<span data-mx-maths="a"><span data-mx-maths="b">b</span></span><span data-mx-maths="c">c</span>',
    );

    await waitForCount(fixture, host, '.katex', 2);

    expect(annotations(host)).toEqual(['a', 'c']);
  });

  describe('inside a concealed spoiler', () => {
    function renderWithSpoilers(formatted: string) {
      const fixture = TestBed.createComponent(SpoilerHostComponent);
      fixture.componentInstance.html.set(sanitizeMatrixHtml(formatted));
      fixture.detectChanges();
      const host = fixture.nativeElement.querySelector('.body') as HTMLElement;
      return { fixture, host };
    }

    it('loads no KaTeX while all of a body’s maths is concealed, and loads it on reveal', async () => {
      const { fixture, host } = renderWithSpoilers(
        '<span data-mx-spoiler>answer <span data-mx-maths="x^2">x squared</span></span>',
      );
      await flush();
      expect(stylesheet()).toBeNull();

      host.querySelector<HTMLElement>('.mx-spoiler')!.click();
      fixture.detectChanges();

      await waitForCount(fixture, host, '.katex', 1);
    });

    it('loads KaTeX for maths outside a spoiler even when other maths is concealed', async () => {
      const { fixture, host } = renderWithSpoilers(
        '<span data-mx-maths="a">a</span> <span data-mx-spoiler><span data-mx-maths="b">b</span></span>',
      );

      // Both render once loaded: drawing a concealed formula costs nothing more.
      await waitForCount(fixture, host, '.katex', 2);
    });
  });

  it('neither parses nor loads anything for a body without maths', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const body = '<p>no maths</p>';
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.html.set(body);

    fixture.detectChanges();

    expect(parse).not.toHaveBeenCalledWith(body, 'text/html');
    expect(stylesheet()).toBeNull();
  });
});
