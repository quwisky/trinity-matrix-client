import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { sanitizeMatrixHtml } from '@trinity/util/matrix';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SenderColoursDirective } from './sender-colours.directive';

interface Palette {
  readonly surface: string;
  readonly canvas?: string;
  readonly text: string;
  readonly link: string;
  readonly rail: string;
}

// The default theme's panes, body text, links and table-header rail (variables.scss light
// :243/:317/:318/:406, dark :489/:491/:500/:515).
const LIGHT: Palette = {
  surface: 'oklch(99% 0.004 85deg)',
  text: 'oklch(32% 0.012 60deg)',
  link: 'oklch(47% 0.19 275deg)',
  rail: 'oklch(96.5% 0.006 85deg)',
};
const DARK: Palette = {
  surface: 'oklch(20% 0.005 269deg)',
  text: 'oklch(90% 0.004 269deg)',
  link: 'oklch(76% 0.105 275deg)',
  rail: 'oklch(16% 0.004 269deg)',
};
// Amethyst dark (variables.scss :752-782): the timeline pane is lighter than the canvas.
const AMETHYST_DARK: Palette = {
  surface: 'oklch(22% 0.022 300deg)',
  canvas: 'oklch(16% 0.018 300deg)',
  text: 'oklch(90% 0.018 300deg)',
  link: 'oklch(77% 0.1 300deg)',
  rail: 'oklch(18% 0.018 300deg)',
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
  let palette: Palette = LIGHT;
  let reads = 0;

  beforeEach(() => {
    palette = LIGHT;
    reads = 0;
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
    // jsdom computes no theme: answer for the body element only.
    const original = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(
      (element, pseudo) => {
        if (!(element as Element).classList?.contains('body')) {
          return original(element, pseudo);
        }
        reads += 1;
        const properties: Readonly<Record<string, string | undefined>> = {
          '--trinity-message-surface': palette.surface,
          '--trinity-surface-canvas': palette.canvas,
          '--trinity-link': palette.link,
          '--trinity-rail': palette.rail,
        };
        return {
          color: palette.text,
          getPropertyValue: (name: string) => properties[name] ?? '',
        } as unknown as CSSStyleDeclaration;
      },
    );
    // Angular's sanitizer warns that it stripped the data-mx-* attributes.
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.documentElement.classList.remove('dark');
    document.documentElement.removeAttribute('data-theme');
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

    expect(
      host.querySelector<HTMLElement>('code .mx-fg-e03030')!.style.color,
    ).toBe('');
    // A pill's text is the member's name, so no sender markup is left inside it to colour.
    expect(host.querySelector('a.mention')!.children).toHaveLength(0);
  });

  it('never paints a sender colour on maths or inside it', () => {
    const { host } = render(
      '<span data-mx-maths="x" data-mx-color="#e03030" data-mx-bg-color="#ffeb3b">x</span>' +
        '<font color="#e03030"><span data-mx-maths="y"><font color="#e03030">y</font></span></font>',
    );
    const [own, wrapped] = host.querySelectorAll<HTMLElement>('.mx-maths');

    // Owner decision 13: maths keeps the body text colour. The stylesheet resets `.mx-maths`
    // to it, so the colour the outer `font` keeps outside the maths is not inherited.
    expect(own.style.color).toBe('');
    expect(own.style.backgroundColor).toBe('');
    expect(wrapped.style.color).toBe('');
    expect(wrapped.querySelector<HTMLElement>('font')!.style.color).toBe('');
    expectColour(
      host.querySelector<HTMLElement>(':scope > font')!.style.color,
      '#e03030',
    );
  });

  it('keeps a background around maths only when the body text stays readable on it', () => {
    const { element } = render(
      '<span data-mx-color="#ffffff" data-mx-bg-color="#1a237e">' +
        '<span data-mx-maths="x">x</span></span>',
    );
    const span = element('.mx-bg-1a237e');

    // The light theme's dark text is unreadable on navy: the background goes, and white text
    // alone cannot be read on the light pane either.
    expect(span.style.backgroundColor).toBe('');
    expect(span.style.color).toBe('');
  });

  it('keeps that background where the body text reads on it', () => {
    palette = DARK;
    const { element } = render(
      '<span data-mx-color="#ffffff" data-mx-bg-color="#1a237e">' +
        '<span data-mx-maths="x">x</span></span>',
    );
    const span = element('.mx-bg-1a237e');

    expectColour(span.style.backgroundColor, '#1a237e');
    expectColour(span.style.color, '#ffffff');
  });

  it('never colours the spoiler element itself', () => {
    const { element } = render(
      '<span data-mx-spoiler data-mx-color="#e03030">hidden</span>',
    );

    // An inline colour would beat the concealed bar's `color: transparent`.
    expect(element('.mx-spoiler').style.color).toBe('');
  });

  it('applies nothing when the surface cannot be read', () => {
    palette = { ...LIGHT, surface: '' };
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
  it('checks timeline text against the pane it sits on, not the darker canvas', () => {
    palette = AMETHYST_DARK;
    const { element } = render('<span data-mx-color="#606060">grey</span>');

    // 3.1:1 on Amethyst's canvas, but 2.8:1 on the pane the timeline draws.
    expect(element('.mx-fg-606060').style.color).toBe('');
  });

  it('falls back to the canvas when no message surface is set', () => {
    palette = { ...AMETHYST_DARK, surface: '' };
    const { element } = render('<span data-mx-color="#606060">grey</span>');

    expectColour(element('.mx-fg-606060').style.color, '#606060');
  });

  it('re-checks a mounted body when only the Theme changes', async () => {
    document.documentElement.classList.add('dark');
    palette = DARK;
    const { fixture, element } = render(
      '<span data-mx-color="#646464">grey</span>',
    );
    expectColour(element('.mx-fg-646464').style.color, '#646464');

    palette = AMETHYST_DARK;
    document.documentElement.setAttribute('data-theme', 'amethyst');

    await vi.waitFor(
      () => {
        fixture.detectChanges();
        expect(element('.mx-fg-646464').style.color).toBe('');
      },
      { timeout: 1_000 },
    );
  });

  it('keeps a background around a link only when the link stays readable on it', () => {
    const pair =
      '<span data-mx-color="#ffffff" data-mx-bg-color="#1a237e">' +
      '<a href="https://example.org/x">x</a></span>';
    const { element } = render(pair);
    const span = element('.mx-bg-1a237e');

    // The light theme's blue link is unreadable on navy: the background goes, and white text
    // alone cannot be read on the light pane either.
    expect(span.style.backgroundColor).toBe('');
    expect(span.style.color).toBe('');
  });

  it('keeps that background where the theme’s link reads on it', () => {
    palette = DARK;
    const { element } = render(
      '<span data-mx-color="#ffffff" data-mx-bg-color="#1a237e">' +
        '<a href="https://example.org/x">x</a></span>',
    );
    const span = element('.mx-bg-1a237e');

    expectColour(span.style.backgroundColor, '#1a237e');
    expectColour(span.style.color, '#ffffff');
  });

  it('checks a background inside a link against the link colour', () => {
    const { host } = render(
      '<a href="https://example.org/x"><span data-mx-bg-color="#909090">in</span></a>' +
        '<span data-mx-bg-color="#909090">out</span>',
    );

    // Body text reads on #909090 (3.6:1); the light theme's link does not (2.1:1).
    expect(
      host.querySelector<HTMLElement>('a .mx-bg-909090')!.style.backgroundColor,
    ).toBe('');
    expectColour(
      host.querySelector<HTMLElement>(':scope > .mx-bg-909090')!.style
        .backgroundColor,
      '#909090',
    );
  });

  it('checks text in a table header against the header’s rail', () => {
    const { host } = render(
      '<table><thead><tr><th><span data-mx-color="#8f8f8f">h</span></th></tr></thead></table>' +
        '<span data-mx-color="#8f8f8f">p</span>',
    );

    // 3.2:1 on the light pane, 2.9:1 on the slightly darker header rail.
    expect(
      host.querySelector<HTMLElement>('th .mx-fg-8f8f8f')!.style.color,
    ).toBe('');
    expectColour(
      host.querySelector<HTMLElement>(':scope > .mx-fg-8f8f8f')!.style.color,
      '#8f8f8f',
    );
  });

  it('drops a text colour that a table header inside would show on its rail', () => {
    const { host } = render(
      '<font color="#8f8f8f"><table><tbody><tr><th>h</th></tr></tbody></table></font>' +
        '<font color="#8f8f8f">p</font>',
    );
    const [holder, plain] = host.querySelectorAll<HTMLElement>('.mx-fg-8f8f8f');

    // The header inherits the colour: 3.2:1 on the pane, but 2.9:1 on the rail.
    expect(holder.querySelector('th')).not.toBeNull();
    expect(holder.style.color).toBe('');
    expectColour(plain.style.color, '#8f8f8f');
  });

  it('checks a background against a link nested deep inside it', () => {
    const { element } = render(
      '<span data-mx-color="#ffffff" data-mx-bg-color="#1a237e">' +
        '<em><strong><a href="https://example.org/x">x</a></strong></em></span>',
    );
    const span = element('.mx-bg-1a237e');

    expect(span.style.backgroundColor).toBe('');
    expect(span.style.color).toBe('');
  });

  it('checks a background inside a link against the link, not a coloured ancestor', () => {
    const { element } = render(
      '<span data-mx-color="#000000"><a href="https://example.org/x">' +
        '<span data-mx-bg-color="#909090">x</span></a></span>',
    );

    expectColour(element('.mx-fg-000000').style.color, '#000000');
    // Black would read on #909090 (6.9:1), but the link's blue shows there (2.1:1).
    expect(element('.mx-bg-909090').style.backgroundColor).toBe('');
  });

  describe('a surface only the browser can resolve', () => {
    function stubCanvas(pixel: readonly number[]): void {
      const context = {
        fillStyle: '',
        fillRect: () => undefined,
        getImageData: () => ({ data: Uint8ClampedArray.from(pixel) }),
      };
      vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(
        context as unknown as CanvasRenderingContext2D,
      );
    }

    it('measures against the colour the browser resolved', () => {
      stubCanvas([253, 252, 249, 255]);
      palette = { ...LIGHT, surface: 'color(srgb 0.99 0.99 0.98)' };
      const { element } = render('<span data-mx-color="#e03030">red</span>');

      expectColour(element('.mx-fg-e03030').style.color, '#e03030');
    });

    it('applies nothing when the browser resolves it to something see-through', () => {
      stubCanvas([0, 0, 0, 0]);
      palette = { ...LIGHT, surface: 'color(srgb 0 0 0 / 0)' };
      const { element } = render('<span data-mx-color="#e03030">red</span>');

      expect(element('.mx-fg-e03030').style.color).toBe('');
    });

    it('does not take a transparent surface for black', () => {
      // Chromium's computed `transparent`; #e03030 would pass 3:1 against black.
      stubCanvas([0, 0, 0, 0]);
      palette = { ...LIGHT, surface: 'rgba(0, 0, 0, 0)' };
      const { element } = render('<span data-mx-color="#e03030">red</span>');

      expect(element('.mx-fg-e03030').style.color).toBe('');
    });
  });
});
