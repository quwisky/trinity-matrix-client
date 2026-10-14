import { Component, signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { sanitizeMatrixHtml } from '@trinity/util/matrix';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_MATHS_PER_MESSAGE, MathsDirective } from './maths.directive';

@Component({
  imports: [MathsDirective],
  template: `<div class="body" [innerHTML]="html()" [trnMaths]="html()"></div>`,
})
class HostComponent {
  readonly html = signal('');
}

describe('MathsDirective', () => {
  beforeEach(() => {
    // Angular's sanitizer warns that it stripped data-mx-maths.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => vi.restoreAllMocks());

  function render(formatted: string) {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.html.set(sanitizeMatrixHtml(formatted));
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('.body') as HTMLElement;
    return { fixture, host };
  }

  /** Wait for the lazy chunk, re-running change detection until `count` matches. */
  async function waitForCount(
    fixture: ComponentFixture<HostComponent>,
    host: HTMLElement,
    selector: string,
    count: number,
  ): Promise<void> {
    await vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(host.querySelectorAll(selector)).toHaveLength(count);
      },
      { timeout: 5_000 },
    );
  }

  it('renders inline and display maths from the sanitized string once KaTeX loads', async () => {
    const { fixture, host } = render(
      '<span data-mx-maths="x^2">x^2</span> and <div data-mx-maths="\\frac{1}{2}">1/2</div>',
    );

    await waitForCount(fixture, host, '.katex', 2);

    expect(host.querySelector('div.mx-maths .katex-display')).not.toBeNull();
    expect(
      [...host.querySelectorAll('annotation')].map((note) => note.textContent),
    ).toEqual(['x^2', '\\frac{1}{2}']);
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

  it('shows the source of an expression KaTeX rejects or one past 2,000 characters', async () => {
    const { fixture, host } = render(
      `<span data-mx-maths="\\frac{1}{">bad</span><span data-mx-maths="${'x'.repeat(2_001)}">long</span>`,
    );

    await waitForCount(fixture, host, 'code.mx-maths-source', 2);

    expect(host.querySelector('code.mx-maths-source')?.textContent).toBe(
      '\\frac{1}{',
    );
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

  it('pairs nested maths with the right source', async () => {
    const { fixture, host } = render(
      '<span data-mx-maths="a"><span data-mx-maths="b">b</span></span><span data-mx-maths="c">c</span>',
    );

    await waitForCount(fixture, host, '.katex', 2);

    expect(
      [...host.querySelectorAll('annotation')].map((note) => note.textContent),
    ).toEqual(['a', 'c']);
  });

  it('does not parse a body without maths', () => {
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    const body = '<p>no maths</p>';
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.html.set(body);

    fixture.detectChanges();

    expect(parse).not.toHaveBeenCalledWith(body, 'text/html');
  });
});
