import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { sanitizeMatrixHtml } from '@trinity/util/matrix';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SenderColoursDirective } from './sender-colours.directive';

// The default theme's canvases and body text (variables.scss :321/:406 light, :494/:500 dark).
const LIGHT = {
  surface: 'oklch(99% 0.004 85deg)',
  text: 'oklch(32% 0.012 60deg)',
};
const DARK = {
  surface: 'oklch(20% 0.005 269deg)',
  text: 'oklch(90% 0.004 269deg)',
};

@Component({
  imports: [SenderColoursDirective],
  template: `<div
    class="body"
    [innerHTML]="html()"
    [trnSenderColours]="html()"
  ></div>`,
})
class HostComponent {
  readonly html = signal('');
}

/** jsdom normalizes a CSSOM colour to `rgb(...)`; accept either spelling. */
function expectColour(actual: string, hex: string): void {
  const [r, g, b] = [1, 3, 5].map((i) =>
    Number.parseInt(hex.slice(i, i + 2), 16),
  );
  expect([hex, `rgb(${r}, ${g}, ${b})`]).toContain(actual);
}

describe('SenderColoursDirective', () => {
  let palette = LIGHT;
  let reads = 0;

  beforeEach(() => {
    palette = LIGHT;
    reads = 0;
    document.documentElement.classList.remove('dark');
    // jsdom computes no theme: answer for the body element only.
    const original = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element, pseudo) => {
        if (!(element as Element).classList?.contains('body')) {
          return original(element, pseudo);
        }
        reads += 1;
        return {
          color: palette.text,
          getPropertyValue: (name: string) =>
            name === '--trinity-message-surface' ? palette.surface : '',
        } as unknown as CSSStyleDeclaration;
      },
    );
    // Angular's sanitizer warns that it stripped the data-mx-* attributes.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.classList.remove('dark');
  });

  function render(formatted: string) {
    const fixture = TestBed.createComponent(HostComponent);
    fixture.componentInstance.html.set(sanitizeMatrixHtml(formatted));
    fixture.detectChanges();
    const host = fixture.nativeElement.querySelector('.body') as HTMLElement;
    const element = (selector: string) =>
      host.querySelector<HTMLElement>(selector)!;
    return { fixture, host, element };
  }

  it('applies a colour that stays readable', () => {
    const { element } = render('<span data-mx-color="#e03030">red</span>');

    expectColour(element('.mx-fg-e03030').style.color, '#e03030');
  });

  it('drops a colour that cannot be read on this theme’s surface', () => {
    palette = DARK;
    const { element } = render('<span data-mx-color="#202020">dark</span>');

    expect(element('.mx-fg-202020').style.color).toBe('');
  });

  it('puts a deprecated font colour through the same guard', () => {
    palette = DARK;
    const { element } = render(
      '<font color="#202020">old</font><font color="#e03030">red</font>',
    );

    // Owner decision 9: `font color` is read again, but painted only past 3:1.
    expect(element('.mx-fg-202020').style.color).toBe('');
    expectColour(element('.mx-fg-e03030').style.color, '#e03030');
  });

  it('re-checks a mounted body when the theme changes', async () => {
    const { fixture, element } = render(
      '<span data-mx-color="#202020">dark</span>',
    );
    expectColour(element('.mx-fg-202020').style.color, '#202020');

    palette = DARK;
    document.documentElement.classList.add('dark');

    await vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(element('.mx-fg-202020').style.color).toBe('');
      },
      { timeout: 1_000 },
    );
  });

  it('checks a background alone against the theme’s text colour', () => {
    const { element } = render('<span data-mx-bg-color="#ffeb3b">hi</span>');
    expectColour(element('.mx-bg-ffeb3b').style.backgroundColor, '#ffeb3b');
  });

  it('drops a background the theme’s text cannot be read on', () => {
    palette = DARK;
    const { element } = render('<span data-mx-bg-color="#ffeb3b">hi</span>');
    expect(element('.mx-bg-ffeb3b').style.backgroundColor).toBe('');
  });

  it('checks text against the nearest kept sender background, not the surface', () => {
    palette = DARK;
    const { element } = render(
      '<span data-mx-color="#000000" data-mx-bg-color="#ffeb3b">pair <span data-mx-color="#202020">inner</span></span>',
    );

    expectColour(element('.mx-bg-ffeb3b').style.backgroundColor, '#ffeb3b');
    // #202020 fails on the dark surface (1.1:1) but reads on the kept yellow.
    expectColour(element('.mx-fg-202020').style.color, '#202020');
  });

  it('leaves code and mention pills in their own colours', () => {
    const { host } = render(
      '<code><span data-mx-color="#e03030">c</span></code>' +
        '<a href="https://matrix.to/#/@a:hs"><span data-mx-color="#e03030">A</span></a>',
    );
    const spans = host.querySelectorAll<HTMLElement>('.mx-fg-e03030');

    expect(spans).toHaveLength(2);
    for (const span of spans) {
      expect(span.style.color).toBe('');
    }
  });

  it('never colours the spoiler element itself', () => {
    const { element } = render(
      '<span data-mx-spoiler data-mx-color="#e03030">hidden</span>',
    );

    // An inline colour would beat the concealed bar's `color: transparent`.
    expect(element('.mx-spoiler').style.color).toBe('');
  });

  it('applies nothing when the surface cannot be read', () => {
    palette = { surface: '', text: LIGHT.text };
    const { element } = render('<span data-mx-color="#e03030">red</span>');

    expect(element('.mx-fg-e03030').style.color).toBe('');
  });

  it('reads computed style once for a body of 500 coloured spans', () => {
    const { host } = render(
      Array.from(
        { length: 500 },
        () => '<span data-mx-color="#e03030">r</span>',
      ).join(''),
    );

    expect(reads).toBe(1);
    expect(
      [...host.querySelectorAll<HTMLElement>('.mx-fg-e03030')].every(
        (span) => span.style.color !== '',
      ),
    ).toBe(true);
  });
});
